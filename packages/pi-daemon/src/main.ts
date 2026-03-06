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
let modelRegistry: ModelRegistry | null = null;
const clients = new Set<WebSocket>();

function broadcast(data: unknown) {
	const msg = JSON.stringify(data);
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(msg);
		}
	}
}

function getCurrentModel(): string | null {
	if (!session?.model) return null;
	return `${session.model.provider}/${session.model.id}`;
}

function getAvailableModels(refresh = false) {
	if (!modelRegistry) return [];
	if (refresh) modelRegistry.refresh();

	return modelRegistry.getAvailable().map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
	}));
}

function sendConnectionPayload(ws: WebSocket) {
	ws.send(
		JSON.stringify({
			type: "connected",
			cwd: CWD,
			model: getCurrentModel(),
			modelName: session?.model?.name ?? null,
			isStreaming: session?.isStreaming ?? false,
			models: getAvailableModels(),
		}),
	);
}

function sendModelsPayload(ws: WebSocket, refresh = false) {
	ws.send(
		JSON.stringify({
			type: "models",
			model: getCurrentModel(),
			modelName: session?.model?.name ?? null,
			models: getAvailableModels(refresh),
		}),
	);
}

async function initSession() {
	const authStorage = AuthStorage.create();
	modelRegistry = new ModelRegistry(authStorage);

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
				model: getCurrentModel(),
				modelName: session?.model?.name ?? null,
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

	sendConnectionPayload(ws);

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

				case "get_models": {
					sendModelsPayload(ws, true);
					break;
				}

				case "set_model": {
					if (session.isStreaming) {
						ws.send(
							JSON.stringify({
								type: "error",
								error: "Cannot change model while a response is streaming.",
							}),
						);
						break;
					}

					const modelKey = (msg.model as string | undefined)?.trim();
					if (!modelKey) {
						ws.send(JSON.stringify({ type: "error", error: "Missing model key." }));
						break;
					}

					const split = modelKey.split("/");
					if (split.length < 2) {
						ws.send(
							JSON.stringify({
								type: "error",
								error: `Invalid model key "${modelKey}". Expected provider/model.`,
							}),
						);
						break;
					}

					const provider = split[0];
					const modelId = split.slice(1).join("/");
					const availableModels = getAvailableModels(true);
					const nextModel = modelRegistry
						?.getAvailable()
						.find((model) => model.provider === provider && model.id === modelId);

					if (!nextModel) {
						ws.send(
							JSON.stringify({
								type: "error",
								error: `Model "${modelKey}" is not available with current auth.`,
								models: availableModels,
							}),
						);
						sendModelsPayload(ws);
						break;
					}

					await session.setModel(nextModel);

					broadcast({
						type: "model_changed",
						model: `${nextModel.provider}/${nextModel.id}`,
						modelName: nextModel.name,
					});
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
