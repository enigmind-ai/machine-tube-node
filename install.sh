#!/usr/bin/env sh
set -eu

REPO_URL="https://github.com/enigmind-ai/machine-tube-node.git"
INSTALL_DIR="${MT_NODE_INSTALL_DIR:-$HOME/.machine-tube/mt-node}"
BRANCH="${MT_NODE_BRANCH:-main}"
BIN_DIR="${MT_NODE_BIN_DIR:-$HOME/.local/bin}"
INBOX_DIR="${MT_NODE_INBOX_DIR:-$HOME/MachineTube/videos}"
MT_NODE_MODE="${MT_NODE_MODE:-local}"
WRAPPER_PATH="$BIN_DIR/mt-node"
CONFIG_ENV_PATH="$INSTALL_DIR/config.env"
TMP_DIR=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
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

if [ "$MT_NODE_MODE" = "docker" ]; then
  need_cmd docker
fi

mkdir -p "$BIN_DIR"
mkdir -p "$INBOX_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"

if command -v git >/dev/null 2>&1; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating mt-node in $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  else
    rm -rf "$INSTALL_DIR"
    echo "Cloning mt-node into $INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
else
  need_cmd tar
  TMP_DIR="$(mktemp -d)"
  ARCHIVE_PATH="$TMP_DIR/mt-node.tar.gz"
  EXTRACT_DIR="$TMP_DIR/extract"
  echo "Downloading mt-node source archive"
  curl -fsSL "https://github.com/enigmind-ai/machine-tube-node/archive/refs/heads/$BRANCH.tar.gz" -o "$ARCHIVE_PATH"
  mkdir -p "$EXTRACT_DIR"
  tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
  rm -rf "$INSTALL_DIR"
  mv "$EXTRACT_DIR/machine-tube-node-$BRANCH" "$INSTALL_DIR"
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
