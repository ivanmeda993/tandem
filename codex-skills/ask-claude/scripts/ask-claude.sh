#!/usr/bin/env bash
# Ask Claude for help on behalf of Codex. Runs the local Claude Code CLI (the
# unmodified `claude` binary, signed in with the user's Claude subscription)
# headlessly in the project directory, prints Claude's answer, and prints a
# session id that continues the same conversation.
#
# Consult mode (default) lets Claude read and search the project and run
# `git status`; it cannot change files, run other commands or use the web
# (add --web for web search and fetch). Edit mode also lets it edit files
# inside the project directory. Inside the call there are no MCP servers and
# no hooks, and the Codex plugin is switched off, so Claude cannot hand the
# question back to Codex.
#
# Usage:
#   ask-claude.sh --prompt "<text>" [--cd <dir>] [--session <id>]
#                 [--mode consult|edit] [--web] [--model <name>]
#                 [--max-turns N] [--timeout-sec N]
#   ask-claude.sh --prompt-file <path|-> ...   (- reads the prompt from stdin)
#
# Output: a header line
#   [ask-claude session=<id> mode=<mode> turns=<n> time=<s>s]
# followed by Claude's answer. Continue with --session <id> and the same --cd.
#
# Exit codes:
#   0 success
#   2 bad args
#   3 required CLI missing (claude / jq)
#   4 refused: running inside a process that Claude Code started (loop guard)
#   5 claude failed, timed out, or printed no result
#   6 Claude answered with an error (not signed in: run `claude auth login`)

set -euo pipefail

# The Codex desktop app can start commands with a minimal PATH (and macOS
# bash 3.2): keep the caller's PATH first, then fall back to common installs.
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"

PROMPT=""
PROMPT_FILE=""
CD_DIR="$PWD"
SESSION=""
MODE="consult"
WEB=0
MODEL=""
MAX_TURNS=40
TIMEOUT_SEC=900

need_value() { [[ -n "${2:-}" ]] || { echo "Missing value for $1" >&2; exit 2; }; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt)      need_value "$@"; PROMPT="$2"; shift 2 ;;
    --prompt-file) need_value "$@"; PROMPT_FILE="$2"; shift 2 ;;
    --cd)          need_value "$@"; CD_DIR="$2"; shift 2 ;;
    --session)     need_value "$@"; SESSION="$2"; shift 2 ;;
    --mode)        need_value "$@"; MODE="$2"; shift 2 ;;
    --web)         WEB=1; shift ;;
    --model)       need_value "$@"; MODEL="$2"; shift 2 ;;
    --max-turns)   need_value "$@"; MAX_TURNS="$2"; shift 2 ;;
    --timeout-sec) need_value "$@"; TIMEOUT_SEC="$2"; shift 2 ;;
    -h|--help)     sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ "$MODE" == consult || "$MODE" == edit ]] || { echo "--mode must be consult or edit" >&2; exit 2; }
