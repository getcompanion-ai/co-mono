#!/usr/bin/env bash

set -euo pipefail

# Defaults
REPO="${PI_REPO:-${CO_MONO_REPO:-getcompanion-ai/co-mono}}"
VERSION="${PI_VERSION:-${CO_MONO_VERSION:-latest}}"
INSTALL_DIR="${PI_INSTALL_DIR:-${CO_MONO_INSTALL_DIR:-$HOME/.pi}}"
BIN_DIR="${PI_BIN_DIR:-${CO_MONO_BIN_DIR:-$HOME/.local/bin}}"
AGENT_DIR="${PI_AGENT_DIR:-${CO_MONO_AGENT_DIR:-$INSTALL_DIR/agent}}"
SERVICE_NAME="${PI_SERVICE_NAME:-${CO_MONO_SERVICE_NAME:-pi}}"
FALLBACK_TO_SOURCE="${PI_FALLBACK_TO_SOURCE:-${CO_MONO_FALLBACK_TO_SOURCE:-1}}"
SKIP_REINSTALL="${PI_SKIP_REINSTALL:-${CO_MONO_SKIP_REINSTALL:-0}}"
RUN_INSTALL_PACKAGES="${PI_INSTALL_PACKAGES:-${CO_MONO_INSTALL_PACKAGES:-1}}"
SETUP_DAEMON="${PI_SETUP_DAEMON:-${CO_MONO_SETUP_DAEMON:-0}}"
START_DAEMON="${PI_START_DAEMON:-${CO_MONO_START_DAEMON:-0}}"
SKIP_SERVICE="${PI_SKIP_SERVICE:-${CO_MONO_SKIP_SERVICE:-0}}"
SERVICE_MANAGER=""
SERVICE_UNIT_PATH=""
SERVICE_LABEL=""
SERVICE_STDOUT_LOG=""
SERVICE_STDERR_LOG=""

DEFAULT_PACKAGES=(
  "npm:@e9n/pi-channels"
  "npm:pi-memory-md"
  "npm:pi-teams"
)

declare -a EXTRA_PACKAGES=()
USE_DEFAULT_PACKAGES=1

