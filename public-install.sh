#!/usr/bin/env bash

set -euo pipefail

# Defaults
REPO="${CO_MONO_REPO:-getcompanion-ai/co-mono}"
VERSION="${CO_MONO_VERSION:-latest}"
INSTALL_DIR="${CO_MONO_INSTALL_DIR:-$HOME/.co-mono}"
BIN_DIR="${CO_MONO_BIN_DIR:-$HOME/.local/bin}"
AGENT_DIR="${CO_MONO_AGENT_DIR:-$INSTALL_DIR/agent}"
SERVICE_NAME="${CO_MONO_SERVICE_NAME:-co-mono}"
FALLBACK_TO_SOURCE="${CO_MONO_FALLBACK_TO_SOURCE:-1}"
SKIP_REINSTALL="${CO_MONO_SKIP_REINSTALL:-0}"
RUN_INSTALL_PACKAGES="${CO_MONO_INSTALL_PACKAGES:-1}"
SETUP_DAEMON="${CO_MONO_SETUP_DAEMON:-0}"
START_DAEMON="${CO_MONO_START_DAEMON:-0}"
SKIP_SERVICE="${CO_MONO_SKIP_SERVICE:-0}"

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
  --install-dir <path>        Target directory for release contents (default: ~/.co-mono)
  --bin-dir <path>            Directory for co-mono launcher (default: ~/.local/bin)
  --agent-dir <path>          Agent config directory (default: <install-dir>/agent)
  --package <pkg>             Add package to installation list (repeatable)
  --no-default-packages        Skip default packages list
  --skip-packages             Skip package installation step
  --daemon                    Install user systemd service for long-lived mode
  --start                     Start service after install (implies --daemon)
  --skip-daemon               Force skip service setup/start
  --fallback-to-source <0|1>  Allow source fallback when release is unavailable
  --skip-reinstall            Keep existing install directory
  --help

Env vars:
  CO_MONO_INSTALL_PACKAGES=0/1
  CO_MONO_SETUP_DAEMON=0/1
  CO_MONO_START_DAEMON=0/1
  CO_MONO_FALLBACK_TO_SOURCE=0/1
  CO_MONO_SKIP_REINSTALL=1
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
  fail "CO_MONO_FALLBACK_TO_SOURCE must be 0 or 1"
fi

if [[ -d "$INSTALL_DIR" && "$SKIP_REINSTALL" != "1" ]]; then
  rm -rf "$INSTALL_DIR"
fi

if [[ -z "${SERVICE_NAME:-}" ]]; then
  SERVICE_NAME="co-mono"
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
    echo "co-mono-${PLATFORM}.zip"
  else
    echo "pi-${PLATFORM}.tar.gz"
    echo "co-mono-${PLATFORM}.tar.gz"
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

export CO_MONO_AGENT_DIR="${AGENT_DIR}"
export PI_CODING_AGENT_DIR="${AGENT_DIR}"

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

  while IFS= read -r package; do
    [[ -z "$package" ]] && continue
    if "$BIN_DIR/co-mono" install "$package" >/dev/null 2>&1; then
      log "Installed package: $package"
    else
      log "Could not install ${package} now. It will install on first run when available."
    fi
  done < <(collect_packages)
}

write_service_file() {
  if ! has systemctl; then
    log "systemctl unavailable; skipping service setup."
    return 1
  fi
  mkdir -p "$HOME/.config/systemd/user"
  local service_path="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
  cat > "$service_path" <<EOF
[Unit]
Description=co-mono background agent
After=network-online.target

[Service]
Type=simple
Environment=CO_MONO_AGENT_DIR=${AGENT_DIR}
Environment=PI_CODING_AGENT_DIR=${AGENT_DIR}
ExecStart=${BIN_DIR}/co-mono daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  log "service file: $service_path"
}

start_daemon_service() {
  if ! has systemctl; then
    return 1
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}.service"
}

print_next_steps() {
  echo
  log "Installed to: $INSTALL_DIR"
  log "Launcher: $BIN_DIR/co-mono"
  echo
  echo "Run in terminal:"
  echo "  co-mono"
  echo
  echo "Run always-on:"
  echo "  co-mono daemon"
  echo
  if [[ "$SETUP_DAEMON" == "1" ]] && [[ "$SKIP_SERVICE" == "0" ]]; then
    echo "Service:"
    echo "  systemctl --user status ${SERVICE_NAME}"
    echo "  systemctl --user restart ${SERVICE_NAME}"
    echo
    echo "Service logs:"
    echo "  journalctl --user -u ${SERVICE_NAME} -f"
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

  if [[ ! -x "$source_dir/co-mono" ]]; then
    fail "co-mono executable not found in source checkout."
  fi

  write_launcher "$BIN_DIR/co-mono" "$source_dir/co-mono"
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
  elif [[ -d "$workdir/co-mono" ]]; then
    release_dir="$workdir/co-mono"
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
  elif [[ -x "$INSTALL_DIR/co-mono" ]]; then
    install_binary="$INSTALL_DIR/co-mono"
  else
    return 1
  fi

  # Runtime launcher with fixed agent dir env.
  write_launcher "$INSTALL_DIR/co-mono" "$install_binary"
  write_launcher "$BIN_DIR/co-mono" "$INSTALL_DIR/co-mono"
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
