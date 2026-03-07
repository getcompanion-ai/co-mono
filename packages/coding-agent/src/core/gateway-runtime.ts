import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";
import { SessionManager } from "./session-manager.js";
import type { Settings } from "./settings-manager.js";
import {
	createVercelStreamListener,
	errorVercelStream,
	extractUserText,
	finishVercelStream,
} from "./vercel-ai-stream.js";

export interface GatewayConfig {
	bind: string;
	port: number;
	bearerToken?: string;
	session: {
		idleMinutes: number;
		maxQueuePerSession: number;
	};
	webhook: {
		enabled: boolean;
		basePath: string;
		secret?: string;
	};
}

export type GatewaySessionFactory = (sessionKey: string) => Promise<AgentSession>;

export interface GatewayMessageRequest {
	sessionKey: string;
	text: string;
	source?: "interactive" | "rpc" | "extension";
	images?: ImageContent[];
	metadata?: Record<string, unknown>;
}

export interface GatewayMessageResult {
	ok: boolean;
	response: string;
	error?: string;
	sessionKey: string;
}

export interface GatewaySessionSnapshot {
	sessionKey: string;
	sessionId: string;
	messageCount: number;
	queueDepth: number;
	processing: boolean;
	lastActiveAt: number;
	createdAt: number;
	name?: string;
	lastMessagePreview?: string;
	updatedAt: number;
}

export interface ModelInfo {
	provider: string;
	modelId: string;
	displayName: string;
	capabilities?: string[];
}

export interface HistoryMessage {
	id: string;
	role: "user" | "assistant" | "toolResult";
	parts: HistoryPart[];
	timestamp: number;
}

export type HistoryPart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool-invocation"; toolCallId: string; toolName: string; args: unknown; state: string; result?: unknown };

export interface ChannelStatus {
	id: string;
	name: string;
	connected: boolean;
	error?: string;
}

export interface GatewayRuntimeOptions {
	config: GatewayConfig;
	primarySessionKey: string;
	primarySession: AgentSession;
	createSession: GatewaySessionFactory;
	log?: (message: string) => void;
}

interface GatewayQueuedMessage {
	request: GatewayMessageRequest;
	resolve: (result: GatewayMessageResult) => void;
	onStart?: () => void;
	onFinish?: () => void;
}

