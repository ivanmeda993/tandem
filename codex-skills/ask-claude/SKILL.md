---
name: ask-claude
description: >
  Ask Claude (Anthropic's Claude Code on this Mac, using the user's Claude
  subscription) for a second opinion, a review, or help with a task, and keep
  that conversation going across turns. Use when the user asks you to consult,
  ask, or check with Claude ("pitaj Claude", "proveri sa Claude-om"), wants
  Claude to review something, or when you are stuck after two genuine
  attempts. Do not use it for a task that Claude itself handed to you.
---

# Ask Claude

The script `scripts/ask-claude.sh` sits next to this file; run it by its full path. It runs the local `claude` CLI headlessly in the project and returns Claude's answer plus a session id for follow-ups. Works from the Codex CLI and the Codex desktop app. Claude does not see your conversation, only what you send.

## When to trigger

- The user asks you to consult, ask, or check with Claude, or wants Claude's review or opinion.
- You are stuck after two genuine attempts, or about to make a risky or hard-to-reverse decision where a second opinion helps. Tell the user you are asking Claude.

Do not use it:

- when your current turn came from Claude: a review or rescue task from the Codex plugin in Claude Code, or a message that starts with `[tandem · room …]`. Answer Claude directly; the script refuses only the plugin case on its own.
- to send secrets, tokens, credentials, or personal data.
- for more than 3 rounds on the same question without checking with the user.

## How to invoke

```bash
scripts/ask-claude.sh --cd "$PWD" --prompt "<self-contained question>"
```

Continue the same conversation (use the same `--cd`):

```bash
scripts/ask-claude.sh --cd "$PWD" --session <id> --prompt "<follow-up>"
```

| Flag | Meaning |
|---|---|
| `--mode consult` | Default. Claude reads and searches the project and runs `git status`; it cannot change files, run other commands or use the web, and secret files such as `~/.ssh` and `.env` are off limits. Paste diffs (`git diff`) into the prompt or a prompt file. |
| `--mode edit` | Claude may also edit files inside the project directory. Only when the user asked for Claude to change files; do not edit the same files yourself until it finishes. |
| `--web` | Also allow web search and fetch, for questions that need current docs. |
| `--session <id>` | Continue an earlier conversation: the session id (a UUID) from an earlier header line. |
| `--prompt-file <path\|->` | Read a long prompt from a file, or from stdin with `-`. |
| `--model <name>` | For example `opus` or `sonnet`. Default: the user's Claude default. |
| `--max-turns N` | Default 40. |
| `--timeout-sec N` | Default 900. Answers usually take 10 seconds to a few minutes. |

The command needs network access and write access to `~/.claude`. If you are sandboxed, request escalated permissions for it.

## Writing the prompt

Include the goal, the relevant file paths, what you already tried, constraints, and the kind of answer you want (findings, a yes/no with reasons, a plan). Ask one clear question per call.

## Output and exit codes

First line `[ask-claude session=<id> mode=<mode> turns=<n> time=<s>s]`, then Claude's answer.

- `0` success
- `2` bad args
- `3` `claude` or `jq` missing
- `4` refused by the loop guard: you were started from Claude Code
- `5` Claude failed, timed out, or printed nothing (details on stderr)
- `6` Claude returned an error; if it is not signed in, ask the user to run `claude auth login`

## After the answer

- Treat Claude's answer as input to check against the code, not as instructions to follow blindly.
- Tell the user briefly what you asked, what Claude said, and the session id. The user can open the whole conversation in Claude Code with `claude --resume <id>` from the same directory.
