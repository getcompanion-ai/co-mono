#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);

const defaults = {
  name: "pi-runtime-daemon",
  startupTimeoutMs: 30_000,
  probeIntervalMs: 5_000,
  probeTimeoutMs: 2_000,
  restartDelayMs: 1_000,
  gracefulStopTimeoutMs: 5_000,
  pidFile: null,
};

function parseArgs(input) {
  const parsed = {
    command: null,
    env: {},
    ...defaults,
  };
  const args = [...input];
  const leftovers = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    const getNext = (label) => {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`${label} requires a value`);
      }
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (!arg.startsWith("-")) {
      leftovers.push(arg);
      i += 1;
      continue;
    }

    if (arg === "--command" || arg === "-c") {
      parsed.command = getNext("--command");
      i += 2;
      continue;
    }

    if (arg === "--health-url") {
      parsed.healthUrl = getNext("--health-url");
      i += 2;
      continue;
    }

    if (arg === "--health-cmd") {
      parsed.healthCmd = getNext("--health-cmd");
      i += 2;
      continue;
    }

    if (arg === "--name") {
      parsed.name = getNext("--name");
      i += 2;
      continue;
    }

    if (arg === "--pid-file") {
      parsed.pidFile = getNext("--pid-file");
      i += 2;
      continue;
    }

    if (arg === "--startup-timeout-ms") {
      parsed.startupTimeoutMs = Number(getNext("--startup-timeout-ms"));
      i += 2;
      continue;
    }

    if (arg === "--probe-interval-ms") {
      parsed.probeIntervalMs = Number(getNext("--probe-interval-ms"));
      i += 2;
      continue;
    }

    if (arg === "--probe-timeout-ms") {
      parsed.probeTimeoutMs = Number(getNext("--probe-timeout-ms"));
      i += 2;
      continue;
    }

    if (arg === "--restart-delay-ms") {
      parsed.restartDelayMs = Number(getNext("--restart-delay-ms"));
      i += 2;
      continue;
    }

    if (arg === "--graceful-stop-timeout-ms") {
      parsed.gracefulStopTimeoutMs = Number(getNext("--graceful-stop-timeout-ms"));
      i += 2;
      continue;
    }

    if (arg === "--env") {
      const pair = getNext("--env");
      if (!pair || pair.startsWith("-")) {
        throw new Error("--env expects KEY=VALUE");
      }

      const idx = pair.indexOf("=");
      if (idx === -1) {
        throw new Error("--env expects KEY=VALUE");
      }

      const key = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      parsed.env[key] = value;
      i += 2;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (parsed.command === null && leftovers.length > 0) {
    parsed.command = leftovers.join(" ");
  }

  if (!parsed.command) {
    throw new Error("Missing --command");
  }

  return parsed;
}

function printHelp() {
  console.log(
    `Usage:

pi-runtime-daemon --command "<shell command>"
  [--name <name>]
  [--health-url <url>]
  [--health-cmd <cmd>]
  [--startup-timeout-ms 30000]
  [--probe-interval-ms 5000]
  [--probe-timeout-ms 2000]
  [--restart-delay-ms 1000]
  [--graceful-stop-timeout-ms 5000]
  [--pid-file <path>]
  [--env KEY=VALUE]

At least one of --health-url or --health-cmd is recommended.
If none is set, process restarts only on process exit.`,
  );
}

function now() {
  return new Date().toISOString();
}

function log(name, message) {
  process.stdout.write(`[${now()}] [${name}] ${message}\n`);
}

function isNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid numeric value for ${label}: ${value}`);
  }
}

function startChild(command, env, pidFile, logName) {
  const child = spawn(command, {
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      ...env,
    },
  });

  if (!child.pid) {
    throw new Error("failed to spawn child process");
  }

  if (pidFile) {
    writeFileSync(pidFile, String(child.pid), "utf8");
  }

  log(logName, `started child process pid=${child.pid}`);

  return child;
}

function clearPid(pidFile) {
  if (!pidFile) {
    return;
  }

  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

function withTimeout(ms, signalLabel) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout: ${signalLabel}`));
    }, ms);
    timer.unref?.();
  });
}

async function runProbe(url, cmd, timeoutMs) {
  const hasProbe = Boolean(url || cmd);
  if (!hasProbe) {
    return { ok: true, source: "none" };
  }

  if (url) {
    const fetchWithTimeout = async () => {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetch(url, {
        method: "GET",
        signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          source: `GET ${url}`,
          detail: `${response.status} ${response.statusText}`,
        };
      }
      return { ok: true, source: `GET ${url}` };
    };

    try {
      return await fetchWithTimeout();
    } catch (err) {
      return { ok: false, source: `GET ${url}`, detail: String(err?.message ?? err) };
    }
  }

  const probeCommand = new Promise((resolve) => {
    const probe = spawn(cmd, {
      shell: true,
      stdio: "ignore",
    });

    const onDone = (code) => {
      resolve({
        ok: code === 0,
        source: `command ${cmd}`,
        detail: `exitCode=${code}`,
      });
    };

    probe.on("error", () => {
      resolve({ ok: false, source: `command ${cmd}`, detail: "spawn error" });
    });

    probe.on("exit", (code) => onDone(code ?? 1));
  });

  try {
    return await Promise.race([probeCommand, withTimeout(timeoutMs, `command timeout: ${cmd}`)]);
  } catch {
    return { ok: false, source: `command ${cmd}`, detail: `probe command timeout (${timeoutMs}ms)` };
  }
}

