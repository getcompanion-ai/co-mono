import type { ServerResponse } from "node:http";
import type { AgentSessionEvent } from "./agent-session.js";

/**
 * Write a single Vercel AI SDK v5+ SSE chunk to the response.
 * Format: `data: <JSON>\n\n`
 * For the terminal [DONE] sentinel: `data: [DONE]\n\n`
 */
function writeChunk(response: ServerResponse, chunk: object | string): void {
	if (response.writableEnded) return;
	const payload = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
	response.write(`data: ${payload}\n\n`);
}

/**
 * Extract the user's text from the request body.
 * Supports both useChat format ({ messages: UIMessage[] }) and simple gateway format ({ text: string }).
 */
export function extractUserText(body: Record<string, unknown>): string | null {
	// Simple gateway format
	if (typeof body.text === "string" && body.text.trim()) {
		return body.text;
	}
	// Convenience format
	if (typeof body.prompt === "string" && body.prompt.trim()) {
		return body.prompt;
	}
	// Vercel AI SDK useChat format - extract last user message
	if (Array.isArray(body.messages)) {
		for (let i = body.messages.length - 1; i >= 0; i--) {
			const msg = body.messages[i] as Record<string, unknown>;
			if (msg.role !== "user") continue;
			// v5+ format with parts array
			if (Array.isArray(msg.parts)) {
				for (const part of msg.parts as Array<Record<string, unknown>>) {
					if (part.type === "text" && typeof part.text === "string") {
						return part.text;
					}
				}
			}
			// v4 format with content string
			if (typeof msg.content === "string" && msg.content.trim()) {
				return msg.content;
			}
		}
	}
	return null;
}

/**
 * Create an AgentSessionEvent listener that translates events to Vercel AI SDK v5+ SSE
 * chunks and writes them to the HTTP response.
 *
 * Returns the listener function. The caller is responsible for subscribing/unsubscribing.
 */
export function createVercelStreamListener(
	response: ServerResponse,
): (event: AgentSessionEvent) => void {
	let started = false;

	return (event: AgentSessionEvent) => {
		if (response.writableEnded) return;

		switch (event.type) {
			case "agent_start":
				if (!started) {
					writeChunk(response, { type: "start" });
					started = true;
				}
				return;

			case "turn_start":
				writeChunk(response, { type: "start-step" });
				return;

			case "message_update": {
				const inner = event.assistantMessageEvent;
				switch (inner.type) {
					case "text_start":
						writeChunk(response, {
							type: "text-start",
							id: `text_${inner.contentIndex}`,
						});
						return;
					case "text_delta":
						writeChunk(response, {
							type: "text-delta",
							id: `text_${inner.contentIndex}`,
							delta: inner.delta,
						});
						return;
					case "text_end":
						writeChunk(response, {
							type: "text-end",
							id: `text_${inner.contentIndex}`,
						});
						return;
				}
				return;
			}

			case "turn_end":
				writeChunk(response, { type: "finish-step" });
				return;
		}
	};
}

/**
 * Write the terminal finish sequence and end the response.
 */
export function finishVercelStream(
	response: ServerResponse,
	finishReason: string = "stop",
): void {
	if (response.writableEnded) return;
	writeChunk(response, { type: "finish", finishReason });
	writeChunk(response, "[DONE]");
	response.end();
}

/**
 * Write an error chunk and end the response.
 */
export function errorVercelStream(
	response: ServerResponse,
	errorText: string,
): void {
	if (response.writableEnded) return;
	writeChunk(response, { type: "error", errorText });
	writeChunk(response, "[DONE]");
	response.end();
}
