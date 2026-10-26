# Tandem

Tandem lets Claude Code and Codex talk to each other live, each in the session you already have open. A message from Claude runs in your Codex thread as the next turn, so you watch it happen in the Codex app, and Codex's answer comes straight back into Claude's conversation. A side panel in Claude shows the whole exchange, and you can join in from there.

Tandem is an independent project. It is not made, endorsed or supported by Anthropic or OpenAI. The Claude and Codex icons in its panel are those apps' own icons (`assets/agent-*.png`), shown only to say which agent does what; they belong to their owners. It works with Claude Code and Codex through their own command-line tools, signed in with your own subscriptions.

## Why Tandem

- **Built on the apps you already use, not a new one.** Tandem builds no agent, chat window, editor or sandbox of its own. The work is done by Claude Code and Codex themselves, each with its own models, tools, plugins, MCP servers and sandbox; you watch and write in the Claude and Codex desktop apps; each worker is isolated by a plain git worktree; reviews reach GitHub through `gh`; and notifications are macOS's own. Tandem is the thin layer that connects them, so you keep what each app does best, and their own updates and fixes come with them.
- **Two vendors check each other.** Claude and Codex are trained differently and miss different things. Tandem has one write and the other review, so a bug one model is blind to has a second chance to be caught.
- **Each agent in the app you already use.** Claude's messages run in your Codex thread as new turns, so you watch them live in the Codex app, and Codex's answers come straight back into Claude's conversation. There is nothing new to open and no copying between windows.
- **Parallel work without collisions.** In an orchestrated run, every task gets its own git worktree, branch and Codex thread. Tasks that would change the same files wait for each other, so workers never overwrite one another.
- **You stay in charge.** Workers start only after you approve the plan, and nothing reaches your branch until you click Merge. Tandem never pushes, and every worker turn counts against a budget only you raise.
- **Reviews that hold up.** Codex reviews a pull request, a branch or your uncommitted changes, read-only, against the project's own rules (`AGENTS.md`, `CLAUDE.md`). Claude checks each finding in the code before you hear of it, and only the findings you pick are posted to GitHub.
- **It survives long runs.** A run lives on disk, so a Mac restart, a killed process or Claude compacting its conversation does not lose it, and the orchestrator gets the run's state and its own notes back.
- **Local and on your own plans.** There is no server and no extra account. Everything runs through the official `claude` and `codex` command-line tools, signed in with your own subscriptions.

