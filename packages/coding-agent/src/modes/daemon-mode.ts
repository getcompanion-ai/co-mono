/**
 * Daemon mode (always-on background execution).
 *
 * Starts agent extensions, accepts messages from extension sources
 * (webhooks, queues, Telegram/Slack gateways, etc.), and stays alive
 * until explicitly stopped.
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentSession } from "../core/agent-session.js";

/**
 * Options for daemon mode.
 */
export interface DaemonModeOptions {
	/** First message to send at startup (can include @file content expansion by caller). */
	initialMessage?: string;
	/** Images to attach to the startup message. */
	initialImages?: ImageContent[];
	/** Additional startup messages (sent after initialMessage, one by one). */
	messages?: string[];
}

function createCommandContextActions(session: AgentSession) {
	return {
		waitForIdle: () => session.agent.waitForIdle(),
		newSession: async (options?: {
			parentSession?: string;
			setup?: (sessionManager: typeof session.sessionManager) => Promise<void> | void;
		}) => {
			const success = await session.newSession({ parentSession: options?.parentSession });
			if (success && options?.setup) {
				await options.setup(session.sessionManager);
			}
			return { cancelled: !success };
		},
		fork: async (entryId: string) => {
			const result = await session.fork(entryId);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (
			targetId: string,
			options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
		) => {
			const result = await session.navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			});
			return { cancelled: result.cancelled };
		},
		switchSession: async (sessionPath: string) => {
			const success = await session.switchSession(sessionPath);
			return { cancelled: !success };
		},
		reload: async () => {
			await session.reload();
		},
	};
}

/**
 * Run in daemon mode.
 * Stays alive indefinitely unless stopped by signal or extension trigger.
 */
export async function runDaemonMode(session: AgentSession, options: DaemonModeOptions): Promise<never> {
	const { initialMessage, initialImages, messages = [] } = options;
	let isShuttingDown = false;
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});

	const shutdown = async (reason: "signal" | "extension"): Promise<void> => {
		if (isShuttingDown) return;
		isShuttingDown = true;

		console.error(`[co-mono-daemon] shutdown requested: ${reason}`);

		const runner = session.extensionRunner;
		if (runner?.hasHandlers("session_shutdown")) {
			await runner.emit({ type: "session_shutdown" });
		}

		session.dispose();
		resolveReady();
	};

	const handleShutdownSignal = (signal: NodeJS.Signals) => {
		void shutdown("signal").catch((error) => {
			console.error(
				`[co-mono-daemon] shutdown failed for ${signal}: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		});
	};

	process.once("SIGINT", () => handleShutdownSignal("SIGINT"));
	process.once("SIGTERM", () => handleShutdownSignal("SIGTERM"));
	process.once("SIGQUIT", () => handleShutdownSignal("SIGQUIT"));
	process.once("SIGHUP", () => handleShutdownSignal("SIGHUP"));

	process.on("unhandledRejection", (error) => {
		console.error(`[co-mono-daemon] unhandled rejection: ${error instanceof Error ? error.message : String(error)}`);
	});

	await session.bindExtensions({
		commandContextActions: createCommandContextActions(session),
		shutdownHandler: () => {
			void shutdown("extension").catch((error) => {
				console.error(
					`[co-mono-daemon] extension shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(1);
			});
		},
		onError: (err) => {
			console.error(`Extension error (${err.extensionPath}): ${err.error}`);
		},
	});

	// Emit structured events to stderr for supervisor logs.
	session.subscribe((event) => {
		console.error(
			JSON.stringify({ type: event.type, sessionId: session.sessionId, messageCount: session.messages.length }),
		);
	});

	// Startup probes/messages.
	if (initialMessage) {
		await session.prompt(initialMessage, { images: initialImages });
	}
	for (const message of messages) {
		await session.prompt(message);
	}

	console.error(`[co-mono-daemon] startup complete (session=${session.sessionId ?? "unknown"})`);

	// Keep process alive forever.
	await ready;
	process.exit(0);
}
