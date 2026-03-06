<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="pi logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/getcompanion-ai/co-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/getcompanion-ai/co-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# Co-Mono

> **Looking for the pi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and managing LLM deployments.

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-mom](packages/mom)** | Slack bot that delegates messages to the pi coding agent |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/pi-pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Install

### Public (binary)

Use this for users on production machines where you don't want to expose source:

```bash
curl -fsSL https://raw.githubusercontent.com/getcompanion-ai/co-mono/main/public-install.sh | bash
```

Then run:

```bash
co-mono
```

The installer downloads the latest release archive, writes a launcher to
`~/.local/bin/co-mono`, and creates a private agent settings directory at
`~/.co-mono/agent/settings.json` with remote packages.

Preinstalled package sources are:

```json
[
  "npm:@e9n/pi-channels",
  "npm:pi-memory-md",
  "npm:pi-teams"
]
```

If `npm` is available, it also tries to install these packages during install.

If a release has not been published yet, the installer can fallback to a source checkout automatically. Set this explicitly with:

```bash
CO_MONO_FALLBACK_TO_SOURCE=1 curl -fsSL https://raw.githubusercontent.com/getcompanion-ai/co-mono/main/public-install.sh | bash
```

### Keep it running

Start and keep `co-mono` alive with your process supervisor of choice (systemd, launchd, supervisor, Docker, etc).

For public installs, a minimal systemd user service is:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/co-mono.service <<'EOF'
[Unit]
Description=co-mono
After=network-online.target

[Service]
Type=simple
Environment=PI_CODING_AGENT_DIR=%h/.co-mono/agent
Environment=CO_MONO_AGENT_DIR=%h/.co-mono/agent
ExecStart=%h/.local/bin/co-mono
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now co-mono
```

### Local (source)

```bash
git clone https://github.com/getcompanion-ai/co-mono.git
cd co-mono
./install.sh
```

Run:

```bash
./co-mono
```

Run with built-in runtime watchdog:

```bash
CO_MONO_RUNTIME_COMMAND="python -m http.server 8765" \
  ./co-mono --with-runtime-daemon
```

For a user systemd setup, create `~/.config/systemd/user/co-mono.service` with:

```ini
[Unit]
Description=co-mono
After=network-online.target

[Service]
Type=simple
Environment=PI_CODING_AGENT_DIR=%h/.co-mono/agent
Environment=CO_MONO_AGENT_DIR=%h/.co-mono/agent
ExecStart=/absolute/path/to/repo/co-mono --with-runtime-daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now co-mono
```

Optional:

```bash
npm run build   # build all packages
npm run check   # lint/format/typecheck
```

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