To try it where nothing is at stake, use the demo project [ivanmeda993/tandem-demo](https://github.com/ivanmeda993/tandem-demo): a tiny reading-list app whose README walks through a conversation, a review of a branch with real bugs, and two orchestrated runs.

## What you get

**In Claude Code** (terminal and the Code tab of the Claude desktop app):

- A **Tandem panel** beside the chat, named for the project, in three tabs. **Orchestrate** starts a run (four steps, from describing the goal to merging) or shows the open one; **Codex chat** starts a Codex thread or continues one of the project's (run workers are left out; a thread with no name shows its first words), each with an Archive button, and shows the conversation as cards in each speaker's color; **Archived** lists the project's archived Codex threads and restores them. A tab's label marks decisions waiting (◆) and work going on (●). Each task, working agent and message carries its agent's app icon (Claude or Codex), so who does what reads at a glance. A run's view leads with what needs you (reviewing the plan, where each task opens to its full brief, acceptance criteria and paths; telling Claude what to change; merging; picking the simplifier's proposals, each shown whole with the exact change on request; a stuck task; a failed task, which you can cancel; more worker turns). **Working now** shows each running agent with a spinner, how long it has worked, the last step it took (its reasoning's title, a command it ran, a tool it used) and its Open in Codex and Stop buttons (Stop on a simplifier skips the simplification and keeps the approved change); an agent with no new step for 8 minutes is marked ⚠, as it may wait for an approval in the Codex app. The run's header meters the worker turns used and the Codex usage limit, which turn to a warning from 80%; from there the header also offers 10 more worker turns, since the orchestrator may ask for them before Tandem refuses it one, and Claude hears of them at once. One bar shows who has each task now (you, Claude or Codex), and the task list reads in plain words in the same order: what needs you, what an agent has, what waits, what failed, with finished tasks folded into one row that opens on request; stopping a task or the run asks first. While the panel has the keyboard (click in it, or ctrl+x tab), keys press the main decisions, each written on its button: `a` approves the plan or applies your picks, `1`–`9` tick proposals, `k` keeps the code as is, `m` merges the one task ready, `o` opens a working agent in Codex; stopping is never a single key. When a run has waited for you for 20 seconds (a plan, a merge, proposals, a stuck or failed task, more worker turns, or a worker with no new step), Tandem notifies you on your Mac, once for each, and not while you are using the panel; the run view turns this off. A conversation's view shows the messages, a field to message Codex yourself, and how many messages Claude and Codex have left before they wait for you; ← All chats goes back to the list while Claude stays connected, Disconnect stops Claude from following the thread, which stays in the Codex app, and Archive thread also archives it. Every button shows what its action came to, and a failure says why. **Open in Codex** opens the conversation's thread, a worker's thread or a Codex orchestrator's thread in the Codex app.
- A **band above the prompt** while a run or a conversation is open: what needs you, by name (`Merge “Login spacing” (+1 more)`), and while Codex works a spinner, the run's progress (`2 of 5 tasks done, 1 working`), the last step a worker took and, from 80% of the Codex usage limit, how much is used.
- Codex's answers arrive as **cards in the conversation** and wake Claude even when the session is idle.
- `/tandem` opens the panel; `/tandem threads`, `/tandem connect <number|id|name>`, `/tandem new [--worktree] <message>`, `/tandem review [PR|branch|commit]`, `/tandem orchestrate <goal>` and `/tandem close` do the rest.
- Tools Claude calls itself: `send`, `connect`, `threads`, `start_codex` (starts a new Codex thread, named and visible in the Codex app, optionally in its own git worktree, and sends it a first message), `review` (has Codex review a change; see "Review" below), `ask_thread` (asks an existing Codex thread through a read-only fork), and the orchestrator's `orch_*` tools.
- **Review**: Codex reviews a pull request, a branch, a commit or your uncommitted changes, read-only, for the bugs the change introduces, how it fits the codebase, tests, security and performance. Claude checks each finding in the code before telling you, and findings reach GitHub only when you post them from the panel; see "Review" below.
- **The orchestrator**: one Claude session plans and reviews while Codex workers build, each task in its own git worktree and Codex thread. You approve the plan and every merge in the panel; see "Orchestrate" below.

**In Codex** (CLI and the Codex desktop app):

- Claude's messages appear in your thread as turns that start with `[tandem · room …]`; Codex answers them like any other turn.
- The `tandem` skill lets Codex start a conversation with Claude, or start a new Claude Code session in the background that joins the thread (`tandem new-claude`), and tells Codex how to work as a worker in an orchestrated run.
- The `ask-claude` skill lets Codex ask Claude for a second opinion, read-only by default.

## Requirements

- macOS (tested on macOS 27); Linux should work but is untested.
- Claude Code 2.1.308 or newer, signed in (`claude auth login`).
- Codex CLI 0.162 or newer with `codex queue`, signed in (`codex login`), and the Codex desktop app if you want to watch threads there.
- Python 3.9 or newer, git, perl, and jq (for `ask-claude`).

## Install

In Claude Code, from a terminal session:

```
/plugin install tandem --marketplace ivanmeda993/tandem
```

or from a shell: `claude plugin install tandem --marketplace ivanmeda993/tandem`. In the Claude desktop app, click + next to the prompt box, then Plugins, Add marketplace with `ivanmeda993/tandem`, then Add plugin.

In Codex:

```
codex plugin marketplace add ivanmeda993/tandem
```

then install Tandem from Plugins in the Codex desktop app, or with `codex plugin add tandem@tandem`.

Check the setup with `codex-skills/tandem/scripts/tandem doctor`. To try Tandem first, clone [the demo project](https://github.com/ivanmeda993/tandem-demo) and follow its README.

## Use

1. In Claude, run `/tandem` and pick a Codex thread of the project, or ask Claude to connect to one.
2. Ask Claude to discuss something with Codex. Each message runs in that thread; each answer comes back to Claude and the panel.
3. Type into the panel to message Codex yourself. Hold messages to Claude keeps Codex's answers (and a run's updates) from Claude until you resume.
4. Disconnect when you are done, or archive the thread.

From Codex, ask it to start a conversation with Claude; then connect Claude to that thread with `/tandem connect`.

### Review

1. Ask Claude to have Codex review a pull request (`review PR 552`), a branch or a commit, or your uncommitted changes; or type the PR number, branch or commit under "Review a change" in the panel's Codex chat tab (or press "Or review your uncommitted changes"), or run `/tandem review 552`.
2. For a pull request, Tandem reads it with `gh` (title, description, CI checks) and fetches its code into a detached worktree, `.tandem/worktrees/review-pr-552`, so your checkout is not touched; a branch or a commit gets one too. A Codex thread named "<project> · Review …" then reads the change in Codex's read-only sandbox. It follows the project's rules (AGENTS.md, CLAUDE.md), reads the code around each change (callers, tests, similar code) and reports each problem it can show from the code: bugs the change introduces, security and performance problems, places that do not fit the codebase (an existing helper, component or token it should reuse, a departure from the conventions around it or from a project rule, code in the wrong layer), missing or toothless tests, and missing follow-through such as migrations or docs. Each finding has a priority (P0 blocks release, P1 must be fixed before merging, P2 soon, P3 minor), its file and lines, and how sure Codex is; the review ends with a verdict on the whole change.
3. The findings come back to Claude, which checks each one in the code and tells you which hold. The panel shows them as a card. Ask Codex about a finding in the same thread, or ask Claude to fix the ones that hold.
4. For a pull request, tick the findings to post and press Post: after you confirm, Tandem posts them as one review on the pull request, with a comment on each finding's lines (or in the review's text, when GitHub cannot place a line). Nothing else reaches GitHub. A later review of the same pull request continues in the same thread, so Codex sees what it found before. Disconnecting the review removes its worktree.