log() {
  echo "==> $*"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

resolve_agent_dir() {
  local raw_dir="$1"
  local fallback_dir="$2"

  for candidate in "${raw_dir}" "${fallback_dir}"; do
    candidate="${candidate/#\~/$HOME}"
    [[ "$candidate" != /* ]] && candidate="$PWD/$candidate"
    mkdir -p "$candidate" 2>/dev/null || continue
    if : > "${candidate}/.pi-agent-dir-write-check" 2>/dev/null; then
      rm -f "${candidate}/.pi-agent-dir-write-check" 2>/dev/null || true
      echo "$candidate"; return
    fi
    log "Warning: AGENT_DIR is not writable: ${candidate}"
  done
  fail "Could not create writable AGENT_DIR. Checked ${raw_dir} and ${fallback_dir}."
}

has() {
  command -v "$1" >/dev/null 2>&1
}

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://raw.githubusercontent.com/getcompanion-ai/co-mono/main/public-install.sh | bash
  bash public-install.sh [options]

Options:
  --repo <owner/repo>         Override GitHub repo for install (default: getcompanion-ai/co-mono)
  --version <tag>|latest      Release tag to install (default: latest)
  --install-dir <path>        Target directory for release contents (default: ~/.pi)
  --bin-dir <path>            Directory for pi launcher (default: ~/.local/bin)
  --agent-dir <path>          Agent config directory (default: <install-dir>/agent)
  --package <pkg>             Add package to installation list (repeatable)
  --no-default-packages        Skip default packages list
  --skip-packages             Skip package installation step
  --daemon                    Install user service for long-lived mode
  --start                     Start service after install (implies --daemon)
  --skip-daemon               Force skip service setup/start
  --fallback-to-source <0|1>  Allow source fallback when release is unavailable
  --skip-reinstall            Keep existing install directory
  --help

Env vars:
  PI_INSTALL_PACKAGES=0/1
  PI_SETUP_DAEMON=0/1
  PI_START_DAEMON=0/1
  PI_FALLBACK_TO_SOURCE=0/1
  PI_SKIP_REINSTALL=1
  PI_SERVICE_NAME=<name>
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if ! has tar; then
  fail "required tool not found: tar"
fi
if ! has curl && ! has wget; then
  fail "required tool not found: curl or wget"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:?missing repo value}"
      shift 2
      ;;
    --version)
      VERSION="${2:?missing version value}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:?missing install dir}"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:?missing bin dir}"
      shift 2
      ;;
    --agent-dir)
      AGENT_DIR="${2:?missing agent dir}"
      shift 2
      ;;
    --package)
      EXTRA_PACKAGES+=("${2:?missing package}")
      shift 2
      ;;
    --no-default-packages)
      USE_DEFAULT_PACKAGES=0
      shift
      ;;
    --skip-packages)
      RUN_INSTALL_PACKAGES=0
      shift
      ;;
    --daemon)
      SETUP_DAEMON=1
      shift
      ;;
    --start)
      START_DAEMON=1
      SETUP_DAEMON=1
      shift
      ;;
    --skip-daemon)
      SETUP_DAEMON=0
      START_DAEMON=0
      SKIP_SERVICE=1
      shift
      ;;
    --fallback-to-source)
      FALLBACK_TO_SOURCE="${2:?missing fallback value}"
      shift 2
      ;;
    --skip-reinstall)
      SKIP_REINSTALL=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ "$FALLBACK_TO_SOURCE" != "0" && "$FALLBACK_TO_SOURCE" != "1" ]]; then
  fail "PI_FALLBACK_TO_SOURCE must be 0 or 1"
fi

AGENT_DIR="$(resolve_agent_dir "$AGENT_DIR" "$INSTALL_DIR/agent")"

if [[ -d "$INSTALL_DIR" && "$SKIP_REINSTALL" != "1" ]]; then
  rm -rf "$INSTALL_DIR"
fi

if [[ -z "${SERVICE_NAME:-}" ]]; then
  SERVICE_NAME="pi"
fi

download_file() {
  local url="$1"
  local out="$2"
  if has curl; then
    curl -fsSL "$url" -o "$out"
  else
    wget -qO "$out" "$url"
  fi
}

detect_platform() {
  local os
  local arch

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux) os="linux" ;;
    mingw*|msys*|cygwin*) os="windows" ;;
    *)
      fail "unsupported OS: $os"
      ;;
  esac

  case "$arch" in
    x86_64|amd64)
      arch="x64"
      ;;
    aarch64|arm64)
      arch="arm64"
      ;;
    *)
      fail "unsupported CPU architecture: $arch"
      ;;
  esac

  PLATFORM="${os}-${arch}"
}

resolve_release_tag() {
  if [[ "$VERSION" != "latest" ]]; then
    echo "$VERSION"
    return
  fi

  local api_json
  api_json="$(mktemp)"
  if ! download_file "https://api.github.com/repos/${REPO}/releases/latest" "$api_json"; then
    rm -f "$api_json"
    return 1
  fi

  local tag
  if has jq; then
    tag="$(jq -r '.tag_name // empty' "$api_json")"
  else
    tag="$(awk '/"tag_name":/ { gsub(/[",]/, "", $3); print $3; exit }' "$api_json")"
  fi
  rm -f "$api_json"

  if [[ -z "$tag" || "$tag" == "null" ]]; then
    return 1
  fi
  echo "$tag"
}

platform_assets() {
  if [[ "$PLATFORM" == "windows"* ]]; then
    echo "pi-${PLATFORM}.zip"
  else
    echo "pi-${PLATFORM}.tar.gz"
  fi
}

extract_archive() {
  local archive="$1"
  local out_dir="$2"
  mkdir -p "$out_dir"
  if [[ "$archive" == *.zip ]]; then
    if ! has unzip; then
      fail "unzip required for zip archive"
    fi
    unzip -q "$archive" -d "$out_dir"
  else
    tar -xzf "$archive" -C "$out_dir"
  fi
}

collect_packages() {
  local -a packages=()
  if [[ "$USE_DEFAULT_PACKAGES" == "1" ]]; then
    packages=("${DEFAULT_PACKAGES[@]}")
  fi
  if [[ "${#EXTRA_PACKAGES[@]}" -gt 0 ]]; then
    packages+=("${EXTRA_PACKAGES[@]}")
  fi
  printf '%s\n' "${packages[@]}"
}

write_launcher() {
  local output="$1"
  local runtime_dir="$2"

  mkdir -p "$(dirname "$output")"
  cat > "$output" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export PI_CODING_AGENT_DIR="${AGENT_DIR}"
export CO_MONO_AGENT_DIR="${AGENT_DIR}"

exec "${runtime_dir}" "\$@"
EOF
  chmod +x "$output"
}

ensure_agent_settings() {
  mkdir -p "$AGENT_DIR"
  local settings_file="$AGENT_DIR/settings.json"
  if [[ -f "$settings_file" ]]; then
    return
  fi

  local -a packages
  readarray -t packages < <(collect_packages)
  if [[ "${#packages[@]}" -eq 0 ]]; then
    cat > "$settings_file" <<'EOF'
{
  "packages": []
}
EOF
    return
  fi

  {
    echo "{"
    echo '  "packages": ['
  } > "$settings_file"
  local idx=0
  local total="${#packages[@]}"
  for package in "${packages[@]}"; do
    local suffix=""
    if [[ "$idx" -lt $((total - 1)) ]]; then
      suffix=","
    fi
    printf '    "%s"%s\n' "$package" "$suffix" >> "$settings_file"
    idx=$((idx + 1))
  done
  {
    echo "  ]"
    echo "}"
  } >> "$settings_file"
}

install_packages() {
  if [[ "$RUN_INSTALL_PACKAGES" != "1" ]]; then
    return
  fi

  if ! has npm; then
    log "npm not found. Skipping package installation."
    return
  fi

  local npm_prefix
  local -a npm_env

  npm_prefix="${HOME}/.pi/npm-global"
  npm_env=(
    "NPM_CONFIG_PREFIX=$npm_prefix"
    "npm_config_prefix=$npm_prefix"
    "NODE_PATH=$npm_prefix/lib/node_modules:${NODE_PATH:-}"
    "PATH=$npm_prefix/bin:$PATH"
  )
  mkdir -p "$npm_prefix/bin" "$npm_prefix/lib/node_modules"

  while IFS= read -r package; do
    [[ -z "$package" ]] && continue
    if "${npm_env[@]}" "$BIN_DIR/pi" install "$package" >/dev/null 2>&1; then
      log "Installed package: $package"
    else
      log "Could not install ${package} now. It will install on first run when available."
    fi
  done < <(collect_packages)
}

write_service_file() {
  local uname_s
  uname_s="$(uname -s)"

  if [[ "$uname_s" == "Darwin" ]]; then
    if ! has launchctl; then
      log "launchctl unavailable; skipping service setup."
      return 1
    fi

    mkdir -p "$HOME/Library/LaunchAgents" "$INSTALL_DIR/logs"
    local plist_path="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
    local label="${SERVICE_NAME}"
    local stdout_log="$INSTALL_DIR/logs/${SERVICE_NAME}.out.log"
    local stderr_log="$INSTALL_DIR/logs/${SERVICE_NAME}.err.log"

    cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN_DIR}/pi</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CO_MONO_AGENT_DIR</key>
    <string>${AGENT_DIR}</string>
    <key>PI_CODING_AGENT_DIR</key>
    <string>${AGENT_DIR}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>StandardOutPath</key>
  <string>${stdout_log}</string>
  <key>StandardErrorPath</key>
  <string>${stderr_log}</string>
</dict>
</plist>
EOF

    SERVICE_MANAGER="launchd"
    SERVICE_UNIT_PATH="$plist_path"
    SERVICE_LABEL="$label"
    SERVICE_STDOUT_LOG="$stdout_log"
    SERVICE_STDERR_LOG="$stderr_log"
    log "launch agent: $plist_path"
    return 0
  fi

  if ! has systemctl; then
    log "systemctl unavailable; skipping service setup."
    return 1
  fi

  mkdir -p "$HOME/.config/systemd/user"
  local service_path="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
  cat > "$service_path" <<EOF
[Unit]
Description=pi daemon
After=network-online.target

[Service]
Type=simple
Environment=CO_MONO_AGENT_DIR=${AGENT_DIR}
Environment=PI_CODING_AGENT_DIR=${AGENT_DIR}
ExecStart=${BIN_DIR}/pi daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  SERVICE_MANAGER="systemd"
  SERVICE_UNIT_PATH="$service_path"
  SERVICE_LABEL="${SERVICE_NAME}"
  log "service file: $service_path"
}

start_daemon_service() {
  if [[ "$SERVICE_MANAGER" == "launchd" ]]; then
    local domain_target="gui/$(id -u)"
    launchctl bootout "$domain_target" "$SERVICE_UNIT_PATH" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain_target" "$SERVICE_UNIT_PATH"
    launchctl enable "${domain_target}/${SERVICE_LABEL}"
    launchctl kickstart -k "${domain_target}/${SERVICE_LABEL}"
    return 0
  fi

  if [[ "$SERVICE_MANAGER" == "systemd" ]]; then
    systemctl --user daemon-reload
    systemctl --user enable --now "${SERVICE_NAME}.service"
    return 0
  fi

  return 1
}

print_next_steps() {
  echo
  log "Installed to: $INSTALL_DIR"
  log "Launcher: $BIN_DIR/pi"
  echo
  echo "Run in terminal:"
  echo "  pi"
  echo
  echo "Run always-on:"
  echo "  pi daemon"
  echo
  if [[ "$SETUP_DAEMON" == "1" ]] && [[ "$SKIP_SERVICE" == "0" ]]; then
    if [[ "$SERVICE_MANAGER" == "launchd" ]]; then
      echo "Service:"
      echo "  launchctl print gui/$(id -u)/${SERVICE_LABEL}"
      echo "  launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}"
      echo
      echo "Service logs:"
      echo "  tail -f ${SERVICE_STDOUT_LOG}"
      echo "  tail -f ${SERVICE_STDERR_LOG}"
    elif [[ "$SERVICE_MANAGER" == "systemd" ]]; then
      echo "Service:"
      echo "  systemctl --user status ${SERVICE_NAME}"
      echo "  systemctl --user restart ${SERVICE_NAME}"
      echo
      echo "Service logs:"
      echo "  journalctl --user -u ${SERVICE_NAME} -f"
    fi
  fi
}

bootstrap_from_source() {
  if ! has git; then
    fail "git is required for source fallback."
  fi
  if ! has node; then
    fail "node is required for source fallback."
  fi
  if ! has npm; then
    fail "npm is required for source fallback."
  fi

  local source_dir="$INSTALL_DIR/source"
  local ref="${1:-main}"

  if [[ -d "$source_dir" && "$SKIP_REINSTALL" != "1" ]]; then
    rm -rf "$source_dir"
  fi

  if [[ ! -d "$source_dir" ]]; then
    log "Cloning ${REPO}@${ref}"
    git clone --depth 1 --branch "$ref" "https://github.com/${REPO}.git" "$source_dir"
  fi

  log "Running source install"
  (
    cd "$source_dir"
    CO_MONO_AGENT_DIR="$AGENT_DIR" \
    PI_CODING_AGENT_DIR="$AGENT_DIR" \
      ./install.sh
  )

  if [[ ! -x "$source_dir/pi" ]]; then
    fail "pi executable not found in source checkout."
  fi

  write_launcher "$BIN_DIR/pi" "$source_dir/pi"
  ensure_agent_settings
  install_packages
}

install_from_release() {
  local tag="$1"
  detect_platform
  local workdir
  local url
  local archive
  local downloaded=0

  workdir="$(mktemp -d)"
  while IFS= read -r asset; do
    url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
    archive="$workdir/$asset"
    log "Trying asset: ${asset}"
    if download_file "$url" "$archive"; then
      downloaded=1
      break
    fi
  done < <(platform_assets)

  if [[ "$downloaded" == "0" ]]; then
    rm -rf "$workdir"
    return 1
  fi

  log "Extracting archive"
  extract_archive "$archive" "$workdir"

  local release_dir
  local install_binary
  if [[ -d "$workdir/pi" ]]; then
    release_dir="$workdir/pi"
  elif [[ -f "$workdir/pi" ]]; then
    release_dir="$workdir"
  fi

  if [[ -z "${release_dir:-}" ]]; then
    return 1
  fi

  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR"/*
  cp -R "$release_dir/." "$INSTALL_DIR/"

  if [[ -x "$INSTALL_DIR/pi" ]]; then
    install_binary="$INSTALL_DIR/pi"
  else
    return 1
  fi

  # Runtime launcher with fixed agent dir env.
  local launcher_target="$install_binary"
  if [[ "$install_binary" != "$INSTALL_DIR/pi" ]]; then
    write_launcher "$INSTALL_DIR/pi" "$install_binary"
    launcher_target="$INSTALL_DIR/pi"
  fi
  write_launcher "$BIN_DIR/pi" "$launcher_target"
  ensure_agent_settings
  install_packages
  rm -rf "$workdir"
}

main() {
  local tag
  if ! tag="$(resolve_release_tag)"; then
    if [[ "$FALLBACK_TO_SOURCE" == "1" ]]; then
      log "Could not resolve release tag. Falling back to source."
      bootstrap_from_source "main"
      return
    fi
    fail "could not resolve latest release tag from GitHub API"
  fi

  if [[ -n "$tag" ]]; then
    if ! install_from_release "$tag"; then
      if [[ "$FALLBACK_TO_SOURCE" == "1" ]]; then
        log "Release install failed. Falling back to source."
        if [[ "$VERSION" == "latest" ]]; then
          bootstrap_from_source "main"
        else
          bootstrap_from_source "$VERSION"
        fi
        return
      fi
      fail "release asset unavailable: ${tag}"
    fi
  else
    fail "release tag empty."
  fi
}

main
print_next_steps

if [[ "$SETUP_DAEMON" == "1" && "$SKIP_SERVICE" == "0" ]]; then
  if write_service_file; then
    if [[ "$START_DAEMON" == "1" ]]; then
      start_daemon_service
    fi
  fi
fi