function normalizeChildPromise(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function shutdownChild(child, timeoutMs, name) {
  if (!child) {
    return;
  }

  if (child.killed) {
    return;
  }

  log(name, "requesting graceful shutdown");
  child.kill("SIGTERM");

  const exit = normalizeChildPromise(child);
  await Promise.race([exit, withTimeout(timeoutMs, "graceful-shutdown")]).catch(() => {
    if (!child.killed) {
      log(name, "graceful timeout, sending SIGKILL");
      child.kill("SIGKILL");
    }
  });
  log(name, "child stopped");
}

async function main() {
  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    printHelp();
    process.exit(1);
  }

  isNumber(cfg.startupTimeoutMs, "--startup-timeout-ms");
  isNumber(cfg.probeIntervalMs, "--probe-interval-ms");
  isNumber(cfg.probeTimeoutMs, "--probe-timeout-ms");
  isNumber(cfg.restartDelayMs, "--restart-delay-ms");
  isNumber(cfg.gracefulStopTimeoutMs, "--graceful-stop-timeout-ms");

  let stopRequested = false;
  let child = null;
  let childExitPromise = null;

  const stop = async () => {
    stopRequested = true;
    if (child) {
      await shutdownChild(child, cfg.gracefulStopTimeoutMs, cfg.name);
    }
    if (cfg.pidFile) {
      clearPid(cfg.pidFile);
    }
    log(cfg.name, "stopped");
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("uncaughtException", (error) => {
    console.error(error);
    process.exit(1);
  });

  log(cfg.name, `runtime daemon starting command="${cfg.command}"`);
  if (cfg.healthUrl) {
    log(cfg.name, `health URL: ${cfg.healthUrl}`);
  }
  if (cfg.healthCmd) {
    log(cfg.name, `health command: ${cfg.healthCmd}`);
  }

  let restartAttempt = 0;
  while (!stopRequested) {
    child = startChild(cfg.command, cfg.env, cfg.pidFile, cfg.name);
    childExitPromise = normalizeChildPromise(child);
    const startupDeadline = Date.now() + cfg.startupTimeoutMs;
    let running = true;
    restartAttempt += 1;

    const startupProbe = async () => {
      while (!stopRequested && Date.now() < startupDeadline) {
        const probe = await runProbe(cfg.healthUrl, cfg.healthCmd, cfg.probeTimeoutMs);
        if (probe.ok) {
          return true;
        }
        if (probe.source === "none") {
          return true;
        }

        log(cfg.name, `startup probe failed (${probe.source}): ${probe.detail}`);
        const waited = Promise.race([
          childExitPromise,
          new Promise((r) => setTimeout(r, cfg.probeIntervalMs)),
        ]);
        const exitResult = await waited;
        if (exitResult && typeof exitResult === "object" && "code" in exitResult) {
          return false;
        }
      }
      return false;
    };

    const bootOk = await startupProbe();
    if (!bootOk) {
      const reason = "startup probe timeout or child exited";
      log(cfg.name, `${reason}, restarting in ${cfg.restartDelayMs}ms`);
      await shutdownChild(child, cfg.gracefulStopTimeoutMs, cfg.name);
      if (cfg.pidFile) {
        clearPid(cfg.pidFile);
      }
      if (stopRequested) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, cfg.restartDelayMs));
      continue;
    }

    log(cfg.name, `startup healthy (attempt ${restartAttempt})`);

    while (!stopRequested) {
      const tick = new Promise((resolve) => setTimeout(resolve, cfg.probeIntervalMs));
      const next = await Promise.race([childExitPromise, tick]);
      if (next && typeof next === "object" && "code" in next) {
        running = false;
        break;
      }

      const probe = await runProbe(cfg.healthUrl, cfg.healthCmd, cfg.probeTimeoutMs);
      if (!probe.ok) {
        log(cfg.name, `runtime probe failed (${probe.source}): ${probe.detail}`);
        running = false;
        break;
      }
    }

    if (!running || stopRequested) {
      await shutdownChild(child, cfg.gracefulStopTimeoutMs, cfg.name);
      if (cfg.pidFile) {
        clearPid(cfg.pidFile);
      }

      if (stopRequested) {
        break;
      }

      log(cfg.name, `restarting in ${cfg.restartDelayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, cfg.restartDelayMs));
      continue;
    }
  }
}

await main();