type GatewayEvent =
	| { type: "hello"; sessionKey: string; snapshot: GatewaySessionSnapshot }
	| { type: "session_state"; sessionKey: string; snapshot: GatewaySessionSnapshot }
	| { type: "turn_start"; sessionKey: string }
	| { type: "turn_end"; sessionKey: string }
	| { type: "message_start"; sessionKey: string; role?: string }
	| { type: "token"; sessionKey: string; delta: string; contentIndex: number }
	| { type: "thinking"; sessionKey: string; delta: string; contentIndex: number }
	| { type: "tool_start"; sessionKey: string; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_update"; sessionKey: string; toolCallId: string; toolName: string; partialResult: unknown }
	| {
			type: "tool_complete";
			sessionKey: string;
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  }
	| { type: "message_complete"; sessionKey: string; text: string }
	| { type: "error"; sessionKey: string; error: string }
	| { type: "aborted"; sessionKey: string };

interface ManagedGatewaySession {
	sessionKey: string;
	session: AgentSession;
	queue: GatewayQueuedMessage[];
	processing: boolean;
	createdAt: number;
	lastActiveAt: number;
	listeners: Set<(event: GatewayEvent) => void>;
	unsubscribe: () => void;
}

let activeGatewayRuntime: GatewayRuntime | null = null;

export function setActiveGatewayRuntime(runtime: GatewayRuntime | null): void {
	activeGatewayRuntime = runtime;
}

export function getActiveGatewayRuntime(): GatewayRuntime | null {
	return activeGatewayRuntime;
}

export class GatewayRuntime {
	private readonly config: GatewayConfig;
	private readonly primarySessionKey: string;
	private readonly primarySession: AgentSession;
	private readonly createSession: GatewaySessionFactory;
	private readonly log: (message: string) => void;
	private readonly sessions = new Map<string, ManagedGatewaySession>();
	private readonly sessionDirRoot: string;
	private server: Server | null = null;
	private idleSweepTimer: NodeJS.Timeout | null = null;
	private ready = false;
	private logBuffer: string[] = [];
	private readonly maxLogBuffer = 1000;

	constructor(options: GatewayRuntimeOptions) {
		this.config = options.config;
		this.primarySessionKey = options.primarySessionKey;
		this.primarySession = options.primarySession;
		this.createSession = options.createSession;
		const originalLog = options.log;
		this.log = (msg: string) => {
			this.logBuffer.push(msg);
			if (this.logBuffer.length > this.maxLogBuffer) {
				this.logBuffer = this.logBuffer.slice(-this.maxLogBuffer);
			}
			originalLog?.(msg);
		};
		this.sessionDirRoot = join(options.primarySession.sessionManager.getSessionDir(), "..", "gateway-sessions");
	}

	async start(): Promise<void> {
		if (this.server) return;

		await this.ensureSession(this.primarySessionKey, this.primarySession);
		this.server = createServer((request, response) => {
			void this.handleHttpRequest(request, response).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.writeJson(response, 500, { error: message });
			});
		});

		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(this.config.port, this.config.bind, () => {
				this.server?.off("error", reject);
				resolve();
			});
		});

		this.idleSweepTimer = setInterval(() => {
			void this.evictIdleSessions();
		}, 60_000);
		this.ready = true;
	}

	async stop(): Promise<void> {
		this.ready = false;
		if (this.idleSweepTimer) {
			clearInterval(this.idleSweepTimer);
			this.idleSweepTimer = null;
		}
		if (this.server) {
			await new Promise<void>((resolve, reject) => {
				this.server?.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			this.server = null;
		}
		for (const [sessionKey, managedSession] of this.sessions) {
			managedSession.unsubscribe();
			if (sessionKey !== this.primarySessionKey) {
				managedSession.session.dispose();
			}
		}
		this.sessions.clear();
	}

	isReady(): boolean {
		return this.ready;
	}

	getAddress(): { bind: string; port: number } {
		return { bind: this.config.bind, port: this.config.port };
	}

	async enqueueMessage(request: GatewayMessageRequest): Promise<GatewayMessageResult> {
		return this.enqueueManagedMessage({ request });
	}

	private async enqueueManagedMessage(queuedMessage: {
		request: GatewayMessageRequest;
		onStart?: () => void;
		onFinish?: () => void;
	}): Promise<GatewayMessageResult> {
		const managedSession = await this.ensureSession(queuedMessage.request.sessionKey);
		if (managedSession.queue.length >= this.config.session.maxQueuePerSession) {
			return {
				ok: false,
				response: "",
				error: `Queue full (${this.config.session.maxQueuePerSession} pending).`,
				sessionKey: queuedMessage.request.sessionKey,
			};
		}

		return new Promise<GatewayMessageResult>((resolve) => {
			managedSession.queue.push({ ...queuedMessage, resolve });
			this.emitState(managedSession);
			void this.processNext(managedSession);
		});
	}

	async addSubscriber(sessionKey: string, listener: (event: GatewayEvent) => void): Promise<() => void> {
		const managedSession = await this.ensureSession(sessionKey);
		managedSession.listeners.add(listener);
		listener({ type: "hello", sessionKey, snapshot: this.createSnapshot(managedSession) });
		return () => {
			managedSession.listeners.delete(listener);
		};
	}

	abortSession(sessionKey: string): boolean {
		const managedSession = this.sessions.get(sessionKey);
		if (!managedSession?.processing) {
			return false;
		}
		void managedSession.session.abort().catch((error) => {
			this.emit(managedSession, {
				type: "error",
				sessionKey,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return true;
	}

	clearQueue(sessionKey: string): void {
		const managedSession = this.sessions.get(sessionKey);
		if (!managedSession) return;
		managedSession.queue.length = 0;
		this.emitState(managedSession);
	}

	async resetSession(sessionKey: string): Promise<void> {
		const managedSession = this.sessions.get(sessionKey);
		if (!managedSession) return;

		if (sessionKey === this.primarySessionKey) {
			await managedSession.session.newSession();
			managedSession.queue.length = 0;
			managedSession.processing = false;
			managedSession.lastActiveAt = Date.now();
			this.emitState(managedSession);
			return;
		}

		if (managedSession.processing) {
			await managedSession.session.abort();
		}
		managedSession.unsubscribe();
		managedSession.session.dispose();
		this.sessions.delete(sessionKey);
	}

	listSessions(): GatewaySessionSnapshot[] {
		return Array.from(this.sessions.values()).map((session) => this.createSnapshot(session));
	}

	getSession(sessionKey: string): GatewaySessionSnapshot | undefined {
		const session = this.sessions.get(sessionKey);
		return session ? this.createSnapshot(session) : undefined;
	}

	private async ensureSession(sessionKey: string, existingSession?: AgentSession): Promise<ManagedGatewaySession> {
		const found = this.sessions.get(sessionKey);
		if (found) {
			found.lastActiveAt = Date.now();
			return found;
		}

		const session = existingSession ?? (await this.createSession(sessionKey));
		const managedSession: ManagedGatewaySession = {
			sessionKey,
			session,
			queue: [],
			processing: false,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			listeners: new Set(),
			unsubscribe: () => {},
		};
		managedSession.unsubscribe = session.subscribe((event) => {
			this.handleSessionEvent(managedSession, event);
		});
		this.sessions.set(sessionKey, managedSession);
		this.emitState(managedSession);
		return managedSession;
	}

	private async processNext(managedSession: ManagedGatewaySession): Promise<void> {
		if (managedSession.processing || managedSession.queue.length === 0) {
			return;
		}

		const queued = managedSession.queue.shift();
		if (!queued) return;

		managedSession.processing = true;
		managedSession.lastActiveAt = Date.now();
		this.emitState(managedSession);

		try {
			queued.onStart?.();
			await managedSession.session.prompt(queued.request.text, {
				images: queued.request.images,
				source: queued.request.source ?? "extension",
			});
			const response = getLastAssistantText(managedSession.session);
			queued.resolve({
				ok: true,
				response,
				sessionKey: managedSession.sessionKey,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("aborted")) {
				this.emit(managedSession, { type: "aborted", sessionKey: managedSession.sessionKey });
			} else {
				this.emit(managedSession, { type: "error", sessionKey: managedSession.sessionKey, error: message });
			}
			queued.resolve({
				ok: false,
				response: "",
				error: message,
				sessionKey: managedSession.sessionKey,
			});
		} finally {
			queued.onFinish?.();
			managedSession.processing = false;
			managedSession.lastActiveAt = Date.now();
			this.emitState(managedSession);
			if (managedSession.queue.length > 0) {
				void this.processNext(managedSession);
			}
		}
	}

	private handleSessionEvent(managedSession: ManagedGatewaySession, event: AgentSessionEvent): void {
		switch (event.type) {
			case "turn_start":
				this.emit(managedSession, { type: "turn_start", sessionKey: managedSession.sessionKey });
				return;
			case "turn_end":
				this.emit(managedSession, { type: "turn_end", sessionKey: managedSession.sessionKey });
				return;
			case "message_start":
				this.emit(managedSession, {
					type: "message_start",
					sessionKey: managedSession.sessionKey,
					role: event.message.role,
				});
				return;
			case "message_update":
				switch (event.assistantMessageEvent.type) {
					case "text_delta":
						this.emit(managedSession, {
							type: "token",
							sessionKey: managedSession.sessionKey,
							delta: event.assistantMessageEvent.delta,
							contentIndex: event.assistantMessageEvent.contentIndex,
						});
						return;
					case "thinking_delta":
						this.emit(managedSession, {
							type: "thinking",
							sessionKey: managedSession.sessionKey,
							delta: event.assistantMessageEvent.delta,
							contentIndex: event.assistantMessageEvent.contentIndex,
						});
						return;
				}
				return;
			case "message_end":
				if (event.message.role === "assistant") {
					this.emit(managedSession, {
						type: "message_complete",
						sessionKey: managedSession.sessionKey,
						text: extractMessageText(event.message),
					});
				}
				return;
			case "tool_execution_start":
				this.emit(managedSession, {
					type: "tool_start",
					sessionKey: managedSession.sessionKey,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				return;
			case "tool_execution_update":
				this.emit(managedSession, {
					type: "tool_update",
					sessionKey: managedSession.sessionKey,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					partialResult: event.partialResult,
				});
				return;
			case "tool_execution_end":
				this.emit(managedSession, {
					type: "tool_complete",
					sessionKey: managedSession.sessionKey,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				});
				return;
		}
	}

	private emit(managedSession: ManagedGatewaySession, event: GatewayEvent): void {
		for (const listener of managedSession.listeners) {
			listener(event);
		}
	}

	private emitState(managedSession: ManagedGatewaySession): void {
		this.emit(managedSession, {
			type: "session_state",
			sessionKey: managedSession.sessionKey,
			snapshot: this.createSnapshot(managedSession),
		});
	}

	private createSnapshot(managedSession: ManagedGatewaySession): GatewaySessionSnapshot {
		const messages = managedSession.session.messages;
		let lastMessagePreview: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "user" || msg.role === "assistant") {
				const content = (msg as { content: unknown }).content;
				if (typeof content === "string" && content.length > 0) {
					lastMessagePreview = content.slice(0, 120);
					break;
				}
				if (Array.isArray(content)) {
					for (const part of content) {
						if (typeof part === "object" && part !== null && (part as { type: string }).type === "text") {
							const text = (part as { text: string }).text;
							if (text.length > 0) {
								lastMessagePreview = text.slice(0, 120);
								break;
							}
						}
					}
					if (lastMessagePreview) break;
				}
			}
		}
		return {
			sessionKey: managedSession.sessionKey,
			sessionId: managedSession.session.sessionId,
			messageCount: messages.length,
			queueDepth: managedSession.queue.length,
			processing: managedSession.processing,
			lastActiveAt: managedSession.lastActiveAt,
			createdAt: managedSession.createdAt,
			updatedAt: managedSession.lastActiveAt,
			lastMessagePreview,
		};
	}

	private async evictIdleSessions(): Promise<void> {
		const cutoff = Date.now() - this.config.session.idleMinutes * 60_000;
		for (const [sessionKey, managedSession] of this.sessions) {
			if (sessionKey === this.primarySessionKey) {
				continue;
			}
			if (managedSession.processing || managedSession.queue.length > 0) {
				continue;
			}
			if (managedSession.lastActiveAt > cutoff) {
				continue;
			}
			if (managedSession.listeners.size > 0) {
				continue;
			}
			managedSession.unsubscribe();
			managedSession.session.dispose();
			this.sessions.delete(sessionKey);
			this.log(`evicted idle session ${sessionKey}`);
		}
	}

	private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const method = request.method ?? "GET";
		const url = new URL(
			request.url ?? "/",
			`http://${request.headers.host ?? `${this.config.bind}:${this.config.port}`}`,
		);
		const path = url.pathname;

		if (method === "GET" && path === "/health") {
			this.writeJson(response, 200, { ok: true, ready: this.ready });
			return;
		}

		if (method === "GET" && path === "/ready") {
			this.requireAuth(request, response);
			if (response.writableEnded) return;
			this.writeJson(response, 200, { ok: true, ready: this.ready, sessions: this.sessions.size });
			return;
		}

		if (this.config.webhook.enabled && method === "POST" && path.startsWith(this.config.webhook.basePath)) {
			await this.handleWebhookRequest(path, request, response);
			return;
		}

		this.requireAuth(request, response);
		if (response.writableEnded) return;

		if (method === "GET" && path === "/sessions") {
			this.writeJson(response, 200, { sessions: this.listSessions() });
			return;
		}

		if (method === "GET" && path === "/models") {
			const models = await this.handleGetModels();
			this.writeJson(response, 200, models);
			return;
		}

		if (method === "GET" && path === "/config") {
			const config = this.getPublicConfig();
			this.writeJson(response, 200, config);
			return;
		}

		if (method === "POST" && path === "/config") {
			const body = await this.readJsonBody(request);
			await this.handlePatchConfig(body);
			this.writeJson(response, 200, { ok: true });
			return;
		}

		if (method === "GET" && path === "/channels/status") {
			const status = this.handleGetChannelsStatus();
			this.writeJson(response, 200, { channels: status });
			return;
		}

		if (method === "GET" && path === "/logs") {
			const logs = this.handleGetLogs();
			this.writeJson(response, 200, { logs });
			return;
		}

		const sessionMatch = path.match(/^\/sessions\/([^/]+)(?:\/(events|messages|abort|reset|chat|history|model|reload))?$/);
		if (!sessionMatch) {
			this.writeJson(response, 404, { error: "Not found" });
			return;
		}

		const sessionKey = decodeURIComponent(sessionMatch[1]);
		const action = sessionMatch[2];

		if (!action && method === "GET") {
			const session = await this.ensureSession(sessionKey);
			this.writeJson(response, 200, { session: this.createSnapshot(session) });
			return;
		}

		if (!action && method === "PATCH") {
			const body = await this.readJsonBody(request);
			await this.handlePatchSession(sessionKey, body as { name?: string });
			this.writeJson(response, 200, { ok: true });
			return;
		}

		if (!action && method === "DELETE") {
			await this.handleDeleteSession(sessionKey);
			this.writeJson(response, 200, { ok: true });
			return;
		}

		if (action === "events" && method === "GET") {
			await this.handleSse(sessionKey, request, response);
			return;
		}

		if (action === "chat" && method === "POST") {
			await this.handleChat(sessionKey, request, response);
			return;
		}

		if (action === "messages" && method === "POST") {
			const body = await this.readJsonBody(request);
			const text = typeof body.text === "string" ? body.text : "";
			if (!text.trim()) {
				this.writeJson(response, 400, { error: "Missing text" });
				return;
			}
			const result = await this.enqueueMessage({
				sessionKey,
				text,
				source: "extension",
			});
			this.writeJson(response, result.ok ? 200 : 500, result);
			return;
		}

		if (action === "abort" && method === "POST") {
			this.writeJson(response, 200, { ok: this.abortSession(sessionKey) });
			return;
		}

		if (action === "reset" && method === "POST") {
			await this.resetSession(sessionKey);
			this.writeJson(response, 200, { ok: true });
			return;
		}

		if (action === "history" && method === "GET") {
			const limitParam = url.searchParams.get("limit");
			const messages = this.handleGetHistory(sessionKey, limitParam ? parseInt(limitParam, 10) : undefined);
			this.writeJson(response, 200, { messages });
			return;
		}

		if (action === "model" && method === "POST") {
			const body = await this.readJsonBody(request);
			const provider = typeof body.provider === "string" ? body.provider : "";
			const modelId = typeof body.modelId === "string" ? body.modelId : "";
			const result = await this.handleSetModel(sessionKey, provider, modelId);
			this.writeJson(response, 200, result);
			return;
		}

		if (action === "reload" && method === "POST") {
			await this.handleReloadSession(sessionKey);
			this.writeJson(response, 200, { ok: true });
			return;
		}

		this.writeJson(response, 405, { error: "Method not allowed" });
	}

	private async handleWebhookRequest(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const route = path.slice(this.config.webhook.basePath.length).replace(/^\/+/, "") || "default";
		if (this.config.webhook.secret) {
			const presentedSecret = request.headers["x-pi-webhook-secret"];
			if (presentedSecret !== this.config.webhook.secret) {
				this.writeJson(response, 401, { error: "Invalid webhook secret" });
				return;
			}
		}

		const body = await this.readJsonBody(request);
		const text = typeof body.text === "string" ? body.text : "";
		if (!text.trim()) {
			this.writeJson(response, 400, { error: "Missing text" });
			return;
		}

		const conversationId =
			typeof body.sessionKey === "string"
				? body.sessionKey
				: `webhook:${route}:${typeof body.sender === "string" ? body.sender : "default"}`;
		const result = await this.enqueueMessage({
			sessionKey: conversationId,
			text,
			source: "extension",
			metadata: typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {},
		});
		this.writeJson(response, result.ok ? 200 : 500, result);
	}

	private async handleSse(sessionKey: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		});
		response.write("\n");

		const unsubscribe = await this.addSubscriber(sessionKey, (event) => {
			response.write(`data: ${JSON.stringify(event)}\n\n`);
		});
		request.on("close", () => {
			unsubscribe();
		});
	}

	private async handleChat(sessionKey: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await this.readJsonBody(request);
		const text = extractUserText(body);
		if (!text) {
			this.writeJson(response, 400, { error: "Missing user message text" });
			return;
		}

		// Set up SSE response headers
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"x-vercel-ai-ui-message-stream": "v1",
		});
		response.write("\n");

		const listener = createVercelStreamListener(response);
		let unsubscribe: (() => void) | undefined;
		let streamingActive = false;

		const stopStreaming = () => {
			if (!streamingActive) return;
			streamingActive = false;
			unsubscribe?.();
			unsubscribe = undefined;
		};

		// Clean up on client disconnect
		let clientDisconnected = false;
		request.on("close", () => {
			clientDisconnected = true;
			stopStreaming();
		});

		// Drive the session through the existing queue infrastructure
		try {
			const managedSession = await this.ensureSession(sessionKey);
			const result = await this.enqueueManagedMessage({
				request: {
					sessionKey,
					text,
					source: "extension",
				},
				onStart: () => {
					if (clientDisconnected || streamingActive) return;
					unsubscribe = managedSession.session.subscribe(listener);
					streamingActive = true;
				},
				onFinish: () => {
					stopStreaming();
				},
			});
			if (!clientDisconnected) {
				stopStreaming();
				if (result.ok) {
					finishVercelStream(response, "stop");
				} else {
					const isAbort = result.error?.includes("aborted");
					if (isAbort) {
						finishVercelStream(response, "error");
					} else {
						errorVercelStream(response, result.error ?? "Unknown error");
					}
				}
			}
		} catch (error) {
			if (!clientDisconnected) {
				stopStreaming();
				const message = error instanceof Error ? error.message : String(error);
				errorVercelStream(response, message);
			}
		}
	}

	private requireAuth(request: IncomingMessage, response: ServerResponse): void {
		if (!this.config.bearerToken) {
			return;
		}
		const header = request.headers.authorization;
		if (header === `Bearer ${this.config.bearerToken}`) {
			return;
		}
		this.writeJson(response, 401, { error: "Unauthorized" });
	}

	private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		}
		if (chunks.length === 0) {
			return {};
		}
		const body = Buffer.concat(chunks).toString("utf8");
		return JSON.parse(body) as Record<string, unknown>;
	}

	private writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
		response.statusCode = statusCode;
		response.setHeader("content-type", "application/json; charset=utf-8");
		response.end(JSON.stringify(payload));
	}

	// ---------------------------------------------------------------------------
	// New handler methods added for companion-cloud web app integration
	// ---------------------------------------------------------------------------

	private async handleGetModels(): Promise<{ models: ModelInfo[]; current: { provider: string; modelId: string } | null }> {
		const available = this.primarySession.modelRegistry.getAvailable();
		const models: ModelInfo[] = available.map((m) => ({
			provider: m.provider,
			modelId: m.id,
			displayName: m.name,
			capabilities: [
				...(m.reasoning ? ["reasoning"] : []),
				...(m.input.includes("image") ? ["vision"] : []),
			],
		}));
		const currentModel = this.primarySession.model;
		const current = currentModel ? { provider: currentModel.provider, modelId: currentModel.id } : null;
		return { models, current };
	}

	private async handleSetModel(
		sessionKey: string,
		provider: string,
		modelId: string,
	): Promise<{ ok: true; model: { provider: string; modelId: string } }> {
		const managed = this.sessions.get(sessionKey);
		if (!managed) {
			throw new Error(`Session not found: ${sessionKey}`);
		}
		const found = managed.session.modelRegistry.find(provider, modelId);
		if (!found) {
			throw new Error(`Model not found: ${provider}/${modelId}`);
		}
		await managed.session.setModel(found);
		return { ok: true, model: { provider, modelId } };
	}

	private handleGetHistory(sessionKey: string, limit?: number): HistoryMessage[] {
		const managed = this.sessions.get(sessionKey);
		if (!managed) {
			return [];
		}
		const rawMessages = managed.session.messages;
		const messages: HistoryMessage[] = [];
		for (const msg of rawMessages) {
			if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "toolResult") {
				continue;
			}
			messages.push({
				id: `${msg.timestamp}-${msg.role}`,
				role: msg.role,
				parts: this.messageContentToParts(msg),
				timestamp: msg.timestamp,
			});
		}
		return limit ? messages.slice(-limit) : messages;
	}

	private async handlePatchSession(sessionKey: string, patch: { name?: string }): Promise<void> {
		const managed = this.sessions.get(sessionKey);
		if (!managed) {
			throw new Error(`Session not found: ${sessionKey}`);
		}
		if (patch.name !== undefined) {
			// Labels in pi-mono are per-entry; we label the current leaf entry
			const leafId = managed.session.sessionManager.getLeafId?.();
			if (leafId) {
				managed.session.sessionManager.appendLabelChange(leafId, patch.name);
			}
		}
	}

	private async handleDeleteSession(sessionKey: string): Promise<void> {
		if (sessionKey === this.primarySessionKey) {
			throw new Error("Cannot delete primary session");
		}
		const managed = this.sessions.get(sessionKey);
		if (!managed) {
			throw new Error(`Session not found: ${sessionKey}`);
		}
		managed.unsubscribe();
		managed.session.dispose();
		this.sessions.delete(sessionKey);
	}

	private getPublicConfig(): Record<string, unknown> {
		const settings = this.primarySession.settingsManager.getGlobalSettings();
		const { gateway, ...rest } = settings as Record<string, unknown> & { gateway?: Record<string, unknown> };
		const { bearerToken: _bearerToken, ...safeGateway } = gateway ?? {};
		return { ...rest, gateway: safeGateway };
	}

	private async handlePatchConfig(patch: Record<string, unknown>): Promise<void> {
		// Apply overrides on top of current settings (in-memory only for daemon use)
		this.primarySession.settingsManager.applyOverrides(patch as Settings);
	}

	private handleGetChannelsStatus(): ChannelStatus[] {
		// Extension channel status is not currently exposed as a public API on AgentSession.
		// Return empty array as a safe default.
		return [];
	}

	private handleGetLogs(): string[] {
		return this.logBuffer.slice(-200);
	}

	private async handleReloadSession(sessionKey: string): Promise<void> {
		const managed = this.sessions.get(sessionKey);
		if (!managed) {
			throw new Error(`Session not found: ${sessionKey}`);
		}
		// Reloading config by calling settingsManager.reload() on the session
		managed.session.settingsManager.reload();
	}

	private messageContentToParts(msg: AgentMessage): HistoryPart[] {
		if (msg.role === "user") {
			const content = msg.content;
			if (typeof content === "string") {
				return [{ type: "text", text: content }];
			}
			if (Array.isArray(content)) {
				return content
					.filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && c.type === "text")
					.map((c) => ({ type: "text" as const, text: c.text }));
			}
			return [];
		}

		if (msg.role === "assistant") {
			const content = msg.content;
			if (!Array.isArray(content)) return [];
			const parts: HistoryPart[] = [];
			for (const c of content) {
				if (typeof c !== "object" || c === null) continue;
				if (c.type === "text") {
					parts.push({ type: "text", text: (c as { type: "text"; text: string }).text });
				} else if (c.type === "thinking") {
					parts.push({ type: "reasoning", text: (c as { type: "thinking"; thinking: string }).thinking });
				} else if (c.type === "toolCall") {
					const tc = c as { type: "toolCall"; id: string; name: string; arguments: unknown };
					parts.push({
						type: "tool-invocation",
						toolCallId: tc.id,
						toolName: tc.name,
						args: tc.arguments,
						state: "call",
					});
				}
			}
			return parts;
		}

		if (msg.role === "toolResult") {
			const tr = msg as { role: "toolResult"; toolCallId: string; toolName: string; content: unknown; isError: boolean };
			const textParts = Array.isArray(tr.content)
				? (tr.content as { type: string; text?: string }[])
						.filter((c) => c.type === "text" && typeof c.text === "string")
						.map((c) => c.text as string)
						.join("")
				: "";
			return [
				{
					type: "tool-invocation",
					toolCallId: tr.toolCallId,
					toolName: tr.toolName,
					args: undefined,
					state: tr.isError ? "error" : "result",
					result: textParts,
				},
			];
		}

		return [];
	}

	getGatewaySessionDir(sessionKey: string): string {
		return join(this.sessionDirRoot, sanitizeSessionKey(sessionKey));
	}
}

function extractMessageText(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((part): part is { type: "text"; text: string } => {
			return typeof part === "object" && part !== null && "type" in part && "text" in part && part.type === "text";
		})
		.map((part) => part.text)
		.join("");
}

function getLastAssistantText(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message.role === "assistant") {
			return extractMessageText(message);
		}
	}
	return "";
}

export function sanitizeSessionKey(sessionKey: string): string {
	return sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function createGatewaySessionManager(cwd: string, sessionKey: string, sessionDirRoot: string): SessionManager {
	return SessionManager.create(cwd, join(sessionDirRoot, sanitizeSessionKey(sessionKey)));
}
