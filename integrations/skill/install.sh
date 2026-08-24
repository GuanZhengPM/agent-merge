#!/bin/sh
# Install the agent-merge skill for every agent that speaks the Agent Skills
# open standard (https://agentskills.io): Claude Code, Codex CLI, pi, Gemini
# CLI, Cursor, OpenCode, and others.
#
#   ./install.sh            install for the current user (~/.claude, ~/.agents)
#   ./install.sh project    install into the current repository (.claude, .agents)
set -eu

SOURCE="$(CDPATH='' cd -- "$(dirname -- "$0")/agent-merge" && pwd)"
MODE="${1:-user}"

install_into() {
  dest="$1/agent-merge"
  mkdir -p "$dest"
  cp "$SOURCE/SKILL.md" "$dest/SKILL.md"
  echo "installed -> $dest"
}

case "$MODE" in
  user)
    # Claude Code reads ~/.claude/skills; Codex CLI, pi, Gemini CLI and most
    # other adopters of the standard read ~/.agents/skills.
    install_into "$HOME/.claude/skills"
    install_into "$HOME/.agents/skills"
    ;;
  project)
    install_into ".claude/skills"
    install_into ".agents/skills"
    ;;
  *)
    echo "usage: $0 [user|project]" >&2
    exit 2
    ;;
esac

if ! command -v agent-merge >/dev/null 2>&1; then
  echo "note: the agent-merge CLI is not on PATH yet — install it with: npm install -g agent-merge"
fi
