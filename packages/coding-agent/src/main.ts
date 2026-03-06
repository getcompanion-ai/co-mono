/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { join } from "node:path";
import { type ImageContent, modelsAreEqual, supportsXhigh } from "@mariozechner/pi-ai";
import chalk from "chalk";
import { createInterface } from "readline";
import { type Args, parseArgs, printHelp } from "./cli/args.js";
import { selectConfig } from "./cli/config-selector.js";
import { processFileArguments } from "./cli/file-processor.js";
import { listModels } from "./cli/list-models.js";
import { selectSession } from "./cli/session-picker.js";
import { APP_NAME, getAgentDir, getModelsPath, VERSION } from "./config.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import type { LoadExtensionsResult } from "./core/extensions/index.js";
import { createGatewaySessionManager } from "./core/gateway-runtime.js";
import { KeybindingsManager } from "./core/keybindings.js";
import { ModelRegistry } from "./core/model-registry.js";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
import { DefaultPackageManager } from "./core/package-manager.js";
import { DefaultResourceLoader } from "./core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "./core/sdk.js";
import { SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, time } from "./core/timings.js";
import { allTools } from "./core/tools/index.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { type DaemonModeOptions, InteractiveMode, runDaemonMode, runPrintMode, runRpcMode } from "./modes/index.js";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const GATEWAY_RESTART_DELAY_MS = 2000;
const GATEWAY_MIN_RUNTIME_MS = 10000;
const GATEWAY_MAX_CONSECUTIVE_FAILURES = 10;

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

type PackageCommand = "install" | "remove" | "update" | "list";

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	local: boolean;
	help: boolean;
	invalidOption?: string;
}

function printDaemonHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} gateway [options] [messages...]
  ${APP_NAME} daemon [options] [messages...]

Run pi as a long-lived gateway (non-interactive) with extensions enabled.
Messages passed as positional args are sent once at startup.

Options:
  --list-models [search]  List available models and exit
  --help, -h              Show this help