[[ "$MAX_TURNS" =~ ^[1-9][0-9]*$ ]] || { echo "--max-turns must be a positive whole number" >&2; exit 2; }
[[ "$TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]] || { echo "--timeout-sec must be a positive whole number" >&2; exit 2; }
# Session ids are UUIDs; anything else could reach claude as an extra flag.
[[ -z "$SESSION" || "$SESSION" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] \
  || { echo "--session must be a session id (a UUID) from an earlier answer" >&2; exit 2; }
[[ -z "$PROMPT" || -z "$PROMPT_FILE" ]] || { echo "Use either --prompt or --prompt-file, not both" >&2; exit 2; }
if [[ "$PROMPT_FILE" == "-" ]]; then
  PROMPT="$(cat)"
elif [[ -n "$PROMPT_FILE" ]]; then
  [[ -f "$PROMPT_FILE" ]] || { echo "Prompt file not found: $PROMPT_FILE" >&2; exit 2; }
  PROMPT="$(cat -- "$PROMPT_FILE")"
fi
# A pattern match, not a substitution: bash 3.2 takes minutes on long prompts otherwise.
[[ $PROMPT == *[![:space:]]* ]] || { echo "Missing --prompt or --prompt-file" >&2; exit 2; }
cd -- "$CD_DIR" 2>/dev/null || { echo "Cannot cd to: $CD_DIR" >&2; exit 2; }

# Claude Code sets CLAUDECODE=1 in every process it starts. A Codex run that
# Claude started must answer Claude directly instead of calling it back.
if [[ -n "${CLAUDECODE:-}" && -z "${ASK_CLAUDE_ALLOW_NESTED:-}" ]]; then
  echo "Refusing: this Codex run was started from Claude Code. Answer Claude directly instead of calling it back." >&2
  echo "If this is wrong, rerun with ASK_CLAUDE_ALLOW_NESTED=1." >&2
  exit 4
fi

command -v claude >/dev/null || { echo "claude CLI not found. Install Claude Code, then run: claude auth login" >&2; exit 3; }
command -v jq >/dev/null || { echo "jq not found. Install it with: brew install jq" >&2; exit 3; }

SYSTEM_PROMPT="You are being consulted by Codex, OpenAI's coding agent, which works in this project for the same user. Codex reads your reply and acts on it; the user is not watching this conversation live. Answer Codex directly and concretely, cite file paths and line numbers where they help, say when you are unsure, and do not hand the work back to Codex."
# Consult: read and search only. `git diff/log/show` are left out because
# their --output option writes files; Codex can paste diffs into the prompt.
READ_TOOLS=(Read Grep Glob "Bash(git status:*)")
DENY=(NotebookEdit "Read(~/.ssh/**)" "Read(~/.aws/**)" "Read(~/.codex/auth.json)" "Read(~/.claude/.credentials.json)" "Read(**/.env)" "Read(**/.env.*)")
if (( WEB )); then
  READ_TOOLS+=(WebSearch WebFetch)
else
  DENY+=(WebSearch WebFetch)
fi
ARGS=(-p --output-format json --max-turns "$MAX_TURNS" --strict-mcp-config
  --settings '{"disableAllHooks":true,"enabledPlugins":{"codex@openai-codex":false}}')

if [[ "$MODE" == edit ]]; then
  # acceptEdits approves edits inside the working directory only; no blanket Edit/Write rule.
  SYSTEM_PROMPT+=" You may edit files in this project, but you cannot run shell commands other than git status. End with the list of files you changed."
  ARGS+=(--permission-mode acceptEdits --allowedTools "${READ_TOOLS[@]}" --disallowedTools "${DENY[@]}")
else
  SYSTEM_PROMPT+=" This is consult mode: read and search the project, but do not change any files."
  ARGS+=(--permission-mode default --allowedTools "${READ_TOOLS[@]}" --disallowedTools Edit Write "${DENY[@]}")
fi
ARGS+=(--append-system-prompt "$SYSTEM_PROMPT")

if [[ -n "$SESSION" ]]; then
  ARGS+=(--resume "$SESSION")
else
  # Cut by characters, not bytes, so a title never ends inside č or ć.
  TITLE="$(printf '%s' "$PROMPT" | perl -CS -0777 -ne 's/\s+/ /g; s/^ //; print substr($_, 0, 60)')"
  ARGS+=(--name "Codex → Claude: $TITLE")
fi
if [[ -n "$MODEL" ]]; then
  ARGS+=(--model "$MODEL")
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ask-claude.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

# perl's alarm survives exec, so claude gets SIGALRM (status 142) at the deadline.
set +e
printf 'Message from Codex:\n\n%s\n' "$PROMPT" \
  | perl -e 'alarm shift @ARGV; exec @ARGV or die "exec failed: $!\n"' "$TIMEOUT_SEC" claude "${ARGS[@]}" \
    >"$TMP_DIR/out.json" 2>"$TMP_DIR/err.log"
STATUS=$?
set -e

if ! jq -e 'type == "object"' "$TMP_DIR/out.json" >/dev/null 2>&1; then
  if [[ $STATUS -eq 142 ]]; then
    echo "Claude did not finish within ${TIMEOUT_SEC}s." >&2
  else
    echo "claude exited with status $STATUS and printed no result." >&2
  fi
  tail -n 20 "$TMP_DIR/err.log" >&2
  exit 5
fi

jq -r --arg mode "$MODE" '
  "[ask-claude session=\(.session_id // "?") mode=\($mode) turns=\(.num_turns // "?") time=\((.duration_ms // 0) / 1000 | floor)s\(if (.subtype // "success") != "success" then " error=\(.subtype)" elif .is_error then " error" else "" end)]",
  (.result // "")
' "$TMP_DIR/out.json"

if jq -e '.is_error == true or (.subtype // "success") != "success"' "$TMP_DIR/out.json" >/dev/null; then
  if jq -e '(.result // "") | test("authenticat|log ?in|oauth"; "i")' "$TMP_DIR/out.json" >/dev/null; then
    echo "Claude is not signed in. Ask the user to run: claude auth login" >&2
  elif jq -e '.subtype == "error_max_turns"' "$TMP_DIR/out.json" >/dev/null; then
    echo "Claude hit --max-turns. Continue with --session and the same --cd, or raise --max-turns." >&2
  fi
  exit 6
fi
