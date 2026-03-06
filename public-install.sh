#!/usr/bin/env bash

set -euo pipefail

REPO="${CO_MONO_REPO:-getcompanion-ai/co-mono}"
VERSION="${CO_MONO_VERSION:-latest}"
INSTALL_DIR="${CO_MONO_INSTALL_DIR:-$HOME/.co-mono}"
BIN_DIR="${CO_MONO_BIN_DIR:-$HOME/.local/bin}"
AGENT_DIR="${CO_MONO_AGENT_DIR:-$INSTALL_DIR/agent}"
RUN_INSTALL_PACKAGES="${CO_MONO_INSTALL_PACKAGES:-1}"
SKIP_REINSTALL="${CO_MONO_SKIP_REINSTALL:-0}"
INSTALL_RUNTIME_DAEMON="${CO_MONO_INSTALL_RUNTIME_DAEMON:-0}"

DEFAULT_PACKAGES=(
  "npm:@e9n/pi-channels"
  "npm:pi-memory-md"
  "npm:pi-teams"
)

log() {
  echo "==> $*"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "required tool not found: $1"
  fi
}

need tar

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  fail "required tool not found: curl or wget"
fi

if ! command -v git >/dev/null 2>&1; then
  log "git not found; this is fine unless package install is triggered"
fi

if [[ -d "$INSTALL_DIR" && "${SKIP_REINSTALL}" != "1" ]]; then
  rm -rf "$INSTALL_DIR"
fi

detect_platform() {
  local os
  local arch

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux) os="linux" ;;
    mingw*|msys*|cygwin*)
      os="windows"
      ;;
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

download_json() {
  local url="$1"
  local out="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    fail "neither curl nor wget is available"
  fi
}

resolve_release_tag() {
  if [[ "$VERSION" != latest ]]; then
    echo "$VERSION"
    return
  fi

  local api_json
  api_json="$(mktemp)"
  download_json "https://api.github.com/repos/${REPO}/releases/latest" "$api_json"
  TAG="$(awk -F '"tag_name": "' 'index($0, "\"tag_name\"") { split($2, a, "\""); print a[1] }' "$api_json" | head -n 1)"
  rm -f "$api_json"

  if [[ -z "$TAG" ]]; then
    fail "could not determine latest tag from GitHub API"
  fi

  echo "$TAG"
}

platform_asset() {
  if [[ "$PLATFORM" == windows-* ]]; then
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
    if ! command -v unzip >/dev/null 2>&1; then
      fail "unzip not found for windows archive"
    fi
    unzip -q "$archive" -d "$out_dir"
  else
    tar -xzf "$archive" -C "$out_dir"
  fi
}

ensure_agent_settings() {
  mkdir -p "$AGENT_DIR"

  local settings_file="$AGENT_DIR/settings.json"
  if [[ -f "$settings_file" ]]; then
    return
  fi

  cat > "$settings_file" <<'EOF'
{
  "packages": [
    "npm:@e9n/pi-channels",
    "npm:pi-memory-md",
    "npm:pi-teams"
  ]
}
EOF
}

maybe_install_packages() {
  if [[ "$RUN_INSTALL_PACKAGES" == "0" ]]; then
    return
  fi

  if ! command -v npm >/dev/null 2>&1; then
    log "npm not found. Skipping package installation (settings.json was still written)."
    return
  fi

  for pkg in "${DEFAULT_PACKAGES[@]}"; do
    if [[ -n "$CO_MONO_BIN_PATH" ]]; then
      log "Installing package: $pkg"
      if ! PI_CODING_AGENT_DIR="$AGENT_DIR" CO_MONO_AGENT_DIR="$AGENT_DIR" "$CO_MONO_BIN_PATH" install "$pkg" >/dev/null 2>&1; then
        log "Could not install $pkg now. It will be installed on first run if network/API access is available."
      fi
    fi
  done
}

write_launcher() {
  mkdir -p "$BIN_DIR"
  local launcher="$BIN_DIR/co-mono"
  cat > "$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$INSTALL_DIR"
AGENT_DIR="$AGENT_DIR"

export CO_MONO_AGENT_DIR="${AGENT_DIR}"
export PI_CODING_AGENT_DIR="${AGENT_DIR}"

exec "\$ROOT_DIR/pi" "\$@"
EOF
  chmod +x "$launcher"
}

print_next_steps() {
  echo
  log "Installed co-mono to: $INSTALL_DIR"
  log "Launcher created: $BIN_DIR/co-mono"
  echo
  echo "Add to PATH if needed:"
  echo "  export PATH=\"$BIN_DIR:$PATH\""
  echo
  echo "Run:"
  echo "  co-mono"
  echo
  echo "You can override settings directory with PI_CODING_AGENT_DIR/CO_MONO_AGENT_DIR."
  echo
}

main() {
  detect_platform
  TAG="$(resolve_release_tag)"

  local asset
  local url
  local archive
  local workdir

  asset="$(platform_asset)"
  url="https://github.com/${REPO}/releases/download/${TAG}/${asset}"

  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT

  archive="$workdir/$asset"
  log "Downloading ${REPO} ${TAG} (${PLATFORM})"
  download_json "$url" "$archive"

  log "Extracting archive"
  extract_archive "$archive" "$workdir"

  mkdir -p "$INSTALL_DIR"
  if [[ -d "$workdir/pi" ]]; then
    rm -rf "$INSTALL_DIR"/*
    cp -R "$workdir/pi/." "$INSTALL_DIR/"
  else
    fail "release asset did not contain expected pi directory"
  fi

  if [[ ! -x "$INSTALL_DIR/pi" ]]; then
    fail "co-mono binary not found at $INSTALL_DIR/pi"
  fi

  ensure_agent_settings
  write_launcher

  export CO_MONO_BIN_PATH="$INSTALL_DIR/pi"
  maybe_install_packages

  if [[ "$INSTALL_RUNTIME_DAEMON" == "1" ]]; then
    log "Runtime-daemon helper is not bundled in this binary distribution."
    log "Use a process supervisor or an external runtime wrapper to keep services up."
  fi

  print_next_steps
}

main
