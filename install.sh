#!/usr/bin/env sh
set -eu

INSTALL_DIR="${MT_NODE_INSTALL_DIR:-$HOME/.machine-tube/mt-node}"
BRANCH="${MT_NODE_BRANCH:-main}"
BIN_DIR="${MT_NODE_BIN_DIR:-$HOME/.local/bin}"
INBOX_DIR="${MT_NODE_INBOX_DIR:-$HOME/MachineTube/videos}"
MT_NODE_MODE="${MT_NODE_MODE:-local}"
WRAPPER_PATH="$BIN_DIR/mt-node"
CONFIG_ENV_PATH="$INSTALL_DIR/config.env"
TMP_DIR=""
PRESERVE_DIR=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -n "$PRESERVE_DIR" ] && [ -d "$PRESERVE_DIR" ]; then
    rm -rf "$PRESERVE_DIR"
  fi
}
trap cleanup EXIT INT TERM

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "mt-node install error: missing required command '$1'" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd node
need_cmd npm
need_cmd tar

if [ "$MT_NODE_MODE" = "docker" ]; then
  need_cmd docker
fi

mkdir -p "$BIN_DIR"
mkdir -p "$INBOX_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"

preserve_runtime_state() {
  PRESERVE_DIR="$(mktemp -d)"
  if [ -f "$CONFIG_ENV_PATH" ]; then
    mv "$CONFIG_ENV_PATH" "$PRESERVE_DIR/config.env"
  fi
  if [ -d "$INSTALL_DIR/data" ]; then
    mv "$INSTALL_DIR/data" "$PRESERVE_DIR/data"
  fi
}

restore_runtime_state() {
  if [ -f "$PRESERVE_DIR/config.env" ]; then
    mv "$PRESERVE_DIR/config.env" "$CONFIG_ENV_PATH"
  fi
  if [ -d "$PRESERVE_DIR/data" ]; then
    rm -rf "$INSTALL_DIR/data"
    mv "$PRESERVE_DIR/data" "$INSTALL_DIR/data"
  fi
}

TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="$TMP_DIR/mt-node.tar.gz"
EXTRACT_DIR="$TMP_DIR/extract"
echo "Downloading mt-node source archive"
curl -fsSL "https://github.com/enigmind-ai/machine-tube-node/archive/refs/heads/$BRANCH.tar.gz" -o "$ARCHIVE_PATH"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
if [ -d "$INSTALL_DIR" ]; then
  echo "Replacing mt-node install in $INSTALL_DIR"
  preserve_runtime_state
  rm -rf "$INSTALL_DIR"
else
  echo "Installing mt-node into $INSTALL_DIR"
fi
mv "$EXTRACT_DIR/machine-tube-node-$BRANCH" "$INSTALL_DIR"
if [ -n "$PRESERVE_DIR" ] && [ -d "$PRESERVE_DIR" ]; then
  restore_runtime_state
fi

cd "$INSTALL_DIR"

echo "Installing npm dependencies"
if [ -f package-lock.json ]; then
  npm ci --include=dev
else
  npm install --include=dev
fi

echo "Building mt-node"
npm run build

echo "Creating default mt-node config file"
node "$INSTALL_DIR/dist/index.js" config init

echo "Preparing managed media tools"
node "$INSTALL_DIR/scripts/bootstrap-media-tools.mjs"

cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env sh
set -eu
exec node "$INSTALL_DIR/dist/index.js" "\$@"
EOF
chmod +x "$WRAPPER_PATH"

mkdir -p "$INSTALL_DIR/data"

if [ "$MT_NODE_MODE" = "docker" ]; then
  echo "Launching mt-node in Docker mode"
  node "$INSTALL_DIR/scripts/run-mt-node-docker.mjs"
  cat <<EOF
mt-node installed successfully.

Install directory: $INSTALL_DIR
Launcher: $WRAPPER_PATH
Config file: $CONFIG_ENV_PATH
MachineTube inbox: $INBOX_DIR
Mode: docker
Peer delivery default: assist

mt-node was launched as its own Docker container.
Drop videos into the inbox folder and point OpenClaw at:
  http://host.docker.internal:43110

To enable restart-restored seeding, edit:
  $CONFIG_ENV_PATH
and set:
  MT_NODE_PEER_DELIVERY_MODE=permanent

For built-in thumbnail and HLS output, mt-node can manage FFmpeg itself. See:
  $INSTALL_DIR/README.md
EOF
else
  cat <<EOF
mt-node installed successfully.

Install directory: $INSTALL_DIR
Launcher: $WRAPPER_PATH
Config file: $CONFIG_ENV_PATH
MachineTube inbox: $INBOX_DIR
Mode: local
Peer delivery default: assist

For local/host installs, the inbox folder is ready to use directly.
Drop videos into the inbox folder, then start mt-node and publish the latest or a named inbox file.

To enable restart-restored seeding, edit:
  $CONFIG_ENV_PATH
and set:
  MT_NODE_PEER_DELIVERY_MODE=permanent

For built-in thumbnail and HLS output, mt-node can manage FFmpeg itself. See:
  $INSTALL_DIR/README.md

Make sure $BIN_DIR is on PATH, then run:
  mt-node
EOF
fi
