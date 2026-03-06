import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { extractUserText, createVercelStreamListener, finishVercelStream } from "../src/core/vercel-ai-stream.js";

describe("extractUserText", () => {
	it("extracts text from useChat v5+ format with parts", () => {
		const body = {
			messages: [
				{ role: "user", parts: [{ type: "text", text: "hello world" }] },
			],
		};
		expect(extractUserText(body)).toBe("hello world");
	});

	it("extracts text from useChat v4 format with content string", () => {
		const body = {
			messages: [{ role: "user", content: "hello world" }],
		};
		expect(extractUserText(body)).toBe("hello world");
	});

	it("extracts last user message when multiple messages present", () => {
		const body = {
			messages: [
				{ role: "user", parts: [{ type: "text", text: "first" }] },
				{ role: "assistant", parts: [{ type: "text", text: "response" }] },
				{ role: "user", parts: [{ type: "text", text: "second" }] },
			],
		};
		expect(extractUserText(body)).toBe("second");
	});

	it("extracts text from simple gateway format", () => {
		expect(extractUserText({ text: "hello" })).toBe("hello");
	});

	it("extracts text from prompt format", () => {
		expect(extractUserText({ prompt: "hello" })).toBe("hello");
	});

	it("returns null for empty body", () => {
		expect(extractUserText({})).toBeNull();
	});

	it("returns null for empty messages array", () => {
		expect(extractUserText({ messages: [] })).toBeNull();
	});

	it("prefers text field over messages", () => {
		const body = {
			text: "direct",
			messages: [{ role: "user", parts: [{ type: "text", text: "from messages" }] }],
		};
		expect(extractUserText(body)).toBe("direct");
	});
});

describe("createVercelStreamListener", () => {
	function createMockResponse() {
		const chunks: string[] = [];
		let ended = false;
		return {
			writableEnded: false,
			write(data: string) {
				chunks.push(data);
				return true;
			},
			end() {
				ended = true;
				this.writableEnded = true;
			},
			chunks,
			get ended() { return ended; },
		} as any;
	}

	function parseChunks(chunks: string[]): Array<object | string> {
		return chunks
			.filter((c) => c.startsWith("data: "))
			.map((c) => {
				const payload = c.replace(/^data: /, "").replace(/\n\n$/, "");
				try { return JSON.parse(payload); }
				catch { return payload; }
			});
	}

	it("translates text streaming events", () => {
		const response = createMockResponse();
		const listener = createVercelStreamListener(response);

		listener({ type: "agent_start" } as AgentSessionEvent);
		listener({ type: "turn_start", turnIndex: 0, timestamp: Date.now() } as AgentSessionEvent);
		listener({
			type: "message_update",
			message: {} as any,
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} as any },
		} as AgentSessionEvent);
		listener({
			type: "message_update",
			message: {} as any,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} as any },
		} as AgentSessionEvent);
		listener({
			type: "message_update",
			message: {} as any,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello", partial: {} as any },
		} as AgentSessionEvent);
		listener({ type: "turn_end", turnIndex: 0, message: {} as any, toolResults: [] } as AgentSessionEvent);

		const parsed = parseChunks(response.chunks);
		expect(parsed).toEqual([
			{ type: "start" },
			{ type: "start-step" },
			{ type: "text-start", id: "text_0" },
			{ type: "text-delta", id: "text_0", delta: "hello" },
			{ type: "text-end", id: "text_0" },
			{ type: "finish-step" },
		]);
	});

	it("does not write after response has ended", () => {
		const response = createMockResponse();
		const listener = createVercelStreamListener(response);

		listener({ type: "agent_start" } as AgentSessionEvent);
		response.end();
		listener({ type: "turn_start", turnIndex: 0, timestamp: Date.now() } as AgentSessionEvent);

		const parsed = parseChunks(response.chunks);
		expect(parsed).toEqual([{ type: "start" }]);
	});
});
