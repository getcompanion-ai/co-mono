import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 4567);
const CWD = process.argv[2] || process.cwd();

let session: AgentSession | null = null;
const clients = new Set<WebSocket>();

function broadcast(data: unknown) {
	const msg = JSON.stringify(data);
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(msg);
		}
	}
}

async function initSession() {
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage);

	const result = await createAgentSession({
		cwd: CWD,
		authStorage,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
	});

	session = result.session;

	session.subscribe((event) => {
		broadcast({ type: "agent_event", event });
	});

	console.log(`Session created. Model: ${session.model?.name ?? "auto"}`);
	console.log(`Working directory: ${CWD}`);
}

const httpServer = createServer((req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (req.url === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				cwd: CWD,
				model: session?.model?.name ?? null,
				isStreaming: session?.isStreaming ?? false,
				clients: clients.size,
			}),
		);
		return;
	}

	res.writeHead(404);
	res.end("Not found");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
	clients.add(ws);
	console.log(`Client connected (${clients.size} total)`);

	ws.send(
		JSON.stringify({
			type: "connected",
			cwd: CWD,
			model: session?.model?.name ?? null,
			isStreaming: session?.isStreaming ?? false,
		}),
	);

	ws.on("message", async (raw) => {
		if (!session) {
			ws.send(JSON.stringify({ type: "error", error: "Session not initialized" }));
			return;
		}

		let msg: { type: string; [key: string]: unknown };
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
			return;
		}

		try {
			switch (msg.type) {
				case "prompt": {
					const text = msg.text as string;
					if (!text) break;
					if (session.isStreaming) {
						await session.followUp(text);
					} else {
						await session.prompt(text);
					}
					break;
				}

				case "steer": {
					const text = msg.text as string;
					if (text && session.isStreaming) {
						await session.steer(text);
					}
					break;
				}

				case "abort": {
					await session.abort();
					break;
				}

				case "get_messages": {
					ws.send(
						JSON.stringify({
							type: "messages",
							messages: session.messages,
						}),
					);
					break;
				}

				default:
					ws.send(JSON.stringify({ type: "error", error: `Unknown command: ${msg.type}` }));
			}
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			ws.send(JSON.stringify({ type: "error", error }));
		}
	});

	ws.on("close", () => {
		clients.delete(ws);
		console.log(`Client disconnected (${clients.size} total)`);
	});
});

await initSession();

httpServer.listen(PORT, () => {
	console.log(`Pi daemon running on http://localhost:${PORT}`);
	console.log(`WebSocket: ws://localhost:${PORT}`);
});
