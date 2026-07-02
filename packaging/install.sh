#!/bin/sh
# Lumen MCP one-line install.
#
# Usage:
#   sh install.sh              # verify node, npm install seed/, print registration commands
#   sh install.sh --dry-run    # print every command that would run; no side effects
#
# This script never registers the MCP server itself (no `claude mcp add`, no writing
# .cursor/mcp.json). It only prepares the seed/ package and prints the exact command
# for the user to run in their own Claude Code / Cursor setup.

set -eu

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LUMEN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SEED_DIR="$LUMEN_ROOT/seed"
MCP_ENTRY="$SEED_DIR/lumen_mcp.mjs"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

echo "== Lumen MCP install =="
echo "seed dir: $SEED_DIR"

# 1. Verify node >= 20
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] node --version   # require >= v20"
else
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node not found on PATH. Install Node.js >= 20 first." >&2
    exit 1
  fi
  NODE_VERSION=$(node --version | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "ERROR: node $NODE_VERSION found, but Lumen MCP requires node >= 20." >&2
    exit 1
  fi
  echo "node $NODE_VERSION OK"
fi

# 2. npm install in seed/
run sh -c "cd '$SEED_DIR' && npm install --no-audit --no-fund"

# 3. Print registration commands (never executed)
echo ""
echo "== Register the MCP server =="
echo ""
echo "Claude Code:"
echo "  claude mcp add lumen -- node \"$MCP_ENTRY\""
echo ""
echo "Cursor (.cursor/mcp.json):"
cat <<EOF
  {
    "mcpServers": {
      "lumen": {
        "command": "node",
        "args": ["$MCP_ENTRY"]
      }
    }
  }
EOF
echo ""
echo "Done. Run the printed command in your own project to register the server."