### Orchestrate

1. In Claude, preferably planning on Opus with `/effort max`, run `/tandem orchestrate <what you want built>`.
2. Claude asks how you want the work organized: how many Codex workers at once, their reasoning effort, what they may do (full access like your regular Codex threads, which Figma and other tools that write need; edit only inside their worktree, with or without network; or only read), where they run (in the Codex app, where each worker's thread opens at once and you can watch it and write to it; or in the background), and whether a simplifier goes over approved work.
3. Claude reads the code and proposes tasks, each with a role. Read each task in full in the Tandem panel, then approve the plan or tell Claude what to change.
4. Ready tasks start, up to the number you chose: each worker gets a git worktree (`.tandem/worktrees/<run>-<task>`, branch `tandem/<run>-<task>`) and a Codex thread named "<project> · <task>". A task waits for the tasks it depends on to be merged, and for unmerged tasks that change the same paths: it then starts from the run's branch with their work in it, so the two do not conflict.
5. The workers' reports reach Claude together in one digest. Claude has each diff reviewed in a fresh context (a linked session or a subagent on Sonnet; trivial tasks it reads itself), then approves it or asks for changes, which the worker gets as its next turn.
6. With the simplification pass on, a fresh Codex agent ("<project> · Simplify · <task>") reads each approved change and proposes up to 10 simplifications (needless code, tests and complexity), changing nothing. You tick the ones you want in the panel; the task's own worker applies them and runs the tests, and Claude reviews the result once more.
7. Click Merge on each approved task: Tandem commits the work under your git identity and merges it into the run's branch `tandem/<run>`, and Claude hears of it at once, with any task the merge let start. The Merge card says which tasks wait for it; under each task, Summary shows what its worker reported, the reviewer's notes and the files it changed, and "Open the chat in Codex" opens the worker's whole conversation. "How a run works" in the run's header walks through these steps with the run's own branch. A conflict goes back to the worker that made the change, without using one of its fix rounds; a merge that fails for another reason shows git's own message.
8. When everything is merged, merge `tandem/<run>` into your branch yourself, then clean up from the panel: Clean up removes the finished tasks' worktrees and archives their Codex threads (the ones the Codex app still has open, you archive there). Tandem never pushes.

**The orchestrator's notes.** A run lasts longer than the orchestrator's conversation, which Claude compacts as it grows. So the orchestrator notes what the run's state does not hold (what you told it in the chat, why it sent a task back, what it learned about the code) with `orch_note`, into `.tandem/runs/<run>/notes.md`. When the conversation is compacted, resumed or cleared, Tandem hands Claude the run's state, its latest events, these notes and the run's workflow again, and a resumed session opens its run in the panel. Clean up of a finished run removes the notes; the run's state and events stay.

**Codex as the orchestrator.** In the Codex app or CLI, ask Codex to orchestrate a goal. It asks you the same setup questions, plans, and shows you the plan; when you say yes, it approves it. Tandem's conductor then sends each update into that Codex thread as a new turn, live when the thread is open in the Codex app. Codex asks you in the thread before anything that is yours to decide: approving the plan, picking simplifier proposals, merging. For a second opinion from the other vendor, it asks Claude through `ask-claude`. Codex needs to be allowed to run Tandem's commands outside its sandbox, because they start other Codex sessions.

Roles: `implementer`, `researcher`, `reviewer`, `simplifier`, `tester`, `designer` (Figma, which needs the run's full access to write), `image-maker` and `security` are Codex workers; `browser-tester` and `writer` run on Claude, so a Claude orchestrator does those itself. Their instructions are in `codex-skills/tandem/roles.json`.

## What Tandem runs, reads and writes

Tandem has no server and makes no network requests of its own. It runs, on your machine:

- `codex queue` to deliver a message into a Codex thread that a Codex app has open (it runs there live). Otherwise Tandem runs the turn itself through a short-lived `codex app-server` that exits after the turn, one at a time per room. The app server also starts the threads Tandem creates, named "<project> · …" so they show in the Codex app, and resumes them in the background with the model, reasoning effort and sandbox they started with. Codex's rate-limit usage from those background turns is saved in `.tandem/codex-limits.json`.
- `open -g codex://threads/<id>` for workers and new threads that run in the Codex app (the default): the app opens the thread in the background without coming to the front, and Tandem queues the turn into it, so the thread shows at once and you can watch it and write to it. Turns the app runs use the app's own settings for the thread (model, reasoning effort, sandbox and approvals), so only full-access turns go there: read-only roles, the simplifier (which also needs its output schema) and runs that sandbox their workers always run in the background. If the app does not take the thread within 10 seconds, the turn runs in the background. A turn that needs Tandem's own settings (a read-only or worktree sandbox, or an answer's schema) is never queued into a Codex app or CLI that has its thread open, since that would run it with their settings: Tandem says so instead, and the thread takes Tandem's messages again once the app lets go of it (the Codex app does when it restarts).
- `codex exec … fork` for `ask_thread`: read-only sandbox, with plugins and apps off (`features.plugins=false`, `features.apps=false`) and every MCP server and app named in your Codex config (`~/.codex/config.toml`) and the project's `.codex/config.toml` switched off; the question reaches Codex on stdin.
- For a review: `gh pr view` to read a pull request, `git fetch origin <base>` and `git fetch origin pull/<n>/head` to get its code, and `git worktree add --detach .tandem/worktrees/review-…` to read it in (removed when you disconnect the review); the review thread runs in the `read-only` sandbox. `gh api repos/<owner>/<repo>/pulls/<n>/reviews` posts a review only when you press Post in the panel and confirm.
- `codex archive` when you clean up a run, for its finished workers' threads, and `codex archive` or `codex unarchive` when you archive or restore a thread from the panel. The Codex app takes a thread off its list (or puts it back) only when it does so itself or one of its windows tells it, so Tandem then sends a running Codex app that same notice (`thread-archived` or `thread-unarchived`, with the thread's id) over the app's local socket `~/.codex/ipc/ipc.sock`, when the socket is yours. With no app running it sends nothing.
- A small background Claude agent, Tandem's watcher (Haiku, low effort, with one tool that waits), while Codex works for the session: a worker of the run it conducts, or the answer to a message Claude sent. The Claude app shows a session with a background agent as running, so its row in the sidebar says something is going on while Claude itself is idle. The watcher starts when Claude's turn ends while Codex works, stops when Codex stops or after an hour (Claude's next turn starts a new one), and steps aside at once when you or Tandem write to Claude. It costs about 2.5k cached Haiku tokens a minute and none of Claude's own context; its hand-back message is dropped before Claude reads it, and the line Claude Code shows for the dropped message says why the watcher stopped (Codex stopped working, or an hour passed).
- `claude --bg` when Codex starts a new Claude session, with only Tandem's `connect` and `send` tools pre-approved; `claude plugin list --json` checks that Tandem is enabled first. Agents Tandem starts cannot start more agents or runs: their background turns carry `TANDEM_SPAWNED=1`, and their threads are known to Tandem, which also covers turns the Codex app runs.
- For orchestrated runs: `git worktree add` and `remove`, and `git add`, `commit` and `merge` on the branches `tandem/<run>` and `tandem/<run>-<task>`. Commits are made under your git identity only when you click Merge, or Clean up, which commits a task's leftover work to its own branch before removing its worktree. These commits and merges skip your git hooks (`core.hooksPath=/dev/null`): worktrees rarely have what hooks need, such as `node_modules`, and the review is the check there. Your hooks do not check them, so run your checks on `tandem/<run>` before you merge it into your own branch. By default workers run like your regular Codex threads: full access, no approval prompts, with Codex's own subagents off. Their threads stay at the project root, which is where the Codex app looks for a project's threads, and show the task's branch; every message names the task's worktree, and the worker works there by instruction, as a regular agent with full access would. You can choose the `workspace-write` sandbox instead (those threads live in their worktree, which the Codex app does not list). Read-only roles always run in the `read-only` sandbox. Files you list to copy into worktrees must be git-ignored, so they never land in a commit. An optional setup command (such as `npm ci`) runs in each new worktree as you, outside Codex's sandbox; the panel shows it when you approve the plan.
- `claude -p` for `ask-claude`: consult mode reads and searches the project only, with no web access and with `~/.ssh`, `~/.aws`, `.env` files and the Codex and Claude credential files denied; edit mode may edit files inside the project only.
- `lsof` and `ps` to tell whether a thread is open in a Codex app, and `git rev-parse` to find the project root.
- Notifications when a run waits for you go through Claude Code's own notification channel in a terminal; where it has none (the Claude desktop app gives plugins none), through Tandem's own small macOS app, `mac/Tandem.app` (built from `mac/notifier.swift` by `mac/build.sh`, signed ad hoc), so they come from Tandem, and macOS asks you once whether Tandem may send them. A click on one opens the session in the Claude app (`claude://claude.ai/epitaxy/<id>`, the id from `CLAUDE_CODE_HOST_SESSION_ID`), or brings the app the session runs in to the front; macOS starts Tandem's app again for the click, and it quits once the session is open, so nothing keeps running. Only where that app cannot run does Tandem use `/usr/bin/osascript` (`display notification`), which macOS shows as from Script Editor. When your Claude settings turn notifications off, or you turn Tandem's off in macOS, Tandem sends none. Whether to notify is kept in Tandem's own store in your Claude configuration.

It reads Codex's local session files (`~/.codex/sessions` for answers and each worker's last step, and `~/.codex/session_index.jsonl` for thread names) and the app and MCP server names in `~/.codex/config.toml` and the project's `.codex/config.toml` for `ask_thread`, and writes `<project>/.tandem/` (rooms, runs and worktrees) plus one line in the project's `.git/info/exclude` so git ignores it, and, for orchestrated runs, the branches and commits above.

Every message Codex or Claude handles counts against your own Codex or Claude subscription limits. A room allows 20 agent messages, answers not counted, until you step in from the panel.

## Safety

- Messages carry who sent them. Claude's messages tell Codex they are not your instruction, and Codex's answers tell Claude the same; anything risky or hard to undo still needs your approval.
- In an orchestrated run, approving the plan, picking the simplifier's proposals, merging, accepting or cancelling a stuck task, stopping, and allowing more worker turns are buttons in the panel (the orchestrator's own tools do none of them, and Approve plan approves only the tasks the panel showed you), and every worker turn counts against the run's budget (the panel offers 10 more once 80% of it is used, and a turn over it pauses the run until you allow more). Tandem enforces these, but an agent with shell access could run the same commands, so treat them as guardrails.
- Only one agent should write to the same files or design at a time. Use separate git worktrees for parallel edits.
- Never send secrets through Tandem.

## Limitations

- A message to a thread that no Codex app has open runs in the background through a short-lived `codex app-server`; open the thread in the Codex app to watch it live. Turns that run in the Codex app (workers there by default, and any thread you open in the app) use the app's own model, reasoning effort, sandbox and approvals for that thread, not the run's: `codex queue` cannot pass settings while the app's server runs.
- A review thread or a read-only or sandboxed worker that you open in the Codex app takes no more of Tandem's messages until the app lets go of it, which the Codex app does when it restarts: Tandem will not have the app run them with its own, wider settings.
- Tandem cannot interrupt a turn the Codex app runs. Stopping such a worker marks it "stopping": stop its turn in the Codex app, and Tandem cancels the task when the turn ends.
- Orchestration needs a git repository with at least one commit. Workers are Codex threads; roles that run on Claude are done by a Claude orchestrator itself (in its session, a linked session or a subagent), or, under a Codex orchestrator, by Codex or by you in a Claude session.
- Claude receives messages only while a Claude session with Tandem is open and connected to the thread.
- Claude Code's mod API is in early access and may change between releases.

## Development

```
python3 -m unittest discover -s tests -v
claude plugin validate .
claude plugin test .
```

The core script is `codex-skills/tandem/scripts/tandem_core.py` (Python standard library only). The Claude mod is `mod/register.tsx`, with its state contract in `types/index.d.ts`.

## License

MIT. See LICENSE.
