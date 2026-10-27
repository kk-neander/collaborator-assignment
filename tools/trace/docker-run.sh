#!/usr/bin/env bash
# Run split-brain trace inside Docker, for hosts without Node.js 20+.
#   bash tools/trace/docker-run.sh <init|trace|submit> [options]
# (./sb does this automatically when host Node is missing or too old.)
#
# - Uses the repo's own image split-brain-app:local (it has git); builds it with
#   `docker compose build relay` if it is missing. Override with SB_TRACE_IMAGE.
# - Mounts the repo read-write at /app and every AI-tool data folder that exists
#   on this machine read-only, passing each one with the matching --<tool>-dir flag.
# - Passes --host-project-root (the repo path as your tools recorded it) and TZ.
# Compatible with macOS's bash 3.2 (no associative arrays, no mapfile).
set -euo pipefail

die() { printf 'docker-run: %s\n' "$*" >&2; exit 1; }
note() { printf 'docker-run: %s\n' "$*" >&2; }

[ $# -ge 1 ] || die "usage: bash tools/trace/docker-run.sh <init|trace|submit> [options]"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_IMAGE="split-brain-app:local"
IMAGE="${SB_TRACE_IMAGE:-$DEFAULT_IMAGE}"
DOCKER="${SB_TRACE_DOCKER:-docker}"

command -v "$DOCKER" >/dev/null 2>&1 || die "Docker is not installed. Install Docker, or Node.js 20+ to run: node tools/trace/cli.mjs $1"

if ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
  [ "$IMAGE" = "$DEFAULT_IMAGE" ] || die "image $IMAGE not found"
  note "image $IMAGE not found; building it with: docker compose build relay"
  (cd "$REPO_ROOT" && "$DOCKER" compose build relay) || die "could not build $IMAGE (docker compose build relay failed)"
fi

DOCKER_ARGS=()
TOOL_ARGS=()
SEEN="|"
N=0

# add_root <tool> <host dir>: mount an existing dir read-only and pass --<tool>-dir.
add_root() {
  local tool="$1" dir="$2"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  case "$SEEN" in *"|$dir|"*) return 0 ;; esac
  SEEN="$SEEN$dir|"
  case "$dir" in *:*) note "skipping $dir (a ':' in the path cannot be bind-mounted)"; return 0 ;; esac
  N=$((N + 1))
  local target="/sb-src/$tool-$N"
  DOCKER_ARGS+=(-v "$dir:$target:ro")
  TOOL_ARGS+=("--$tool-dir" "$target")
}

# Homes to search: this user's, plus Windows profiles when running under WSL.
HOMES=("$HOME")
if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  for h in /mnt/c/Users/*; do
    case "$(basename "$h")" in Public|Default|"Default User"|"All Users"|desktop.ini) continue ;; esac
    [ -d "$h/AppData" ] && HOMES+=("$h")
  done
fi

EDITOR_APPS=("Code" "Code - Insiders" "VSCodium" "Code - OSS")

add_root claude "${CLAUDE_CONFIG_DIR:-}"
add_root codex "${CODEX_HOME:-}"
[ -n "${XDG_CONFIG_HOME:-}" ] && add_root cursor "$XDG_CONFIG_HOME/Cursor/User"
[ -n "${XDG_DATA_HOME:-}" ] && add_root opencode "$XDG_DATA_HOME/opencode"
for h in "${HOMES[@]}"; do
  add_root claude "$h/.claude"
  add_root claude "$h/.config/claude"
  add_root codex "$h/.codex"
  # Cursor / VS Code: macOS, Linux and Windows (WSL host) layouts.
  for base in "$h/Library/Application Support" "$h/.config" "$h/AppData/Roaming"; do
    add_root cursor "$base/Cursor/User"
    for app in "${EDITOR_APPS[@]}"; do add_root vscode "$base/$app/User"; done
  done
  add_root vscode "$h/.vscode-server/data/User"
  add_root vscode "$h/.vscode-server-insiders/data/User"
  add_root opencode "$h/.local/share/opencode"
  add_root opencode "$h/Library/Application Support/opencode"
  add_root opencode "$h/AppData/Local/opencode"
  add_root gemini "$h/.gemini"
done

# Time zone (Aider logs local wall-clock times).
TZ_NAME="${TZ:-}"
if [ -z "$TZ_NAME" ]; then
  if [ -r /etc/timezone ]; then TZ_NAME="$(head -n 1 /etc/timezone)"; fi
  if [ -z "$TZ_NAME" ] && [ -L /etc/localtime ]; then
    link="$(readlink /etc/localtime || true)"
    case "$link" in *zoneinfo/*) TZ_NAME="${link##*zoneinfo/}" ;; esac
  fi
fi
DOCKER_ARGS+=(-e "TZ=${TZ_NAME:-UTC}")

# Identity defaults from the host's git config (the container has none).
if [ -z "${SB_HANDLE:-}" ] && command -v git >/dev/null 2>&1; then SB_HANDLE="$(git -C "$REPO_ROOT" config user.name 2>/dev/null || true)"; fi
if [ -z "${SB_EMAIL:-}" ] && command -v git >/dev/null 2>&1; then SB_EMAIL="$(git -C "$REPO_ROOT" config user.email 2>/dev/null || true)"; fi
for var in SB_HANDLE SB_EMAIL SUBMIT_URL SUBMIT_INSTRUCTIONS_URL SB_TRACE_MAX_MB SB_TRACE_DEBUG; do
  val="${!var:-}"
  [ -n "$val" ] && DOCKER_ARGS+=(-e "$var=$val")
done

# Interactive prompt (submit) needs a TTY; write files as the host user.
if [ -t 0 ] && [ -t 1 ]; then DOCKER_ARGS+=(-it); fi
if [ "$(uname -s)" = "Linux" ]; then DOCKER_ARGS+=(--user "$(id -u):$(id -g)"); fi

[ "$N" -gt 0 ] || note "no AI-tool data folders found on this machine"

exec "$DOCKER" run --rm \
  -v "$REPO_ROOT:/app" -w /app \
  -e HOME=/tmp -e NODE_NO_WARNINGS=1 \
  ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} \
  --entrypoint node \
  "$IMAGE" \
  tools/trace/cli.mjs "$@" \
  --project-root /app --host-project-root "$REPO_ROOT" \
  ${TOOL_ARGS[@]+"${TOOL_ARGS[@]}"}
