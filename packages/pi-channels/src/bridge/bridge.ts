/**
 * pi-channels — Chat bridge.
 *
 * Listens for incoming messages (channel:receive), serializes per sender,
 * routes prompts into the live pi gateway runtime, and sends responses
 * back via the same adapter. Each sender gets their own FIFO queue.
 * Multiple senders run concurrently up to maxConcurrent.
 */

import { readFileSync } from "node:fs";
import type { ImageContent } from "@mariozechner/pi-ai";
import { type EventBus, getActiveGatewayRuntime } from "@mariozechner/pi-coding-agent";
import type { ChannelRegistry } from "../registry.js";
import type { BridgeConfig, IncomingMessage, QueuedPrompt, SenderSession } from "../types.js";
import { type CommandContext, handleCommand, isCommand } from "./commands.js";
import { startTyping } from "./typing.js";

const BRIDGE_DEFAULTS: Required<BridgeConfig> = {
	enabled: false,
	sessionMode: "persistent",
	sessionRules: [],
	idleTimeoutMinutes: 30,
	maxQueuePerSender: 5,
	timeoutMs: 300_000,
	maxConcurrent: 2,
	model: null,
	typingIndicators: true,
	commands: true,
	extensions: [],
};

type LogFn = (event: string, data: unknown, level?: string) => void;

let idCounter = 0;
function nextId(): string {
	return `msg-${Date.now()}-${++idCounter}`;
}

export class ChatBridge {
	private config: Required<BridgeConfig>;
	private registry: ChannelRegistry;
	private events: EventBus;
	private log: LogFn;
	private sessions = new Map<string, SenderSession>();
	private activeCount = 0;
	private running = false;

	constructor(
		bridgeConfig: BridgeConfig | undefined,
		_cwd: string,
		registry: ChannelRegistry,
		events: EventBus,
		log: LogFn = () => {},
	) {
		this.config = { ...BRIDGE_DEFAULTS, ...bridgeConfig };
		this.registry = registry;
		this.events = events;
		this.log = log;
	}

	// ── Lifecycle ─────────────────────────────────────────────

	start(): void {
		if (this.running) return;
		if (!getActiveGatewayRuntime()) {
			this.log("bridge-unavailable", { reason: "no active pi gateway runtime" }, "WARN");
			return;
		}
		this.running = true;
	}

	stop(): void {
		this.running = false;
		for (const session of this.sessions.values()) {
			session.abortController?.abort();
		}
		this.sessions.clear();
		this.activeCount = 0;
	}

	isActive(): boolean {
		return this.running;
	}

	updateConfig(cfg: BridgeConfig): void {
		this.config = { ...BRIDGE_DEFAULTS, ...cfg };
	}

	// ── Main entry point ──────────────────────────────────────

	handleMessage(message: IncomingMessage): void {
		if (!this.running) return;

		const text = message.text?.trim();
		const hasAttachments = message.attachments && message.attachments.length > 0;
		if (!text && !hasAttachments) return;

		// Rejected messages (too large, unsupported type) — send back directly
		if (message.metadata?.rejected) {
			this.sendReply(message.adapter, message.sender, text || "⚠️ Unsupported message.");
			return;
		}

		const senderKey = `${message.adapter}:${message.sender}`;

		// Get or create session
		let session = this.sessions.get(senderKey);
		if (!session) {
			session = this.createSession(message);
			this.sessions.set(senderKey, session);
		}

		// Bot commands (only for text-only messages)
		if (text && !hasAttachments && this.config.commands && isCommand(text)) {
			const reply = handleCommand(text, session, this.commandContext());
			if (reply !== null) {
				this.sendReply(message.adapter, message.sender, reply);
				return;
			}
			// Unrecognized command — fall through to agent
		}

		// Queue depth check
		if (session.queue.length >= this.config.maxQueuePerSender) {
			this.sendReply(
				message.adapter,
				message.sender,
				`⚠️ Queue full (${this.config.maxQueuePerSender} pending). ` +
					`Wait for current prompts to finish or use /abort.`,
			);
			return;
		}

		// Enqueue
		const queued: QueuedPrompt = {
			id: nextId(),
			adapter: message.adapter,
			sender: message.sender,
			text: text || "Describe this.",
			attachments: message.attachments,
			metadata: message.metadata,
			enqueuedAt: Date.now(),
		};
		session.queue.push(queued);
		session.messageCount++;

		this.events.emit("bridge:enqueue", {
			id: queued.id,
			adapter: message.adapter,
			sender: message.sender,
			queueDepth: session.queue.length,
		});

		this.processNext(senderKey);
	}

	// ── Processing ────────────────────────────────────────────