`);
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local    Install project-locally (.pi/settings.json)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.

Options:
  -l, --local    Remove from project settings (.pi/settings.json)

Example:
  ${APP_NAME} remove npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update installed packages.
If <source> is provided, only that package is updated.
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "install" && command !== "remove" && command !== "update" && command !== "list") {
		return undefined;
	}

	let local = false;
	let help = false;
	let invalidOption: string | undefined;
	let source: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		}
	}

	return { command, source, local, help, invalidOption };
}

async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.install(source!, { local: options.local });
				packageManager.addSourceToSettings(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				await packageManager.remove(source!, { local: options.local });
				const removed = packageManager.removeSourceFromSettings(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const globalSettings = settingsManager.getGlobalSettings();
				const projectSettings = settingsManager.getProjectSettings();
				const globalPackages = globalSettings.packages ?? [];
				const projectPackages = projectSettings.packages ?? [];

				if (globalPackages.length === 0 && projectPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof globalPackages)[number], scope: "user" | "project") => {
					const source = typeof pkg === "string" ? pkg : pkg.source;
					const filtered = typeof pkg === "object";
					const display = filtered ? `${source} (filtered)` : source;
					console.log(`  ${display}`);
					const path = packageManager.getInstalledPath(source, scope);
					if (path) {
						console.log(chalk.dim(`    ${path}`));
					}
				};

				if (globalPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of globalPackages) {
						formatPackage(pkg, "user");
					}
				}

				if (projectPackages.length > 0) {
					if (globalPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg, "project");
					}
				}

				return true;
			}

			case "update":
				await packageManager.update(source);
				if (source) {
					console.log(chalk.green(`Updated ${source}`));
				} else {
					console.log(chalk.green("Updated packages"));
				}
				return true;
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return {};
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });

	let initialMessage: string;
	if (parsed.messages.length > 0) {
		initialMessage = text + parsed.messages[0];
		parsed.messages.shift();
	} else {
		initialMessage = text;
	}

	return {
		initialMessage,
		initialImages: images.length > 0 ? images : undefined,
	};
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, use as-is
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: sessionArg };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

async function createSessionManager(parsed: Args, cwd: string): Promise<SessionManager | undefined> {
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, parsed.sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, parsed.sessionDir);

			case "global": {
				// Session found in different project - ask user if they want to fork
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return SessionManager.forkFrom(resolved.path, cwd, parsed.sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}
	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	// Default case (new session) returns undefined, SDK will create one
	return undefined;
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): { options: CreateAgentSessionOptions; cliThinkingFromModel: boolean } {
	const options: CreateAgentSessionOptions = {};
	let cliThinkingFromModel = false;

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			console.warn(chalk.yellow(`Warning: ${resolved.warning}`));
		}
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		// --no-tools: start with no built-in tools
		// --tools can still add specific ones back
		if (parsed.tools && parsed.tools.length > 0) {
			options.tools = parsed.tools.map((name) => allTools[name]);
		} else {
			options.tools = [];
		}
	} else if (parsed.tools) {
		options.tools = parsed.tools.map((name) => allTools[name]);
	}

	return { options, cliThinkingFromModel };
}

async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

export async function main(args: string[]) {
	const isGatewayCommand = args[0] === "daemon" || args[0] === "gateway";
	const parsedArgs = isGatewayCommand ? args.slice(1) : args;
	const offlineMode = parsedArgs.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	if (await handlePackageCommand(args)) {
		return;
	}

	if (await handleConfigCommand(args)) {
		return;
	}

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());

	// First pass: parse args to get --extension paths
	const firstPass = parseArgs(parsedArgs);

	// Early load extensions to discover their CLI flags
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "startup");
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage, getModelsPath());

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: firstPass.extensions,
		additionalSkillPaths: firstPass.skills,
		additionalPromptTemplatePaths: firstPass.promptTemplates,
		additionalThemePaths: firstPass.themes,
		noExtensions: firstPass.noExtensions,
		noSkills: firstPass.noSkills,
		noPromptTemplates: firstPass.noPromptTemplates,
		noThemes: firstPass.noThemes,
		systemPrompt: firstPass.systemPrompt,
		appendSystemPrompt: firstPass.appendSystemPrompt,
	});
	await resourceLoader.reload();
	time("resourceLoader.reload");

	const extensionsResult: LoadExtensionsResult = resourceLoader.getExtensions();
	for (const { path, error } of extensionsResult.errors) {
		console.error(chalk.red(`Failed to load extension "${path}": ${error}`));
	}

	// Apply pending provider registrations from extensions immediately
	// so they're available for model resolution before AgentSession is created
	for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];

	const extensionFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const ext of extensionsResult.extensions) {
		for (const [name, flag] of ext.flags) {
			extensionFlags.set(name, { type: flag.type });
		}
	}

	// Second pass: parse args with extension flags
	const parsed = parseArgs(parsedArgs, extensionFlags);

	// Pass flag values to extensions via runtime
	for (const [name, value] of parsed.unknownFlags) {
		extensionsResult.runtime.flagValues.set(name, value);
	}

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.help) {
		if (isGatewayCommand) {
			printDaemonHelp();
		} else {
			printHelp();
		}
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	if (isGatewayCommand && parsed.mode === "rpc") {
		console.error(chalk.red("Cannot use --mode rpc with the gateway command."));
		process.exit(1);
	}

	// Read piped stdin content (if any) - skip for daemon and RPC modes
	if (!isGatewayCommand && parsed.mode !== "rpc") {
		const stdinContent = await readPipedStdin();
		if (stdinContent !== undefined) {
			// Force print mode since interactive mode requires a TTY for keyboard input
			parsed.print = true;
			// Prepend stdin content to messages
			parsed.messages.unshift(stdinContent);
		}
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize());
	const isInteractive = !isGatewayCommand && !parsed.print && parsed.mode === undefined;
	const mode = parsed.mode || "text";
	initTheme(settingsManager.getTheme(), isInteractive);

	// Show deprecation warnings in interactive mode
	if (isInteractive && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await resolveModelScope(modelPatterns, modelRegistry);
	}

	// Create session manager based on CLI flags
	let sessionManager = await createSessionManager(parsed, cwd);

	// Handle --resume: show session picker
	if (parsed.resume) {
		// Initialize keybindings so session picker respects user config
		KeybindingsManager.create();

		const selectedPath = await selectSession(
			(onProgress) => SessionManager.list(cwd, parsed.sessionDir, onProgress),
			SessionManager.listAll,
		);
		if (!selectedPath) {
			console.log(chalk.dim("No session selected"));
			stopThemeWatcher();
			process.exit(0);
		}
		sessionManager = SessionManager.open(selectedPath);
	}

	const { options: sessionOptions, cliThinkingFromModel } = buildSessionOptions(
		parsed,
		scopedModels,
		sessionManager,
		modelRegistry,
		settingsManager,
	);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.resourceLoader = resourceLoader;

	// Handle CLI --api-key as runtime override (not persisted)
	if (parsed.apiKey) {
		if (!sessionOptions.model) {
			console.error(
				chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models"),
			);
			process.exit(1);
		}
		authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
	}

	const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;

	if (isGatewayCommand) {
		const gatewayLoaderOptions = {
			additionalExtensionPaths: firstPass.extensions,
			additionalSkillPaths: firstPass.skills,
			additionalPromptTemplatePaths: firstPass.promptTemplates,
			additionalThemePaths: firstPass.themes,
			noExtensions: firstPass.noExtensions,
			noSkills: firstPass.noSkills,
			noPromptTemplates: firstPass.noPromptTemplates,
			noThemes: firstPass.noThemes,
			systemPrompt: firstPass.systemPrompt,
			appendSystemPrompt: firstPass.appendSystemPrompt,
		};
		const gatewaySessionRoot = join(agentDir, "gateway-sessions");
		let consecutiveFailures = 0;
		let primarySessionFile = sessionManager?.getSessionFile();
		const persistPrimarySession = sessionManager ? sessionManager.isPersisted() : !parsed.noSession;

		const createPrimarySessionManager = (): SessionManager => {
			if (!persistPrimarySession) {
				return SessionManager.inMemory(cwd);
			}
			if (primarySessionFile) {
				return SessionManager.open(primarySessionFile, parsed.sessionDir);
			}
			return SessionManager.create(cwd, parsed.sessionDir);
		};

		const createGatewaySession = async (sessionManagerForRun: SessionManager) => {
			const gatewayResourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				...gatewayLoaderOptions,
			});
			await gatewayResourceLoader.reload();

			const result = await createAgentSession({
				...sessionOptions,
				authStorage,
				modelRegistry,
				settingsManager,
				resourceLoader: gatewayResourceLoader,
				sessionManager: sessionManagerForRun,
			});

			primarySessionFile = result.session.sessionManager.getSessionFile();
			return result;
		};

		while (true) {
			const primarySessionManager = createPrimarySessionManager();
			const { session, modelFallbackMessage } = await createGatewaySession(primarySessionManager);

			if (!session.model) {
				console.error(chalk.red("No models available."));
				console.error(chalk.yellow("\nSet an API key environment variable:"));
				console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.");
				console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
				if (modelFallbackMessage) {
					console.error(chalk.dim(modelFallbackMessage));
				}
				process.exit(1);
			}

			if (cliThinkingOverride) {
				let effectiveThinking = session.thinkingLevel;
				if (!session.model.reasoning) {
					effectiveThinking = "off";
				} else if (effectiveThinking === "xhigh" && !supportsXhigh(session.model)) {
					effectiveThinking = "high";
				}
				if (effectiveThinking !== session.thinkingLevel) {
					session.setThinkingLevel(effectiveThinking);
				}
			}

			const daemonOptions: DaemonModeOptions = {
				initialMessage,
				initialImages,
				messages: parsed.messages,
				gateway: settingsManager.getGatewaySettings(),
				createSession: async (sessionKey) => {
					const gatewayResourceLoader = new DefaultResourceLoader({
						cwd,
						agentDir,
						settingsManager,
						...gatewayLoaderOptions,
					});
					await gatewayResourceLoader.reload();
					const gatewaySessionOptions: CreateAgentSessionOptions = {
						...sessionOptions,
						authStorage,
						modelRegistry,
						settingsManager,
						resourceLoader: gatewayResourceLoader,
						sessionManager: createGatewaySessionManager(cwd, sessionKey, gatewaySessionRoot),
					};
					const { session: gatewaySession } = await createAgentSession(gatewaySessionOptions);
					return gatewaySession;
				},
			};

			const startedAt = Date.now();
			try {
				const result = await runDaemonMode(session, daemonOptions);
				if (result.reason === "shutdown") {
					stopThemeWatcher();
					process.exit(0);
				}
			} catch (error) {
				const message = error instanceof Error ? error.stack || error.message : String(error);
				console.error(`[pi-gateway] daemon crashed: ${message}`);
				try {
					session.dispose();
				} catch {
					// Ignore disposal errors during crash handling.
				}
			}

			const runtimeMs = Date.now() - startedAt;
			if (runtimeMs < GATEWAY_MIN_RUNTIME_MS) {
				consecutiveFailures += 1;
				console.error(
					`[pi-gateway] exited quickly (${runtimeMs}ms), failure ${consecutiveFailures}/${GATEWAY_MAX_CONSECUTIVE_FAILURES}`,
				);
				if (consecutiveFailures >= GATEWAY_MAX_CONSECUTIVE_FAILURES) {
					console.error("[pi-gateway] crash loop detected, exiting");
					process.exit(1);
				}
			} else {
				consecutiveFailures = 0;
				console.error(`[pi-gateway] exited after ${runtimeMs}ms, restarting`);
			}

			if (GATEWAY_RESTART_DELAY_MS > 0) {
				console.error(`[pi-gateway] restarting in ${GATEWAY_RESTART_DELAY_MS}ms`);
				await sleep(GATEWAY_RESTART_DELAY_MS);
			}
		}
	}

	const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);

	if (!isInteractive && !session.model) {
		console.error(chalk.red("No models available."));
		console.error(chalk.yellow("\nSet an API key environment variable:"));
		console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.");
		console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
		process.exit(1);
	}

	// Clamp thinking level to model capabilities for CLI-provided thinking levels.
	// This covers both --thinking <level> and --model <pattern>:<thinking>.
	if (session.model && cliThinkingOverride) {
		let effectiveThinking = session.thinkingLevel;
		if (!session.model.reasoning) {
			effectiveThinking = "off";
		} else if (effectiveThinking === "xhigh" && !supportsXhigh(session.model)) {
			effectiveThinking = "high";
		}
		if (effectiveThinking !== session.thinkingLevel) {
			session.setThinkingLevel(effectiveThinking);
		}
	}

	if (mode === "rpc") {
		await runRpcMode(session);
	} else if (isInteractive) {
		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		printTimings();
		const mode = new InteractiveMode(session, {
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		await mode.run();
	} else {
		await runPrintMode(session, {
			mode,
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		if (process.stdout.writableLength > 0) {
			await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
		}
		process.exit(0);
	}
}
