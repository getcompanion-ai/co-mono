# pi-runtime-daemon

Local runtime watchdog for keeping a Python runtime process running.

This package intentionally stays local to the monorepo (`packages/pi-runtime-daemon`) so you can inspect and edit the code directly.

## What this does

- Runs a single command and restarts it on crash.
- Verifies startup health before marking the process healthy.
- Performs recurring health probes and restarts when they fail.
- Writes a PID file.
- Supports graceful shutdown and a small set of flags.

## Usage

```bash
npx pi-runtime-daemon --command "python -m myruntime --serve"
```

```bash
node ./bin/pi-runtime-daemon.mjs \
  --command "python -m myruntime" \
  --health-url "http://127.0.0.1:8765/health" \
  --startup-timeout-ms 30000
```

## Options

- `--command <string>` command run by the daemon (required).
- `--health-url <url>` optional readiness probe URL.
- `--health-cmd <shell command>` optional shell command probe.
- `--startup-timeout-ms <ms>` default: `30000`.
- `--probe-interval-ms <ms>` default: `5000`.
- `--probe-timeout-ms <ms>` default: `2000`.
- `--restart-delay-ms <ms>` default: `1000`.
- `--graceful-stop-timeout-ms <ms>` default: `5000`.
- `--pid-file <path>` optional pidfile path.
- `--name <string>` display name in logs, default: `pi-runtime-daemon`.
- `--env KEY=VALUE` optional repeated process env overrides.
- `--help` prints usage.

## Script integration

From this repo run:

```bash
npm install
npx pi-runtime-daemon --help
```