	private async processNext(senderKey: string): Promise<void> {
		const session = this.sessions.get(senderKey);
		if (!session || session.processing || session.queue.length === 0) return;
		if (this.activeCount >= this.config.maxConcurrent) return;

		session.processing = true;
		this.activeCount++;
		const prompt = session.queue.shift()!;

		// Typing indicator
		const adapter = this.registry.getAdapter(prompt.adapter);
		const typing = this.config.typingIndicators ? startTyping(adapter, prompt.sender) : { stop() {} };
		const gateway = getActiveGatewayRuntime();
		if (!gateway) {
			typing.stop();
			session.processing = false;
			this.activeCount--;
			this.sendReply(prompt.adapter, prompt.sender, "❌ pi gateway is not running.");
			return;
		}

		this.events.emit("bridge:start", {
			id: prompt.id,
			adapter: prompt.adapter,
			sender: prompt.sender,
			text: prompt.text.slice(0, 100),
			persistent: true,
		});

		try {
			session.abortController = new AbortController();
			const result = await gateway.enqueueMessage({
				sessionKey: senderKey,
				text: buildPromptText(prompt),
				images: collectImageAttachments(prompt.attachments),
				source: "extension",
				metadata: prompt.metadata,
			});

			typing.stop();

			if (result.ok) {
				this.sendReply(prompt.adapter, prompt.sender, result.response);
			} else if (result.error === "Aborted by user") {
				this.sendReply(prompt.adapter, prompt.sender, "⏹ Aborted.");
			} else {
				const userError = sanitizeError(result.error);
				this.sendReply(prompt.adapter, prompt.sender, result.response || `❌ ${userError}`);
			}

			this.events.emit("bridge:complete", {
				id: prompt.id,
				adapter: prompt.adapter,
				sender: prompt.sender,
				ok: result.ok,
				persistent: true,
			});
			this.log(
				"bridge-complete",
				{
					id: prompt.id,
					adapter: prompt.adapter,
					ok: result.ok,
					persistent: true,
				},
				result.ok ? "INFO" : "WARN",
			);
		} catch (err: unknown) {
			typing.stop();
			const message = err instanceof Error ? err.message : String(err);
			this.log("bridge-error", { adapter: prompt.adapter, sender: prompt.sender, error: message }, "ERROR");
			this.sendReply(prompt.adapter, prompt.sender, `❌ Unexpected error: ${message}`);
		} finally {
			session.abortController = null;
			session.processing = false;
			this.activeCount--;

			if (session.queue.length > 0) this.processNext(senderKey);
			this.drainWaiting();
		}
	}

	/** After a slot frees up, check other senders waiting for concurrency. */
	private drainWaiting(): void {
		if (this.activeCount >= this.config.maxConcurrent) return;
		for (const [key, session] of this.sessions) {
			if (!session.processing && session.queue.length > 0) {
				this.processNext(key);
				if (this.activeCount >= this.config.maxConcurrent) break;
			}
		}
	}

	// ── Session management ────────────────────────────────────

	private createSession(message: IncomingMessage): SenderSession {
		return {
			adapter: message.adapter,
			sender: message.sender,
			displayName:
				(message.metadata?.firstName as string) || (message.metadata?.username as string) || message.sender,
			queue: [],
			processing: false,
			abortController: null,
			messageCount: 0,
			startedAt: Date.now(),
		};
	}

	getStats(): {
		active: boolean;
		sessions: number;
		activePrompts: number;
		totalQueued: number;
	} {
		let totalQueued = 0;
		for (const s of this.sessions.values()) totalQueued += s.queue.length;
		return {
			active: this.running,
			sessions: this.sessions.size,
			activePrompts: this.activeCount,
			totalQueued,
		};
	}

	getSessions(): Map<string, SenderSession> {
		return this.sessions;
	}

	// ── Command context ───────────────────────────────────────

	private commandContext(): CommandContext {
		const gateway = getActiveGatewayRuntime();
		return {
			isPersistent: () => true,
			abortCurrent: (sender: string): boolean => {
				if (!gateway) return false;
				for (const [key, session] of this.sessions) {
					if (session.sender === sender && session.abortController) {
						return gateway.abortSession(key);
					}
				}
				return false;
			},
			clearQueue: (sender: string): void => {
				for (const session of this.sessions.values()) {
					if (session.sender === sender) session.queue.length = 0;
				}
			},
			resetSession: (sender: string): void => {
				if (!gateway) return;
				for (const [key, session] of this.sessions) {
					if (session.sender === sender) {
						this.sessions.delete(key);
						void gateway.resetSession(key);
					}
				}
			},
		};
	}

	// ── Reply ─────────────────────────────────────────────────

	private sendReply(adapter: string, recipient: string, text: string): void {
		this.registry.send({ adapter, recipient, text });
	}
}

const MAX_ERROR_LENGTH = 200;

/**
 * Sanitize subprocess error output for end-user display.
 * Strips stack traces, extension crash logs, and long technical details.
 */
function sanitizeError(error: string | undefined): string {
	if (!error) return "Something went wrong. Please try again.";

	// Extract the most meaningful line — skip "Extension error" noise and stack traces
	const lines = error.split("\n").filter((l) => l.trim());

	// Find the first line that isn't an extension loading error or stack frame
	const meaningful = lines.find(
		(l) =>
			!l.startsWith("Extension error") &&
			!l.startsWith("    at ") &&
			!l.startsWith("node:") &&
			!l.includes("NODE_MODULE_VERSION") &&
			!l.includes("compiled against a different") &&
			!l.includes("Emitted 'error' event"),
	);

	const msg = meaningful?.trim() || "Something went wrong. Please try again.";

	return msg.length > MAX_ERROR_LENGTH ? `${msg.slice(0, MAX_ERROR_LENGTH)}…` : msg;
}

function collectImageAttachments(attachments: QueuedPrompt["attachments"]): ImageContent[] | undefined {
	if (!attachments || attachments.length === 0) {
		return undefined;
	}
	const images = attachments
		.filter((attachment) => attachment.type === "image")
		.map((attachment) => ({
			type: "image" as const,
			data: readFileSync(attachment.path).toString("base64"),
			mimeType: attachment.mimeType || "image/jpeg",
		}));
	return images.length > 0 ? images : undefined;
}

function buildPromptText(prompt: QueuedPrompt): string {
	if (!prompt.attachments || prompt.attachments.length === 0) {
		return prompt.text;
	}

	const attachmentNotes = prompt.attachments
		.filter((attachment) => attachment.type !== "image")
		.map((attachment) => {
			const label = attachment.filename ?? attachment.path;
			return `Attachment (${attachment.type}): ${label}`;
		});
	if (attachmentNotes.length === 0) {
		return prompt.text;
	}
	return `${prompt.text}\n\n${attachmentNotes.join("\n")}`;
}
