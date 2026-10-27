import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type {
  Flash,
  LoadState,
  ReviewView,
  RoomView,
  RunRow,
  RunView,
  Starting,
  TaskView,
  ThreadRow,
  Trouble,
} from '../types'

type Engine = EngineInterface
type Els = ElementTable

type PollEvent = { type: 'answer' | 'message' | 'aborted' | 'waiting'; numbers: number[]; text: string }
type PollOutput = {
  busy?: true
  closed: boolean
  turn_running: boolean
  pending: number[]
  limit: number
  used: number
  events: PollEvent[]
  review?: ReviewView | null
}
type OrchEvent = { type: 'digest' | 'done' | 'notice'; text: string }
type OrchOutput = { ok?: boolean; text?: string; run?: RunView; events?: OrchEvent[] }
type Role = { vendor: 'codex' | 'claude'; access: string; summary: string }
// What a panel action came to: the panel shows it, and a failure is a toast as well.
type Outcome = { ok: boolean; text: string }
// Who has a task now; the run view colors each task by it.
type Holder = 'you' | 'plan' | 'codex' | 'claude' | 'done' | 'waiting' | 'failed' | 'cancelled'
type TaskState = { task: TaskView; holder: Holder; text: string }

const PANE = 'tandem'
const TITLE = 'Tandem'
// The dock width the panel asks for: room for a task's title beside its buttons.
const PANE_COLUMNS = 52
const POLL_MS = 2000
const CORE = '/codex-skills/tandem/scripts/tandem'
// Tandem's own notifier app on macOS, built from mac/notifier.swift.
const NOTIFIER = '/mac/Tandem.app/Contents/MacOS/tandem-notify'
// A message about a finished action fades after this; an error stays until dismissed or replaced.
const FLASH_MS = 30_000
// Lists older than this load again when the panel opens.
const STALE_MS = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDLE: LoadState = { state: 'idle', error: null, at: 0 }

const room = atom({ plugin: 'tandem', key: 'room' } as const, null)
const threads = atom({ plugin: 'tandem', key: 'threads' } as const, [])
const cwd = atom({ plugin: 'tandem', key: 'cwd' } as const, '')
const run = atom({ plugin: 'tandem', key: 'run' } as const, null)
const picks = atom({ plugin: 'tandem', key: 'picks' } as const, {})
const runs = atom({ plugin: 'tandem', key: 'runs' } as const, [])
const observing = atom({ plugin: 'tandem', key: 'observing' } as const, false)
const busy = atom({ plugin: 'tandem', key: 'busy' } as const, [])
const flash = atom({ plugin: 'tandem', key: 'flash' } as const, null)
const loads = atom({ plugin: 'tandem', key: 'loads' } as const, { threads: IDLE, runs: IDLE })
const starting = atom({ plugin: 'tandem', key: 'starting' } as const, null)
const confirming = atom({ plugin: 'tandem', key: 'confirm' } as const, null)
const runTrouble = atom({ plugin: 'tandem', key: 'runTrouble' } as const, null)
const expanded = atom({ plugin: 'tandem', key: 'expanded' } as const, [])
const watcher = atom({ plugin: 'tandem', key: 'watcher' } as const, null)
const notifyOn = atom({ plugin: 'tandem', key: 'notify' } as const, true)

const ORCH_TOOLS = ['orch_plan', 'orch_status', 'orch_diff', 'orch_review', 'orch_send', 'orch_done', 'orch_stop', 'orch_note']
const SETUP_QUESTIONS =
  'Ask the user how to organize the work, in their language, with one AskUserQuestion call of these four questions ' +
  '(recommended option first):\n' +
  '- Codex workers at once: 2 (recommended) · 1 · 3 · 4.\n' +
  '- Reasoning effort for the Codex workers: high (recommended) · medium · xhigh · max.\n' +
  '- What workers may do: full access like their regular Codex threads, which Figma and other tools that write need ' +
  '(recommended) · edit only inside their worktree, no network · the same with network · read only, for research.\n' +
  '- Where workers run: in the Codex app (recommended: the user watches each worker live and can write in its thread; the ' +
  "app's own model and effort settings may apply) · in the background (the run's effort applies; the Codex app shows them " +
  'only while a turn runs).\n' +
  'Ask one more question if it matters for the goal: a simplification pass after your review (recommended: on), merging ' +
  "approved tasks into the run's branch on their own (recommended: on; off, each waits for the user's Merge click), a setup command " +
  'for each worktree (such as npm ci), or git-ignored files to copy into worktrees (such as .env.local).'

// The panel shows a run that another session or a Codex thread conducts: this session's orchestrator tools leave it alone.
const WATCHED_ONLY =
  'The Tandem panel shows a run that another session or a Codex thread conducts, so these tools do not act on it. ' +
  'If you orchestrate a run of your own, ask the user to open it in the Tandem panel.'

// Where a command the person typed comes from: the terminal, the Remote Control bridge, or an app on the SDK (the desktop
// app). A command another agent, a plugin or a schedule ran comes from elsewhere.
const PERSON: string[] = ['composer', 'bridge', 'sdk']

const USAGE =
  '[orchestrate <goal> | threads | connect <number|id|name> | new [--worktree] <message> | review [PR|branch|commit] | ' +
  'post <finding numbers> | more | close]'

const SEND_HELP =
  'Send a message to the connected Codex thread. It runs there as Codex\'s next turn (the user sees it live in the Codex app), ' +
  'and Codex\'s final answer comes back into this conversation automatically as a new message: do not wait or poll. ' +
  'Codex does not see this conversation, so make the message self-contained. Connect a thread first with the connect tool.'

// Who has a task, in the run view's bar, its legend and each task's mark: a shape and a color, so neither is needed alone.
const HOLDERS: Record<Holder, { glyph: string; color: string; label: (n: number) => string }> = {
  you: { glyph: '◆', color: 'warning', label: n => (n === 1 ? 'needs you' : 'need you') },
  plan: { glyph: '◇', color: 'warning', label: () => 'in the plan' },
  codex: { glyph: '●', color: 'ide', label: () => 'with Codex' },
  claude: { glyph: '●', color: 'claude', label: () => 'with Claude' },
  done: { glyph: '✓', color: 'success', label: () => 'done' },
  waiting: { glyph: '○', color: 'inactive', label: () => 'waiting' },
  failed: { glyph: '✕', color: 'error', label: () => 'failed' },
  cancelled: { glyph: '–', color: 'inactive', label: () => 'cancelled' },
}
// The order the run view lists tasks and draws the bar in: what needs the person, what an agent has, what waits, what
// failed, and last what is finished, which the list folds into one row.
const HOLDER_ORDER: Holder[] = ['you', 'plan', 'codex', 'claude', 'waiting', 'failed', 'done', 'cancelled']
const FINISHED_HOLDERS: Holder[] = ['done', 'cancelled']

// Something that waits for the person tells them on their Mac once it has waited this long, unless they are using the
// panel (a press there within PRESENT_MS).
const NOTIFY_AFTER_MS = 20_000
const PRESENT_MS = 60_000
// A working agent with no new step for this long may be stuck, or waiting for an approval in the Codex app; tests and
// builds can take minutes, so less would cry wolf.
const STALL_MINUTES = 8

// What a task's role does, as the plan reads to the person who approves it.
const ROLE_VERBS: Record<string, string> = {
  implementer: 'builds it',
  researcher: 'researches it',
  reviewer: 'reviews it',
  simplifier: 'simplifies it',
  tester: 'tests it',
  designer: 'designs it in Figma',
  'image-maker': 'makes the images',
  security: 'checks its security',
  'browser-tester': 'tests it in a browser',
  writer: 'writes it',
}

const ACCESS_WORDS: Record<string, string> = {
  full: 'full access like your own Codex threads',
  worktree: 'edits only in their worktree, no network',
  'worktree+network': 'edits only in their worktree, with network',
  'read-only': 'read only',
}

// The plugin's own folder: the engine names its .claude-plugin folder.
function pluginDir($: Engine): string {
  return $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')
}

function corePath($: Engine): string {
  return pluginDir($) + CORE
}

function notifierPath($: Engine): string {
  return pluginDir($) + NOTIFIER
}

async function runCore($: Engine, args: string[], timeoutMs = 60_000, stdin?: string) {
  const dir = await read($, cwd)
  try {
    return await $.process.run([corePath($), ...args], { cwd: dir || undefined, timeoutMs, ...(stdin === undefined ? {} : { stdin }) })
  } catch (error) {
    // A start in a folder that is gone names the program as missing; say which is.
    if (dir && !(await $.fs.stat(dir).catch(() => null))) {
      throw new Error(`this session's folder no longer exists (${dir}): it was moved or removed. Open the project's folder in a new session.`)
    }
    throw error
  }
}

// The folder Tandem works in for this session: where it started, or, once that is gone (the app moved the session, or
// removed its worktree), where it runs now.
async function syncCwd($: Engine): Promise<void> {
  const dir = await read($, cwd)
  if (dir && (await $.fs.stat(dir).catch(() => null))) return
  const now = await $.session.cwd().catch(() => '')
  if (now && now !== dir && (await $.fs.stat(now).catch(() => null))) await update($, cwd, () => now)
}

// A free-text value for the core, as one argument: `--message -x` would read as two options, `--message=-x` cannot.
function opt(flag: string, value: string): string {
  return `${flag}=${value}`
}

// A plugin tool's result is the text the model reads; an error is marked so the model sees it failed.
function reply(text: string, isError = false) {
  return isError ? { isError: true as const, result: text } : { result: text }
}

function toolFailed() {
  return reply('Tandem could not finish this call. Check the setup with /tandem, then try again.', true)
}

// Work started from a button, a field or a timer: what it comes to is shown in the panel (act), not thrown.
function inBackground(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The core says what went wrong on the last line of its stderr, as `tandem: <reason>`.
function coreError(stderr: string, fallback: string): string {
  const lines = stderr.split('\n').map(line => line.replace(/^tandem: /, '').trim()).filter(Boolean)
  return lines[lines.length - 1] ?? fallback
}

async function setLoad($: Engine, list: 'threads' | 'runs', state: LoadState['state'], error: string | null = null) {
  const at = await $.clock.now()
  await update($, loads, all => ({ ...all, [list]: { state, error, at } }))
}

// The core's `threads --json`, as the panel keeps its rows (an archived thread is open in no app).
function threadRows(stdout: string): ThreadRow[] {
  return (JSON.parse(stdout) as Record<string, unknown>[]).map(row => ({
    id: String(row.id),
    name: typeof row.name === 'string' ? row.name : null,
    branch: typeof row.branch === 'string' ? row.branch : null,
    updated: String(row.updated ?? ''),
    updatedTs: typeof row.updated_ts === 'number' ? row.updated_ts : null,
    openIn: typeof row.open_in === 'string' ? row.open_in : null,
    worker: row.worker === true,
    preview: typeof row.preview === 'string' ? row.preview : null,
  }))
}

async function loadThreads($: Engine): Promise<{ rows: ThreadRow[]; error: string | null }> {
  await setLoad($, 'threads', 'loading')
  try {
    const dir = await read($, cwd)
    const ran = await runCore($, ['threads', '--json', '--cd', dir || '.'], 30_000)
    if (ran.exitCode !== 0) throw new Error(coreError(ran.stderr, 'the core could not list them'))
    const rows = threadRows(ran.stdout)
    await update($, threads, () => rows)
    await setLoad($, 'threads', 'ready')
    return { rows, error: null }
  } catch (error) {
    await setLoad($, 'threads', 'error', errorText(error))
    return { rows: [], error: errorText(error) }
  }
}

async function loadRuns($: Engine): Promise<RunRow[]> {
  await setLoad($, 'runs', 'loading')
  try {
    const listed = await orchCall($, 'list')
    if (!listed.ok) throw new Error(listed.text)
    const rows = Array.isArray(listed.out) ? (listed.out as unknown as RunRow[]) : []
    await update($, runs, () => rows)
    await setLoad($, 'runs', 'ready')
    return rows
  } catch (error) {
    await setLoad($, 'runs', 'error', errorText(error))
    return []
  }
}

// Opens the panel, named for the project, and loads the project's runs again when they are missing or old.
// Opened for a decision, it asks for the keyboard, so the decision's keys work at once.
async function openPane($: Engine, focus = false): Promise<void> {
  await syncCwd($)
  const dir = await read($, cwd)
  const project = dir.split('/').filter(Boolean).pop()
  await $.ui.open({ id: PANE, title: project ? `${TITLE} · ${project}` : TITLE, columns: PANE_COLUMNS, ...(focus ? { focus: true as const } : {}) })
  inBackground(refreshLists($))
}

async function refreshLists($: Engine, force = false): Promise<void> {
  const now = await $.clock.now()
  const state = await read($, loads)
  const due = (load: LoadState) => force || load.state === 'idle' || load.state === 'error' || now - load.at > STALE_MS
  if (due(state.runs)) await loadRuns($)
}

// Keys of panel actions in flight: a second press of the same button does nothing until the first is done.
const inFlight = new Set<string>()

async function act($: Engine, key: string, work: () => Promise<Outcome | null>): Promise<void> {
  if (inFlight.has(key)) return
  inFlight.add(key)
  await update($, busy, keys => [...keys.filter(k => k !== key), key])
  let outcome: Outcome | null = null
  try {
    outcome = await work()
  } catch (error) {
    outcome = { ok: false, text: `Tandem hit an error: ${errorText(error)}` }
  } finally {
    inFlight.delete(key)
    await update($, busy, keys => keys.filter(k => k !== key))
  }
  if (outcome) await showOutcome($, outcome)
}

async function showOutcome($: Engine, outcome: Outcome): Promise<void> {
  const shown: Flash = { tone: outcome.ok ? 'done' : 'error', text: outcome.text, at: await $.clock.now() }
  await update($, flash, () => shown)
  if (!outcome.ok) $.ui.toast(`Tandem: ${clipText(outcome.text, 120)}`)
}

// The Codex app opens a thread from its own link, codex://threads/<id>, on the Mac this session runs on.
async function openInCodex($: Engine, thread: string): Promise<void> {
  await act($, `codex-${thread}`, async () => {
    const ran = await $.process.run(['/usr/bin/open', `codex://threads/${encodeURIComponent(thread)}`], { timeoutMs: 15_000 })
    if (ran.exitCode === 0) return null
    return { ok: false, text: `Could not open the Codex app: ${coreError(ran.stderr, 'macOS could not open its link')}` }
  })
}

// A run poll that keeps failing: the panel says so from the second failure on.
async function noteTrouble($: Engine, text: string | null): Promise<void> {
  const before = await read($, runTrouble)
  if (text === null && !before) return
  await update($, runTrouble, () => (text === null ? null : { text, count: (before?.count ?? 0) + 1 }))
}

// A run of this project: the session that started it conducts it; any other session only watches it.
async function openRun($: Engine, row: RunRow): Promise<void> {
  let me = ''
  try {
    me = await $.session.id()
  } catch {
    me = ''
  }
  await update($, run, () => null)
  await update($, runTrouble, () => null)
  await update($, observing, () => row.orchestrator === 'codex' || !me || row.owner !== me)
  const dir = (await read($, cwd)) || '.'
  const ran = await runCore($, ['orch', 'status', '--run', row.id, '--cd', dir, '--json'])
  if (ran.exitCode !== 0) {
    await showOutcome($, { ok: false, text: `Could not open that run: ${coreError(ran.stderr, 'the core refused')}` })
    return
  }
  await update($, run, () => (JSON.parse(ran.stdout) as { run: RunView }).run)
}

// The run this session orchestrates, as the orchestrator needs it once its conversation was compacted, resumed or
// cleared: the run's state, latest events and its own notes. A resumed session has no panel state yet, so its own open
// run opens in the panel again. Null when it orchestrates none.
async function runJournal($: Engine, how: string): Promise<string | null> {
  let current = await read($, run)
  if (!current) {
    const me = await $.session.id().catch(() => '')
    const mine = me ? (await loadRuns($)).find(row => row.owner === me && ['running', 'planning'].includes(row.status)) : undefined
    if (mine) await openRun($, mine)
    current = await read($, run)
  }
  if (!current || (await read($, observing)) || ['done', 'stopped'].includes(current.status)) return null
  const ran = await runCore($, ['orch', 'journal', '--run', current.id, '--cd', current.root], 30_000)
  if (ran.exitCode !== 0) return null
  const what = { compact: 'compacted', resume: 'resumed', clear: 'cleared' }[how] ?? 'restarted'
  return (
    `[Tandem] You orchestrate this run, and your conversation was ${what}, so here is where the run stands. Read it ` +
    `before you act; the Tandem panel shows the same.\n\n${ran.stdout.trim()}\n\n${await orchestratorGuide($)}`
  )
}

function clipText(value: string, size: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= size ? flat : `${flat.slice(0, size - 1).trimEnd()}…`
}

// The threads a person or Claude can talk to: a run's workers are the run's, so they are left out and not numbered.
function talkable(rows: ThreadRow[]): ThreadRow[] {
  return rows.filter(row => !row.worker)
}

function threadsText(rows: ThreadRow[]): string {
  const listed = talkable(rows)
  if (listed.length === 0) return 'No Codex threads found for this project.'
  return listed
    .map((row, i) => `${i + 1}. ${threadLabel(row)} · ${row.updated}${row.openIn ? ` · open in ${row.openIn}` : ''} · ${row.id}`)
    .join('\n')
}

// A thread by its name, or by the opening words of its first message when it has none.
function threadLabel(row: ThreadRow): string {
  return row.name ?? (row.preview ? `“${row.preview}”` : 'Untitled thread')
}

function slug(text: string): string {
  const base = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return base || 'codex'
}

// Counts the changes to which conversation is open. A connect or a start takes a number when it begins; when a Disconnect or a
// later connect came in before the core answered, its answer is stale and must not take the panel over.
let roomEpoch = 0

// The thread list last shown as numbers (the threads tool, /tandem threads): `connect 2` means its second row, even after
// the panel's list loaded again in another order.
let numbered: ThreadRow[] | null = null

function listThreads(rows: ThreadRow[]): string {
  numbered = talkable(rows)
  return threadsText(rows)
}

const DISCONNECTED_MEANWHILE =
  'The user disconnected (/tandem close) while this was connecting, so nothing is connected. Do not connect again on your own: ' +
  'ask the user first.'

// Makes `next` the open conversation. A stale answer is not attached: the room the core just opened is closed again and the
// panel stays as the person left it. The room the panel leaves is closed too, so no room stays open on disk with nobody listening.
async function attach($: Engine, epoch: number, next: RoomView): Promise<boolean> {
  const before = await read($, room)
  if (epoch === roomEpoch && before && before.name !== next.name && !before.closed) {
    await runCore($, ['close', '--room', before.name, '--cd', before.root])
  }
  if (epoch !== roomEpoch) {
    await runCore($, ['close', '--room', next.name, '--cd', next.root])
    return false
  }
  await update($, room, () => next)
  // The message of the last action was about the conversation that is gone ("Disconnected from …").
  await update($, flash, () => null)
  return true
}

async function connect($: Engine, target: string): Promise<Outcome> {
  const epoch = ++roomEpoch
  const wanted = target.trim()
  if (!wanted) return { ok: false, text: 'Name a thread: its number from the threads list, its id, or part of its name.' }
  const index = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1
  const find = (rows: ThreadRow[]) =>
    index >= 0
      ? rows[index]
      : rows.find(row => row.id === wanted) ?? rows.find(row => (row.name ?? '').toLowerCase().includes(wanted.toLowerCase()))
  const known = await read($, threads)
  // A name or id may be of a thread newer than the list the panel has: that list loads again before Tandem gives up.
  let match = find(index >= 0 && numbered ? numbered : talkable(known))
  if (!match && !(index >= 0 && numbered)) match = find(talkable((await loadThreads($)).rows))
  const id = match?.id ?? (UUID.test(wanted) ? wanted : '')
  if (!id) return { ok: false, text: `No Codex thread matches "${wanted}". List them with /tandem threads.` }
  // The id's end, which is random, keeps two threads with the same name (or none) in rooms of their own.
  const name = `${match?.name ? slug(match.name).slice(0, 40).replace(/-+$/, '') : 'thread'}-${id.slice(-8)}`
  const dir = await read($, cwd)
  // --join: a room Codex already opened for this thread wins, so its waiting messages reach Claude.
  const ran = await runCore($, ['open', '--room', name, '--join', '--cd', dir || '.', '--codex-thread', id, '--json'])
  if (ran.exitCode !== 0) return { ok: false, text: coreError(ran.stderr, 'Could not open the room.') }
  const opened = JSON.parse(ran.stdout) as { room: string; root: string; thread_name: string | null; limit: number; used: number }
  // A thread Codex has not named is called by its first words, as in the list, not by "a Codex thread".
  const threadName = opened.thread_name ?? match?.name ?? (match ? threadLabel(match) : null)
  const attached = await attach($, epoch, {
    name: opened.room,
    root: opened.root,
    thread: id,
    threadName,
    limit: opened.limit,
    used: opened.used,
    turnRunning: false,
    pending: [],
    closed: false,
  })
  if (!attached) return { ok: false, text: DISCONNECTED_MEANWHILE }
  return {
    ok: true,
    text:
      `Connected to Codex thread "${threadName ?? id}" (room ${opened.room}). Messages sent with the send tool run there as new turns, ` +
      'and answers come back here automatically.',
  }
}

async function startCodex($: Engine, message: string, worktree: boolean): Promise<Outcome> {
  const epoch = ++roomEpoch
  const text = message.trim()
  if (!text) return { ok: false, text: 'Write the first message for the new Codex thread.' }
  const dir = await read($, cwd)
  const stamp = Math.floor(await $.clock.now()).toString(36).slice(-4)
  const name = `${slug(text).slice(0, 30).replace(/-+$/, '')}-${stamp}`
  const args = ['new-codex', '--room', name, '--cd', dir || '.', '--json', opt('--message', text)]
  if (worktree) args.push('--worktree')
  const ran = await runCore($, args, 330_000)
  if (ran.exitCode !== 0) return { ok: false, text: ran.stderr.trim() || 'Could not start a Codex thread.' }
  const started = JSON.parse(ran.stdout) as {
    root: string
    thread: string
    thread_name: string | null
    limit: number
    used: number
    sent?: number
  }
  const attached = await attach($, epoch, {
    name,
    root: started.root,
    thread: started.thread,
    threadName: started.thread_name ?? 'New Codex thread',
    limit: started.limit,
    used: started.used,
    turnRunning: false,
    pending: started.sent ? [started.sent] : [],
    closed: false,
  })
  if (!attached) {
    return {
      ok: false,
      text:
        `Codex thread ${started.thread} was started${started.sent ? ` and message #${started.sent} is running there` : ''}, ` +
        `but ${DISCONNECTED_MEANWHILE} Its answer will not arrive here; the thread stays in the Codex app.`,
    }
  }
  return {
    ok: true,
    text:
      `Started Codex thread ${started.thread}${worktree ? ' in its own git worktree' : ''} and connected it. ` +
      `Message #${started.sent} is running there; Codex's answer arrives here as a new message.`,
  }
}

// Codex reviews a change in a thread of its own, read-only: a pull request (number or URL), a branch, a commit, or with
// no target the uncommitted changes. The review is a conversation like any other, so its findings reach Claude here.
async function startReview($: Engine, target: string, focus = ''): Promise<Outcome> {
  const epoch = ++roomEpoch
  const dir = await read($, cwd)
  const args = ['review', '--cd', dir || '.', '--json', opt('--target', target.trim())]
  if (focus.trim()) args.push(opt('--focus', focus.trim()))
  const ran = await runCore($, args, 600_000)
  if (ran.exitCode !== 0) return { ok: false, text: ran.stderr.trim() || 'Could not start the review.' }
  const started = JSON.parse(ran.stdout) as {
    room: string
    root: string
    thread: string
    thread_name: string | null
    limit: number
    used: number
    sent?: number
    review: ReviewView
  }
  const label = started.review.label
  const attached = await attach($, epoch, {
    name: started.room,
    root: started.root,
    thread: started.thread,
    threadName: started.thread_name ?? `Review ${label}`,
    limit: started.limit,
    used: started.used,
    turnRunning: false,
    pending: started.sent ? [started.sent] : [],
    closed: false,
    review: started.review,
  })
  if (!attached) return { ok: false, text: `Codex started reviewing ${label}, but ${DISCONNECTED_MEANWHILE}` }
  return {
    ok: true,
    text:
      `Codex is reviewing ${label} in its own read-only thread (room ${started.room}). Its findings arrive here as a new ` +
      'message: check each one in the code before you tell the user.',
  }
}

// Posts the findings the person picked, by their numbers in the review, to the pull request: one review, with a comment
// on each finding's lines. Only the person runs it, with /tandem post.
async function postReview($: Engine, items: string): Promise<Outcome> {
  const current = await read($, room)
  if (!current?.review) return { ok: false, text: 'No review is open: start one with /tandem review.' }
  const ids = items.split(',').map(item => item.trim()).filter(item => /^\d+$/.test(item))
  if (ids.length === 0) return { ok: false, text: 'Name the findings to post by their numbers in the review: /tandem post 1,3' }
  const ran = await runCore($, ['review-post', '--room', current.name, '--cd', current.root, '--items', ids.join(','), '--json'], 120_000)
  if (ran.exitCode !== 0) return { ok: false, text: `Could not post the review: ${coreError(ran.stderr, 'GitHub refused it')}` }
  const out = JSON.parse(ran.stdout) as { posted: number; inline: boolean }
  return {
    ok: true,
    text: `Posted ${plural(out.posted, 'finding')} to the pull request${out.inline ? ', each on its lines' : " in the review's text: GitHub could not place them on their lines"}.`,
  }
}

async function sendMessage($: Engine, from: 'claude' | 'user', text: string): Promise<Outcome> {
  const current = await read($, room)
  if (!current || current.closed) {
    return {
      ok: false,
      text:
        'No Codex thread is connected: the user may have disconnected it with /tandem close. Do not connect again on your own; ' +
        'ask the user, or go on without Codex.',
    }
  }
  const ran = await runCore(
    $,
    ['send', '--room', current.name, '--cd', current.root, '--from', from, opt('--message', text)],
    150_000,
  )
  if (ran.exitCode !== 0) return { ok: false, text: ran.stderr.trim() || 'Sending failed.' }
  await update($, room, value =>
    value && (value.name === current.name ? { ...value, used: from === 'user' ? 0 : value.used + 1 } : value),
  )
  return { ok: true, text: ran.stdout.trim() }
}

async function orchCall(
  $: Engine,
  verb: string,
  args: string[] = [],
  stdin?: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; out: OrchOutput; text: string }> {
  const current = await read($, run)
  const dir = current?.root ?? ((await read($, cwd)) || '.')
  const scoped = current && !['init', 'roles', 'list'].includes(verb) ? ['--run', current.id] : []
  const ran = await runCore($, ['orch', verb, ...scoped, '--cd', dir, ...args], timeoutMs, stdin)
  if (ran.exitCode !== 0) return { ok: false, out: {}, text: ran.stderr.replace(/^tandem: /, '').trim() || `tandem orch ${verb} failed` }
  let out: OrchOutput = {}
  try {
    out = JSON.parse(ran.stdout) as OrchOutput
  } catch {
    return { ok: true, out, text: ran.stdout.trim() }
  }
  const next = out.run
  // Only the run the panel still shows: one closed or swapped while this call ran must not come back. Every poll answers
  // the whole run; writing only a changed one keeps the panel from redrawing for nothing.
  const shown = await read($, run)
  const same = shown ? shown.id === next?.id : verb === 'init'
  if (next && same && JSON.stringify(shown) !== JSON.stringify(next)) await update($, run, () => next)
  return { ok: out.ok !== false, out, text: out.text ?? ran.stdout.trim() }
}

async function roleLines($: Engine): Promise<string> {
  const ran = await orchCall($, 'roles')
  const roles = (ran.out as unknown as Record<string, Role> | undefined) ?? {}
  return Object.entries(roles)
    .map(([name, role]) => {
      const who = role.vendor === 'claude' ? 'Claude: you do it' : role.access === 'read-only' ? 'Codex worker, read-only' : 'Codex worker'
      return `  - ${name} (${who}): ${role.summary}`
    })
    .join('\n')
}

async function planner($: Engine): Promise<string> {
  try {
    return await $.session.model()
  } catch {
    return 'the current model'
  }
}

// How an orchestrated run works, for the orchestrator: in the /tandem orchestrate prompt and orch_start's result.
async function orchestratorGuide($: Engine): Promise<string> {
  return (
    'You are the orchestrator: you plan, review and coordinate; Tandem runs Codex workers for you. Each worker gets its own ' +
    'git worktree and a Codex thread named "<project> · <task>" that the user can watch in the Codex app. You never edit the ' +
    "workers' files, and the user approves the plan and every merge in the Tandem panel.\n\n" +
    `Load the tools first: ToolSearch "select:${ORCH_TOOLS.map(name => `mcp__tandem__${name}`).join(',')}".\n\n` +
    '1. Plan: read the code you need, then call orch_plan with small, independent tasks. Each task has an id, a title, a ' +
    'role, a brief (self-contained: the worker sees only the brief and the repository), acceptance criteria, owns (the paths ' +
    'it may change; a task that shares paths with unmerged work waits until that work is merged, so keep them apart where ' +
    'you can) and deps (task ids that must be merged first). Prefer 2 to 6 ' +
    `tasks. Roles:\n${await roleLines($)}\n` +
    'The user approves the plan in the Tandem panel, and you get a message when work starts: do not wait or poll.\n' +
    "2. Review: the workers' reports reach you together in one digest. Have each reported task reviewed in a fresh context " +
    'by a reviewer from the other vendor: start a linked session (start_session) when you have that tool, otherwise a ' +
    'subagent, on Sonnet with high effort and read-only, and give it the task\'s orch_diff output, its brief and its acceptance ' +
    'criteria. Have it read the project\'s rules (CLAUDE.md, AGENTS.md) and the code around each change (callers, tests, similar ' +
    'code), and check bugs the change introduces, how it fits the codebase (existing helpers, components or tokens it should ' +
    'reuse, the conventions around it, the right layer), tests, security and performance, confirming each finding in the ' +
    'code. It answers approve, or changes with findings as "[P0-P3] title - file:line"; only P0 to P2 block. Skip the ' +
    'reviewer for trivial tasks (docs or config only, a small diff) and read the diff yourself. Then decide with orch_review: ' +
    "approve, or changes with concrete notes (the worker gets them as its next turn; after the run's fix rounds the user " +
    'decides). When the run has the simplification pass on, approving a task that changed code sends it to a fresh ' +
    'simplifier that only proposes; the user picks proposals in the panel, the worker applies them, and you review the ' +
    "result once more. A run with auto merge on (the default) merges each approved task into the run's branch itself, and a " +
    "merge conflict comes back to you to have its worker resolve; with it off, approved tasks wait for the user's Merge " +
    'click. You never merge.\n' +
    '3. Tasks whose role runs on Claude are yours: do them in this session, a linked session or a subagent, then call orch_done.\n' +
    "4. When every task is merged, the work is on the run's branch (tandem/<name>/result, <name> from the goal). Summarize the run for the user; they merge " +
    'that branch into theirs themselves.\n' +
    '5. Keep the run\'s notes with orch_note, a sentence or two each: what the user tells you in the chat that matters for the ' +
    'run, why you send a task back, and what you learn about the codebase that later tasks need. Leave out what Tandem shows ' +
    "anyway (task states, merges). When your conversation is compacted, resumed or cleared, Tandem hands you the run's state " +
    'and these notes again.\n' +
    "Each message to a Codex worker uses one of the run's worker turns, which the panel meters. Only the user allows more, " +
    '10 at a time, with Allow 10 more in the Tandem panel: when the run needs more, ask for that, not for a number.\n' +
    'Workers do not talk to each other; keep each brief self-contained; anything risky or hard to undo needs the user\'s approval.'
  )
}

async function orchestratePrompt($: Engine, goal: string): Promise<string> {
  return (
    `[Tandem orchestrator] The user wants you to orchestrate this goal:\n\n${goal}\n\n---\n` +
    `First, set up the run. ${SETUP_QUESTIONS}\nThis session plans on ${await planner($)}. If the user wants a different ` +
    'planner model or effort (for example Opus with max effort), they switch with /model and /effort before you plan. Then ' +
    'call orch_start with the goal and the answers.\n\n' +
    (await orchestratorGuide($))
  )
}

async function deliver($: Engine, prompt: string): Promise<void> {
  inBackground(submitPrompt($, prompt))
}

// Hands Claude a prompt. While Tandem's watcher holds, the session takes it only at the watcher's next tool round, so
// the hold ends at once (its enqueue record ends it too; this covers a record that lands late).
function submitPrompt($: Engine, text: string): Promise<unknown> {
  const sent = $.prompt.submit({ text })
  $.clock.after(500, () => wake?.())
  return sent
}

// --- the watcher -------------------------------------------------------------------------------------------
// While Codex works for this session (a worker of the run it conducts, or the answer to a message it sent), Claude is
// idle, and the Claude app's sidebar would show the session as idle too. A background agent counts as work there (a
// background shell does not), so Tandem starts a small one: Haiku, with one tool that holds until Codex stops working
// or a prompt waits. It costs about 2.5k cached Haiku tokens a minute and none of Claude's own context.

const WATCHER = 'tandem:watcher'
const HOLD_TOOL = 'mcp__tandem__hold'
// The longest one hold lasts; a prompt queued for the session ends it within a second.
const HOLD_MS = 60_000
// After this many holds the watcher stops, so its conversation stays small; Claude's next turn starts a fresh one.
const HOLDS = 60
// How long to wait before asking again when the engine refused to start the watcher.
const WATCHER_RETRY_MS = 5 * 60_000
const ENQUEUED = '"type":"queue-operation","operation":"enqueue"'
const WATCHER_PROMPT =
  `You keep a Tandem run marked as working in the Claude app while Codex works. Call ${HOLD_TOOL}. Each time it returns ` +
  '"keep watching", call it again at once and write nothing else. When it returns "stop", reply with the single word: ' +
  'done. Never use any other tool.'

// Whether Codex works for this session, as the last tick saw it. A hold reads this, not `$.state`: inside one long hook
// a state read can answer the value it read before.
let codexAtWork = false
let spawning = false
let refusedAt = -WATCHER_RETRY_MS
// Every watcher this module started: a hand-back from one is dropped before Claude reads it.
const watchers = new Set<string>()
// Why Tandem stopped a watcher, for the line Claude Code shows when its hand-back is dropped.
const stoppedFor = new Map<string, 'idle' | 'hour'>()
const STOP_NOTES = {
  idle: 'Tandem: Codex is no longer working, so this chat shows as idle again.',
  hour: "Tandem: its watcher stopped after an hour; a new one starts when Claude's next turn ends, if Codex still works.",
  other: "Tandem: its watcher stopped. There's nothing in its message for Claude.",
}
// The session's transcript and how far the holds have read it: a queued prompt's enqueue record lands there at once.
let transcript: string | null = null
let seen = 0
// Set while a hold waits; ends it.
let wake: (() => void) | null = null

function codexBusy(r: RunView | null, watching: boolean, chat: RoomView | null): boolean {
  const working = !!r && !watching && !['done', 'stopped'].includes(r.status) && r.tasks.some(task => WORKING.includes(task.status))
  return working || (!!chat && !chat.closed && chat.turnRunning)
}

async function refreshBusy($: Engine): Promise<void> {
  const [current, watching, chat] = await Promise.all([read($, run), read($, observing), read($, room)])
  codexAtWork = codexBusy(current, watching, chat)
}

async function sizeOf($: Engine, path: string): Promise<number> {
  return (await $.fs.stat(path).catch(() => null))?.size ?? 0
}

async function follow($: Engine, path: string): Promise<void> {
  if (path === transcript) return
  transcript = path
  seen = await sizeOf($, path)
}

// Whether a prompt was queued since the holds last looked: an enqueue record past what they have read.
async function queued($: Engine): Promise<boolean> {
  const path = transcript
  if (!path) return false
  const size = await sizeOf($, path)
  if (size <= seen) return false
  const tail = await $.process.run(['/usr/bin/tail', '-c', `+${seen + 1}`, path], { timeoutMs: 10_000 })
  seen = size
  return tail.stdout.includes(ENQUEUED)
}

// Each pass sleeps in a child process: a `$` call in flight stops the hook's time budget, which `$.clock.sleep` would
// not. Esc aborts the signal, and the pass in flight ends within a second.
async function hold($: Engine, signal: AbortSignal, deadline: number): Promise<'queued' | 'idle' | 'timeout' | 'aborted'> {
  const box: { woke?: true } = {}
  wake = () => {
    box.woke = true
  }
  try {
    for (;;) {
      if (signal.aborted) return 'aborted'
      if (box.woke || (await queued($))) return 'queued'
      if (!codexAtWork) return 'idle'
      if ((await $.clock.now()) >= deadline) return 'timeout'
      await $.process.run(['/bin/sleep', '1'], { timeoutMs: 10_000 })
    }
  } finally {
    wake = null
  }
}

async function startWatcher($: Engine): Promise<void> {
  if (spawning || (await read($, watcher))) return
  const now = await $.clock.now()
  if (now - refusedAt < WATCHER_RETRY_MS) return
  spawning = true
  try {
    if (transcript) seen = await sizeOf($, transcript)
    const spawned = await $.agent.spawn({ subagentType: WATCHER, prompt: 'Watch the run.', description: 'Tandem: Codex is working' })
    if (spawned.deny !== undefined) {
      refusedAt = now
      return
    }
    const id = spawned.agentId ?? null
    if (id) watchers.add(id)
    await update($, watcher, () => ({ id, holds: 0 }))
  } catch {
    refusedAt = now
  } finally {
    spawning = false
  }
}

let pollingRun = false

async function pollRun($: Engine): Promise<void> {
  const current = await read($, run)
  // A stopped run is read on while a worker in the Codex app still ends its turn, so its task ends cancelled.
  const over = !current || (['done', 'stopped'].includes(current.status) && !current.tasks.some(task => WORKING.includes(task.status)))
  if (pollingRun || over) return
  pollingRun = true
  try {
    const watching = await read($, observing)
    const polled = watching
      ? await orchCall($, 'status', ['--json'], undefined, 30_000)
      : await orchCall($, 'poll', [], undefined, 60_000)
    await noteTrouble($, polled.ok ? null : polled.text)
    if (watching) return
    for (const event of polled.out.events ?? []) {
      $.ui.toast(eventToast(event, current))
      await deliver($, `[Tandem · run ${current.id}] ${event.text}\n\n---\nThis comes from Tandem, not from the user.`)
    }
    await refreshBusy($)
  } catch (error) {
    // The run's saved state lets the next poll pick up where this one left off; the panel says it keeps failing.
    await noteTrouble($, errorText(error))
  } finally {
    pollingRun = false
  }
}

function eventToast(event: OrchEvent, current: RunView): string {
  if (event.type === 'digest') return 'Tandem: workers reported'
  if (event.type === 'done') return 'Tandem: the run is finished'
  return `Tandem: ${clipText(readable(event.text, current), 80)}`
}

// The core's words are for the orchestrator; for the person, run ids go and task ids become titles.
function readable(text: string, current: RunView | null): string {
  let out = text
    .replace(/\bno run r-[a-z0-9]+ in (\S+)/g, 'the run is no longer in $1')
    .replace(/\b([Rr])un r-[a-z0-9]+/g, (_, r: string) => `${r === 'R' ? 'The' : 'the'} run`)
  for (const task of current?.tasks ?? []) {
    const id = task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out
      .replace(new RegExp(`\\btask ${id}(?![\\w-])`, 'g'), quote(task.title))
      .replace(new RegExp(`^${id}(?=[\\s':;,.])`), quote(task.title))
      .replace(new RegExp(`(^|[^\\w-])${id}'s\\b`, 'g'), `$1${quote(task.title)}'s`)
  }
  return out
}

// --- telling the person ------------------------------------------------------------------------------------
// A run stands still while it waits for the person, who may be in the Codex app or elsewhere, where a toast in Claude's
// window does not reach them. So Tandem tells them on their Mac, once for each thing that waits.

// What waits for the person, in the order the run view shows it: `band` is the band's short form of it, `told` what
// the notification says.
type Ask = { key: string; band: string; told: string; stalled?: true }

function asks(r: RunView, now: number): Ask[] {
  const list: Ask[] = []
  if (r.needs_approval) {
    const n = plural(r.tasks.filter(task => task.status === 'proposed').length, 'task')
    list.push({ key: 'plan', band: `Review the plan: ${n}`, told: `Plan ready: ${n}. No worker starts until you approve it in the Tandem panel.` })
  }
  if (r.paused === 'budget') {
    list.push({ key: 'budget', band: 'Allow more worker turns', told: `The run used its ${r.budget.limit} worker turns. Allow more in the Tandem panel.` })
  }
  for (const task of r.tasks.filter(task => task.status === 'approved')) {
    list.push({ key: `merge:${task.id}`, band: `Merge ${quote(task.title)}`, told: `${quote(task.title)} is ready to merge in the Tandem panel.` })
  }
  for (const task of r.tasks) {
    const name = quote(task.title)
    if (task.status === 'proposals') {
      const n = plural(task.proposals.length, 'suggestion')
      list.push({ key: `picks:${task.id}`, band: `Pick simplifications for ${name}`, told: `The simplifier has ${n} for ${name}. Pick them in the Tandem panel.` })
    }
    if (task.status === 'blocked') {
      const n = plural(task.fix_rounds, 'round')
      list.push({ key: `stuck:${task.id}`, band: `${name} is stuck`, told: `${name} is stuck after ${n} of fixes. Decide in the Tandem panel.` })
    }
    if (task.status === 'failed') {
      list.push({ key: `failed:${task.id}`, band: `${name} failed`, told: `${name} failed. Cancel it in the Tandem panel, or ask ${leadOf(r)} to send it back to its worker.` })
    }
  }
  for (const task of r.tasks) {
    const idle = stalledFor(task, now)
    if (idle === null) continue
    const name = quote(task.title)
    list.push({
      key: `stall:${task.id}`,
      band: `${name}: no new step for ${idle} min`,
      told: `${name} has had no new step for ${idle} min. ${stallHint(r)}`,
      stalled: true,
    })
  }
  return list
}

// What a worker with no new step may be waiting for, as far as Tandem can tell.
function stallHint(r: RunView): string {
  return r.workers.where === 'app'
    ? 'It may be waiting for your approval in the Codex app.'
    : 'Its turn may be stuck: open it in Codex to look, or stop the task.'
}

// When each thing that waits was first seen, and the ones the person was told of; one that stops waiting is forgotten,
// so it tells again if it comes back (a task ready to merge again after a conflict).
const waitingSince = new Map<string, number>()
const told = new Set<string>()
// The person's last press in the panel or the band.
let lastPress = Number.NEGATIVE_INFINITY
let telling = false

async function tellPerson($: Engine): Promise<void> {
  if (telling) return
  telling = true
  try {
    const [r, watching, wanted, now] = await Promise.all([read($, run), read($, observing), read($, notifyOn), $.clock.now()])
    // A run another session conducts tells the person from there, and a Codex thread that runs one asks them itself.
    const open = r && !watching && !['done', 'stopped'].includes(r.status) ? asks(r, now) : []
    const keys = new Set(open.map(ask => ask.key))
    for (const key of [...waitingSince.keys()]) {
      if (keys.has(key)) continue
      waitingSince.delete(key)
      told.delete(key)
    }
    for (const ask of open) if (!waitingSince.has(ask.key)) waitingSince.set(ask.key, now)
    const due = open.filter(ask => !told.has(ask.key) && now - (waitingSince.get(ask.key) ?? now) >= NOTIFY_AFTER_MS)
    const [first] = due
    // While the person uses the panel they see it there; once they leave it, they hear of what still waits.
    if (!r || !first || now - lastPress < PRESENT_MS) return
    for (const ask of due) told.add(ask.key)
    if (!wanted) return
    const more = due.length > 1 ? ` ${plural(due.length - 1, 'more thing')} ${due.length > 2 ? 'wait' : 'waits'} for you too.` : ''
    await notify($, `Tandem · ${projectName(r)}`, `${first.told}${more}`)
  } finally {
    telling = false
  }
}

// A notification on the person's Mac through their terminal's own channel or, where Claude has none to use (the
// desktop app gives plugins none), through Tandem's own notifier app: a click on it opens this session in the Claude
// app, or brings the app the session runs in to the front. Only where the notifier cannot run, osascript's, which
// macOS shows as from Script Editor and opens Script Editor for. Off in their settings, refused by a hook, or
// Tandem's notifications off in macOS: none at all.
async function notify($: Engine, title: string, text: string): Promise<void> {
  const sent = await $.ui.notify(text, { title }).catch(() => null)
  if (!sent || sent.isSent || (sent.reason !== 'no-surface' && sent.reason !== 'no-channel')) return
  const [host, app, session] = await Promise.all([
    $.env.get('CLAUDE_CODE_HOST_SESSION_ID').catch(() => undefined),
    $.env.get('__CFBundleIdentifier').catch(() => undefined),
    $.session.id().catch(() => ''),
  ])
  // One notification per session: a newer one replaces the one before.
  const id = `tandem-${host || session}`
  const args = ['--title', title, '--body', text, '--id', id, '--group', id]
  // The desktop app's own sessions, which it opens from this link.
  if (host && /^local_[\w-]+$/.test(host)) args.push('--open', `claude://claude.ai/epitaxy/${host}`)
  if (app && /^[\w.-]+$/.test(app)) args.push('--activate', app)
  // The first one waits while macOS asks the person whether Tandem may notify, up to 100 s. Exit 3: they turned
  // Tandem's notifications off, or have not answered yet.
  const posted = await $.process.run([notifierPath($), ...args], { timeoutMs: 120_000 }).catch(() => null)
  if (posted?.exitCode === 0 || posted?.exitCode === 3) return
  const script = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run']
  await $.process.run(['/usr/bin/osascript', ...script, title, text], { timeoutMs: 15_000 }).catch(() => undefined)
}

async function setNotify($: Engine, on: boolean): Promise<void> {
  await update($, notifyOn, () => on)
  await $.store.set('notify', on).catch(() => undefined)
}

// What the person decided in the run view: the panel says what it came to, and the orchestrator hears of it.
type Decision = {
  key: string
  verb: string
  args?: string[]
  tell: boolean
  // What the orchestrator hears in place of the core's words.
  message?: string
  done: (after: RunView | null, text: string) => string
  failed: string
}

async function decide($: Engine, decision: Decision): Promise<void> {
  await act($, decision.key, async () => {
    await update($, confirming, () => null)
    const result = await orchCall($, decision.verb, decision.args ?? [])
    const after = await read($, run)
    if (!result.ok) {
      const why = readable(result.text, after)
      return { ok: false, text: why.startsWith('“') ? why : `${decision.failed}: ${why}` }
    }
    // A run another session conducts hears from its own panel and digests, not from this session's Claude. What the
    // decision set going comes along (a merge starts the tasks that waited for it).
    if (decision.tell && after && !(await read($, observing))) {
      const news = (result.out.events ?? []).map(event => event.text).join('\n')
      await deliver($, `[Tandem · run ${after.id}] ${decision.message ?? result.text}${news ? `\n\n${news}` : ''}`)
    }
    return { ok: true, text: decision.done(after, result.text) }
  })
}

// What became of a task the person let through (kept as it was, accepted): a run with auto merge has merged it already.
function landed(after: RunView | null, task: TaskView): string {
  const now = after?.tasks.find(t => t.id === task.id)
  if (now?.status === 'merged') return `Tandem merged it into ${after?.branch}.`
  if (now?.status === 'conflict') return 'It conflicts with work already merged, so its worker resolves that first.'
  return now?.status === 'approved' ? 'Merge it when you are ready.' : ''
}

async function mergeAll($: Engine): Promise<void> {
  await act($, 'merge-all', async () => {
    const current = await read($, run)
    const ready = (current?.tasks ?? []).filter(task => task.status === 'approved')
    const merged: TaskView[] = []
    const news: string[] = []
    // The orchestrator hears of every merge, also when a later one fails.
    const tell = async () => {
      const after = await read($, run)
      if (merged.length === 0 || !after || (await read($, observing))) return
      const which = merged.map(task => `${task.id} (${quote(task.title)})`).join(', ')
      await deliver($, `[Tandem · run ${after.id}] The user merged ${which} into ${after.branch}.${news.length ? `\n\n${news.join('\n')}` : ''}`)
    }
    for (const task of ready) {
      // A task merged meanwhile, or whose own Merge is on its way, is not merged again.
      if (inFlight.has(`merge-${task.id}`) || (await read($, run))?.tasks.find(t => t.id === task.id)?.status !== 'approved') continue
      const result = await orchCall($, 'merge', ['--task', task.id])
      if (!result.ok) {
        await tell()
        const why = readable(result.text, await read($, run))
        return { ok: false, text: `Merged ${merged.length} of ${ready.length}. ${why.startsWith('“') ? why : `${quote(task.title)} did not merge: ${why}`}` }
      }
      merged.push(task)
      news.push(...(result.out.events ?? []).map(event => event.text))
    }
    await tell()
    return { ok: true, text: `Merged ${plural(merged.length, 'task')} into ${current?.branch ?? "the run's branch"}.` }
  })
}

async function togglePick($: Engine, taskId: string, id: number): Promise<void> {
  await update($, picks, all => {
    const chosen = all[taskId] ?? []
    return { ...all, [taskId]: chosen.includes(id) ? chosen.filter(n => n !== id) : [...chosen, id] }
  })
}

async function pickAll($: Engine, task: TaskView, on: boolean): Promise<void> {
  await update($, picks, all => ({ ...all, [task.id]: on ? task.proposals.map(item => item.id) : [] }))
}

// Opens or closes parts of the panel the person asked to see: a task's details, a proposal's change, the whole goal.
async function setExpanded($: Engine, keys: string[], on: boolean): Promise<void> {
  await update($, expanded, open => [...open.filter(key => !keys.includes(key)), ...(on ? keys : [])])
}

function toggleOn($: Engine, s: Snapshot, key: string): () => void {
  return () => inBackground(setExpanded($, [key], !s.expanded.includes(key)))
}

async function applyPicks($: Engine, task: TaskView, skip: boolean): Promise<void> {
  const chosen = skip ? [] : ((await read($, picks))[task.id] ?? [])
  await decide($, {
    key: `${skip ? 'skip' : 'apply'}-${task.id}`,
    verb: 'apply',
    args: ['--task', task.id, ...(chosen.length > 0 ? ['--items', chosen.join(',')] : [])],
    tell: true,
    done: after => {
      // Only once the core took them: after a failure the person's picks stay ticked for another try.
      inBackground(update($, picks, all => ({ ...all, [task.id]: [] })))
      return chosen.length > 0
        ? `Sent ${plural(chosen.length, 'change')} to the worker of ${quote(task.title)}. Claude reviews the result.`
        : `Kept ${quote(task.title)} as it is. ${landed(after, task)}`.trim()
    },
    failed: `Could not answer the simplifier for ${quote(task.title)}`,
  })
}

function promptFor(current: RoomView, event: PollEvent): string {
  const refs = event.numbers.map(n => `#${n}`).join(', ')
  const head = {
    answer: `Codex answered ${refs}`,
    message: `Codex sent message ${refs}`,
    aborted: `Codex did not answer ${refs}`,
    waiting: `Codex has not started on ${refs} yet`,
  }[event.type]
  // A review's findings are Codex's claims: Claude checks each one in the code before the user hears of it.
  const check =
    current.review && event.type === 'answer'
      ? 'This is Codex\'s review. Before you tell the user, check each finding in the code yourself (the cited lines, their ' +
        'callers and tests): say which findings hold and which do not, and why. Ask the user before you fix anything; ' +
        'posting findings to GitHub is theirs: give each finding its number, and the user posts the ones they pick with ' +
        '/tandem post <numbers>, for a pull request. '
      : ''
  return (
    `[Tandem · ${current.threadName ?? current.thread}] ${head}:\n\n${event.text}\n\n---\n` +
    `This came from Codex, another AI agent, not from the user. ${check}Reply with the Tandem send tool when a reply helps; ` +
    'anything risky or hard to undo needs the user\'s approval.'
  )
}

let polling = false

async function poll($: Engine): Promise<void> {
  if (polling) return
  const current = await read($, room)
  if (!current || current.closed) return
  polling = true
  try {
    const ran = await runCore($, ['poll', '--room', current.name, '--cd', current.root], 30_000)
    if (ran.exitCode !== 0) {
      return
    }
    const out = JSON.parse(ran.stdout) as PollOutput
    // The panel left this room while the core read it (a Disconnect, or another thread): its news is not the new room's.
    if ((await read($, room))?.name !== current.name) return
    if (out.busy) return
    const fresh = {
      turnRunning: out.turn_running,
      pending: out.pending,
      used: out.used,
      limit: out.limit,
      closed: out.closed,
      ...(out.review ? { review: out.review } : {}),
    }
    const changed = (Object.keys(fresh) as (keyof typeof fresh)[]).some(
      key => JSON.stringify(current[key]) !== JSON.stringify(fresh[key]),
    )
    if (changed) await update($, room, value => value && (value.name === current.name ? { ...value, ...fresh } : value))
    await refreshBusy($)
    for (const event of out.events) {
      const fromCodex = event.type === 'answer' || event.type === 'message'
      $.ui.toast(fromCodex ? `Codex: ${clipText(event.text, 80)}` : clipText(event.text, 120))
      if (event.type === 'waiting') continue
      await deliver($, promptFor(current, event))
    }
  } catch (error) {
    // The room's saved state lets the next poll pick up where this one left off; the panel says it keeps failing.
  } finally {
    polling = false
  }
}

// Disconnect always works here: the panel lets go of the conversation even when the core cannot mark its room closed, and says so.
async function closeRoom($: Engine): Promise<Outcome> {
  roomEpoch += 1 // a connect or a start still on its way is stale from now on
  const current = await read($, room)
  if (!current) return { ok: true, text: 'No conversation with Codex is open.' }
  const ran = await runCore($, ['close', '--room', current.name, '--cd', current.root]).catch(error => ({
    exitCode: 1,
    stderr: errorText(error),
  }))
  await update($, room, () => null)
  const name = current.threadName ?? 'the Codex thread'
  if (ran.exitCode !== 0) {
    return {
      ok: false,
      text:
        `Disconnected from ${name} here, but the core could not mark its room closed (${coreError(ran.stderr, 'it refused')}), ` +
        'so Codex can still write to the room.',
    }
  }
  return {
    ok: true,
    text:
      `Disconnected from ${name}. The thread stays in the Codex app, not archived: ` +
      'continue it there, connect to it again here, or archive it.',
  }
}

async function allowMore($: Engine): Promise<Outcome> {
  const current = await read($, room)
  if (!current || current.closed) return { ok: false, text: 'No conversation with Codex is open.' }
  const limit = current.limit + 10
  const ran = await runCore($, ['open', '--room', current.name, '--cd', current.root, '--limit', String(limit), '--json'])
  if (ran.exitCode !== 0) return { ok: false, text: `Could not allow more messages: ${coreError(ran.stderr, 'the core refused')}` }
  await update($, room, value => value && (value.name === current.name ? { ...value, limit } : value))
  return { ok: true, text: `Allowed 10 more messages, ${limit} in all.` }
}

async function orchestrate($: Engine, goal: string): Promise<void> {
  await act($, 'goal', async () => {
    const at = await $.clock.now()
    await update($, starting, () => ({ kind: 'goal' as const, text: goal, at }))
    try {
      await submitPrompt($, await orchestratePrompt($, goal))
    } catch (error) {
      await update($, starting, () => null)
      throw error
    }
    return null
  })
}

async function closeRun($: Engine): Promise<void> {
  await update($, run, () => null)
  await update($, observing, () => false)
  await update($, runTrouble, () => null)
  await update($, confirming, () => null)
  await refreshLists($, true)
}

// --- what the panel says ----------------------------------------------------------------------------

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function quote(title: string): string {
  return `“${title}”`
}

function firstLine(text: string, size = 90): string {
  return clipText(text.split('\n').find(line => line.trim()) ?? '', size)
}

function titles(ids: string[], r: RunView): string {
  const names = ids.map(id => quote(r.tasks.find(task => task.id === id)?.title ?? id))
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

type Size = { files: number; added: number; removed: number }

// `git diff --shortstat`, read as files and lines: " 3 files changed, 40 insertions(+), 2 deletions(-)" is "3 files, +40 −2".
function diffSize(diffstat: string | null): Size | null {
  const files = Number(/(\d+) files? changed/.exec(diffstat ?? '')?.[1] ?? 0)
  if (!files) return null
  const added = Number(/(\d+) insertions?\(\+\)/.exec(diffstat ?? '')?.[1] ?? 0)
  const removed = Number(/(\d+) deletions?\(-\)/.exec(diffstat ?? '')?.[1] ?? 0)
  return { files, added, removed }
}

function sizeText(size: Size | null): string {
  if (!size) return ''
  const lines = [size.added ? `+${size.added}` : '', size.removed ? `−${size.removed}` : ''].filter(Boolean).join(' ')
  return `${plural(size.files, 'file')}${lines ? `, ${lines}` : ''}`
}

function changeSize(diffstat: string | null): string {
  return sizeText(diffSize(diffstat))
}

// Several tasks' changes as one size: their files and lines added up.
function totalSize(tasks: TaskView[]): string {
  const sizes = tasks.map(task => diffSize(task.diffstat)).filter((size): size is Size => size !== null)
  if (sizes.length === 0) return ''
  return sizeText(sizes.reduce((sum, size) => ({ files: sum.files + size.files, added: sum.added + size.added, removed: sum.removed + size.removed })))
}

function elapsed(task: TaskView): string {
  if (task.minutes === null) return ''
  return task.minutes < 1 ? ', just started' : `, ${task.minutes} min`
}

function leadOf(r: RunView): 'Claude' | 'Codex' {
  return r.orchestrator?.vendor === 'codex' ? 'Codex' : 'Claude'
}

function taskState(task: TaskView, r: RunView): TaskState {
  const lead = leadOf(r)
  const leadHolder: Holder = lead === 'Codex' ? 'codex' : 'claude'
  const state = (holder: Holder, text: string): TaskState => ({ task, holder, text })
  switch (task.status) {
    case 'proposed':
      return state('plan', 'In the plan, waiting for your approval')
    case 'pending': {
      if (r.paused) return state('waiting', 'Waits until the run resumes')
      // The core also names unmerged tasks that change the same paths; an older core names only dependencies.
      const open =
        task.waits_for ?? task.deps.filter(dep => !['merged', 'done'].includes(r.tasks.find(t => t.id === dep)?.status ?? ''))
      return state('waiting', open.length > 0 ? `Waits for ${titles(open, r)}` : 'Waits for a free worker')
    }
    case 'running':
      if (task.phase === 'simplify') return state('codex', `A simplifier is reading the change${elapsed(task)}`)
      if (task.phase === 'apply') return state('codex', `Codex is applying your picks${elapsed(task)}`)
      if (task.fix_rounds > 0) return state('codex', `Codex is working on review notes, round ${task.fix_rounds}${elapsed(task)}`)
      return state('codex', `Codex is working on it${elapsed(task)}`)
    case 'stopping':
      return state('codex', 'Stopping: its turn still runs in the Codex app, so stop it there')
    case 'reported':
      return state(leadHolder, task.phase === 'applied' ? `${lead} is reviewing the simplified change` : `${lead} is reviewing it`)
    case 'assigned':
      return state(leadHolder, `${lead} does this one`)
    case 'proposals':
      return state('you', 'Pick simplifications')
    case 'approved':
      return state('you', 'Ready to merge')
    case 'blocked':
      return state('you', 'Needs your decision')
    case 'conflict':
      return state(leadHolder, `Merge conflict: ${lead} sends it back to the worker`)
    case 'merged':
      return state('done', 'Merged')
    case 'done':
      return state('done', 'Done')
    case 'failed':
      return state('failed', task.error ? `Failed: ${firstLine(task.error)}` : 'Failed')
    case 'cancelled':
      return state('cancelled', task.error ? `Cancelled: ${firstLine(task.error)}` : 'Cancelled')
    default:
      return state('waiting', task.status)
  }
}

// The decisions waiting on the person: the plan, the budget, and each task to merge, pick for, unblock or give up.
function decisions(r: RunView): number {
  const tasks = r.tasks.filter(task => ['approved', 'proposals', 'blocked', 'failed'].includes(task.status)).length
  return tasks + (r.needs_approval ? 1 : 0) + (r.paused === 'budget' ? 1 : 0)
}

function runHeadline(r: RunView, states: TaskState[], answerInCodex: boolean, now: number): { text: string; color?: string } {
  const count = (holder: Holder) => states.filter(state => state.holder === holder).length
  if (r.status === 'done') return { text: 'Finished', color: 'success' }
  if (r.status === 'stopped') return { text: 'Stopped' }
  const waiting = decisions(r)
  if (waiting > 0) {
    if (answerInCodex) return { text: 'Codex is waiting for your answer in its thread', color: 'warning' }
    if (r.needs_approval && waiting === 1) return { text: 'Your turn: review the plan', color: 'warning' }
    if (r.paused === 'budget' && waiting === 1) return { text: 'Your turn: the run used its worker turns', color: 'warning' }
    // One decision is named, as the band names it: "Your turn: merge “Login spacing”".
    const only = waiting === 1 ? asks(r, now)[0] : undefined
    if (only) return { text: `Your turn: ${only.band.charAt(0).toLowerCase()}${only.band.slice(1)}`, color: 'warning' }
    return { text: `Your turn: ${plural(waiting, 'decision')} waiting`, color: 'warning' }
  }
  if (r.paused) return { text: 'Paused: no new workers start until you resume', color: 'warning' }
  if (r.tasks.length === 0) return { text: `${leadOf(r)} is writing the plan` }
  if (count('codex') > 0) return { text: `Codex is working on ${plural(count('codex'), 'task')}` }
  if (count('claude') > 0) return { text: `Claude has ${plural(count('claude'), 'task')}` }
  return { text: 'Waiting for the next step' }
}

function planLine(task: TaskView, r: RunView): string {
  const who = task.vendor === 'claude' ? 'Claude' : 'A Codex worker'
  const does = ROLE_VERBS[task.role] ?? `works on it as ${task.role}`
  const after = task.deps.length > 0 ? ` once ${titles(task.deps, r)} ${task.deps.length === 1 ? 'is' : 'are'} done` : ''
  return `${who} ${does}${after}.`
}

function workersLine(r: RunView): string {
  const access = ACCESS_WORDS[r.workers.access] ?? r.workers.access
  const model = r.workers.model ? `, ${r.workers.model}` : ''
  const where = r.workers.where === 'app' ? ' in the Codex app' : r.workers.where === 'background' ? ' in the background' : ''
  return `${plural(r.workers.max_parallel, 'Codex worker')} at a time${where}, ${r.workers.effort} effort${model}, ${access}`
}

// What running in the Codex app or in the background means for the person, said once in the plan they approve.
function whereNote(r: RunView): string {
  if (r.workers.where === 'app') return "In the Codex app you can watch each worker and write to it; the app's own model and effort settings can apply."
  if (r.workers.where === 'background') return 'Background workers show in the Codex app only while a turn runs.'
  return ''
}

function projectName(r: RunView): string {
  return r.root.split('/').filter(Boolean).pop() ?? 'project'
}

function chatStatus(current: RoomView): { glyph: string; color: string; text: string } {
  if (current.closed) return { glyph: '○', color: 'inactive', text: 'This conversation has ended' }
  if (current.turnRunning) return { glyph: '●', color: 'ide', text: 'Codex is working…' }
  if (current.pending.length > 0) {
    return { glyph: '○', color: 'inactive', text: `Waiting for Codex to pick up ${current.pending.map(n => `#${n}`).join(', ')}` }
  }
  return { glyph: '●', color: 'success', text: 'Ready for the next message' }
}

function inputOf(els: Els) {
  return 'Input' in els ? els.Input : null
}

// The surface the tree being built is for. Every surface's table carries an Svg, but the terminal draws none, so a mark
// there is text. Set by each render hook right before it builds its tree, which it does without awaiting.
let drawingOn = 'desktop'

function svgOf(els: Els) {
  return drawingOn !== 'terminal' && 'Svg' in els ? els.Svg : null
}

// Statuses in which a worker's turn is still going.
const WORKING = ['running', 'stopping']

// The spinner's colors: an SVG cannot read the theme, so these stand for Codex's blue and Claude's orange.
const SPINNER_COLORS = { codex: '#4A8FE7', claude: '#D97757' } as const

function spinnerSource(color: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">' +
    `<circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-opacity="0.25" stroke-width="2.4"/>` +
    `<path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round">` +
    '<animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/>' +
    '</path></svg>'
  )
}

// The agents' own app icons (from the Claude and the Codex apps), read once from the plugin's assets as SVG sources.
const agentIcons: Record<'claude' | 'codex', string | null> = { claude: null, codex: null }

async function loadAgentIcons($: Engine): Promise<void> {
  const assets = `${pluginDir($)}/assets`
  for (const who of ['claude', 'codex'] as const) {
    try {
      const read = await $.fs.read(`${assets}/agent-${who}.png`, { as: 'bytes' })
      const png = typeof read === 'string' ? '' : `data:image/png;base64,${read.base64}`
      agentIcons[who] = png
        ? '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16" width="16" ' +
          `height="16"><image width="16" height="16" href="${png}" xlink:href="${png}"/></svg>`
        : null
    } catch {
      agentIcons[who] = null // the agent's mark in its color stands in
    }
  }
}

// Who does something: the agent's own app icon where the surface draws SVG, else its mark in its color.
function agentIcon(els: Els, who: 'claude' | 'codex', size = 14): JSX.Element {
  const { Text } = els
  const Svg = svgOf(els)
  const source = agentIcons[who]
  if (Svg && source) return <Svg source={source} alt={who === 'codex' ? 'Codex' : 'Claude'} width={size} height={size} />
  return <Text color={who === 'codex' ? 'ide' : 'claude'}>{who === 'codex' ? '❯' : '✳'}</Text>
}

// Work in progress: a spinning arc where the surface draws SVG, else the worker's dot.
function workingMark(els: Els, who: 'codex' | 'claude'): JSX.Element {
  const { Text } = els
  const Svg = svgOf(els)
  if (!Svg) return <Text color={who === 'codex' ? 'ide' : 'claude'}>●</Text>
  const name = who === 'codex' ? 'Codex' : 'Claude'
  return <Svg source={spinnerSource(SPINNER_COLORS[who])} alt={`${name} is working`} width={13} height={13} isInteractive />
}

function since(at: number | null | undefined, now: number): string {
  if (!at) return ''
  const seconds = Math.max(0, Math.round(now / 1000 - at))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

// What a working agent did last, as the Codex app shows it: its reasoning's title, a command it ran, a tool it used.
function lastStep(task: TaskView, now: number): string {
  const step = task.activity
  if (!step) return ''
  const when = since(step.at, now)
  return when ? `${step.text} · ${when}` : step.text
}

// Whole minutes a working agent has gone without a new step (since its turn started, before its first), once that is
// long enough to warn of.
function stalledFor(task: TaskView, now: number): number | null {
  if (task.status !== 'running') return null
  const at = task.activity?.at
  const idle = at ? (now / 1000 - at) / 60 : task.minutes
  return idle !== null && idle !== undefined && idle >= STALL_MINUTES ? Math.floor(idle) : null
}

function workTime(task: TaskView): string {
  if (task.minutes === null) return ''
  return task.minutes < 1 ? 'just started' : `${task.minutes} min`
}

// What a working agent is on, without the time the row shows beside it.
function workPhase(task: TaskView): string {
  if (task.status === 'stopping') return 'Stopping: its turn still runs in the Codex app, so stop it there'
  if (task.phase === 'simplify') return 'A simplifier is reading the change'
  if (task.phase === 'apply') return 'Applying the simplifications you picked'
  if (task.fix_rounds > 0) return `Working on review notes, round ${task.fix_rounds}`
  return task.vendor === 'claude' ? 'Claude is working on it' : 'Working on the task'
}

function hasDetails(task: TaskView): boolean {
  return Boolean(task.brief || task.acceptance?.length || task.owns?.length || task.error || task.proposals.length)
}

// One proposal's kind, place, size and risk, as one short line.
function proposalFacts(item: TaskView['proposals'][number]): string {
  return [item.kind, item.where, item.lines_removed ? `−${item.lines_removed} lines` : '', item.risk ? `risk: ${item.risk}` : '']
    .filter(Boolean)
    .join(' · ')
}

// What the simplifier proposed for a task and what the person picked, once they have picked (or kept it as it was).
function proposalsDone(els: Els, task: TaskView): JSX.Element | null {
  const { Box, Text, Markdown } = els
  if (task.proposals.length === 0 || task.status === 'proposals') return null
  const picked = task.applied ?? []
  return (
    <Box key={`proposed-${task.id}`} flexDirection="column">
      <Text size="footnote" weight="semibold">
        The simplifier proposed {plural(task.proposals.length, 'change')}
        {picked.length > 0 ? `; you picked ${picked.length}` : '; you kept the code as it was'}
      </Text>
      {task.simplifier_summary ? (
        <Text size="footnote" dimColor>
          {task.simplifier_summary}
        </Text>
      ) : null}
      {task.proposals.map(item => {
        const chosen = picked.includes(item.id)
        return (
          <Box key={`proposed-${task.id}-${item.id}`} flexDirection="column" paddingLeft={1}>
            <Text size="footnote" color={chosen ? 'success' : undefined} dimColor={!chosen}>
              {chosen ? '✓' : '–'} {item.id}. {item.why}
            </Text>
            <Box flexDirection="column" paddingLeft={2}>
              <Text size="footnote" dimColor>
                {[proposalFacts(item), chosen ? 'picked' : 'not picked'].filter(Boolean).join(' · ')}
              </Text>
              {item.change ? <Markdown key={`proposed-${task.id}-${item.id}-change`} text={item.change} dimColor /> : null}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

// What a task came to, for the person deciding to merge it: what its worker reported, what the reviewer said, and the
// files it changed.
function taskSummary(els: Els, task: TaskView, lead: 'Claude' | 'Codex'): JSX.Element {
  const { Box, Text, Markdown } = els
  const files = task.files ?? []
  const size = (file: NonNullable<TaskView['files']>[number]) =>
    file.added === null ? 'binary' : [`+${file.added}`, file.removed ? `−${file.removed}` : ''].filter(Boolean).join(' ')
  return (
    <Box key={`summary-${task.id}-body`} flexDirection="column" gap={1} paddingLeft={2}>
      <Box flexDirection="column">
        <Text size="footnote" weight="semibold">
          What the worker reported
        </Text>
        {task.report ? (
          <Markdown key={`report-${task.id}`} text={task.report} />
        ) : (
          <Text size="footnote" dimColor>
            No report yet.
          </Text>
        )}
      </Box>
      <Box flexDirection="column">
        <Text size="footnote" weight="semibold">
          {lead}'s review
        </Text>
        <Text size="footnote" dimColor={!task.review}>
          {task.review || `${lead} approved it without notes.`}
        </Text>
      </Box>
      {files.length > 0 ? (
        <Box flexDirection="column">
          <Text size="footnote" weight="semibold">
            Files changed
          </Text>
          {files.slice(0, 20).map(file => (
            <Text size="footnote">
              <Text mono>{file.path}</Text>
              <Text dimColor> {size(file)}</Text>
            </Text>
          ))}
          {files.length > 20 ? (
            <Text size="footnote" dimColor>
              …and {plural(files.length - 20, 'more file')}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

// A long brief's first part in a task's details: about this many characters, up to where a paragraph ends.
const BRIEF_START = 1000

// A long brief's first part, cut where a paragraph ends (and a code block cut open closed), or null for a brief short
// enough to show whole: one at most a fifth longer than the part would hide little.
function briefStart(brief: string): string | null {
  if (brief.length <= BRIEF_START * 1.2) return null
  const cut = ['\n\n', '\n', ' '].map(mark => brief.lastIndexOf(mark, BRIEF_START)).find(at => at >= BRIEF_START / 2) ?? BRIEF_START
  const part = brief.slice(0, cut).trimEnd()
  const fenceOpen = (part.match(/^\s*```/gm) ?? []).length % 2 === 1
  return `${part}${fenceOpen ? '\n```' : ''}\n\n…`
}

// Whether a task's whole brief shows in its details, and the press that shows or folds it. One whole brief shows at a
// time: a drawing holds 100,000 characters, and a brief may run to 28,000.
function wholeBrief($: Engine, s: Snapshot, task: TaskView): { open: boolean; toggle: () => void } {
  const key = `whole-brief-${task.id}`
  const open = s.expanded.includes(key)
  const others = (keys: string[]) => keys.filter(other => !other.startsWith('whole-brief-'))
  return { open, toggle: () => inBackground(update($, expanded, keys => (open ? others(keys) : [...others(keys), key]))) }
}

// A task as the plan describes it: the brief its worker gets, when it is done, what it may change. With `whole`, a long
// brief shows its first part until the person asks for all of it.
function taskDetails(els: Els, task: TaskView, r: RunView, whole?: { open: boolean; toggle: () => void }): JSX.Element {
  const { Box, Text, Button, Markdown } = els
  const acceptance = task.acceptance ?? []
  const owns = task.owns ?? []
  const start = whole && task.brief ? briefStart(task.brief) : null
  return (
    <Box key={`about-${task.id}`} flexDirection="column" gap={1} paddingLeft={2}>
      {task.brief ? <Markdown key={`brief-${task.id}`} text={start && !whole?.open ? start : task.brief} /> : null}
      {start && whole ? (
        <Button
          key={`whole-brief-${task.id}`}
          plain
          dimColor
          label={whole.open ? 'Show less' : 'Show the whole brief'}
          onPress={whole.toggle}
        />
      ) : null}
      {acceptance.length > 0 ? (
        <Box flexDirection="column">
          <Text size="footnote" weight="semibold">
            Done when
          </Text>
          {acceptance.map(item => (
            <Text size="footnote">• {item}</Text>
          ))}
        </Box>
      ) : null}
      {owns.length > 0 ? (
        <Text size="footnote" dimColor>
          May change: {owns.join(', ')}
        </Text>
      ) : null}
      {task.deps.length > 0 ? (
        <Text size="footnote" dimColor>
          Starts after {titles(task.deps, r)}
        </Text>
      ) : null}
      {task.error ? (
        <Text size="footnote" color="error">
          {task.error}
        </Text>
      ) : null}
      {proposalsDone(els, task)}
      {task.report ? taskSummary(els, task, leadOf(r)) : null}
    </Box>
  )
}

// The Orchestrate tab with no run open: how a run goes, the goal to start one, and the project's other runs to watch.
function orchestrateStart(els: Els, $: Engine, s: Snapshot): JSX.Element {
  const { Box, Text, Button } = els
  const Input = inputOf(els)
  const others = s.runs.filter(row => row.status === 'running' || row.status === 'planning')
  const runLoad = s.loads.runs
  return (
    <Box flexDirection="column" gap={1}>
      {s.starting?.kind === 'goal' ? startingCard(els, $, s.starting) : null}
      <Box flexDirection="column" gap={1} borderStyle="round" borderColor="claude" paddingX={1}>
        <Box flexDirection="column">
          <Text size="heading" weight="semibold">
            Orchestrate a goal
          </Text>
          <Text dimColor>A team of agents builds it, and nothing lands without you.</Text>
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text weight="semibold">1.</Text> Describe the goal below.
          </Text>
          <Text>
            <Text weight="semibold">2.</Text> <Text color="claude">Claude</Text> asks how to run it (workers, effort, access),
            then writes a plan.
          </Text>
          <Text>
            <Text weight="semibold">3.</Text> You approve the plan, and <Text color="ide">Codex</Text> workers build the tasks,
            each in its own git worktree.
          </Text>
          <Text>
            <Text weight="semibold">4.</Text> <Text color="claude">Claude</Text> reviews every change, and you merge what you
            want.
          </Text>
        </Box>
        {Input ? (
          <Input
            key="goal"
            rows={3}
            placeholder="What should be built?"
            submitLabel="Plan it"
            onSubmit={value => {
              if (value.trim()) inBackground(orchestrate($, value.trim()))
            }}
          />
        ) : (
          <Text dimColor>Type /tandem orchestrate and your goal in the chat.</Text>
        )}
      </Box>
      {others.length > 0 ? (
        <Box flexDirection="column">
          <Text size="footnote" weight="semibold">
            Runs in this project
          </Text>
          {others.map(row => (
            <Box key={`run-${row.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
              <Box flexDirection="column" flexShrink={1}>
                <Text>{clipText(row.goal, 120)}</Text>
                <Text size="footnote" dimColor>
                  {row.orchestrator === 'codex' ? 'A Codex thread runs it' : 'A Claude session runs it'}
                </Text>
              </Box>
              <Button key={`watch-${row.id}`} plain label="Watch" onPress={() => inBackground(openRun($, row))} />
            </Box>
          ))}
        </Box>
      ) : runLoad.state === 'idle' ? (
        <Button key="runs-load" plain dimColor label="Show this project's runs" onPress={() => inBackground(refreshLists($, true))} />
      ) : runLoad.state === 'error' ? (
        <Text size="footnote" color="error">
          Could not list this project's runs: {runLoad.error}
        </Text>
      ) : null}
    </Box>
  )
}

// --- the panel ---------------------------------------------------------------------------------------

type Snapshot = {
  run: RunView | null
  runs: RunRow[]
  loads: { threads: LoadState; runs: LoadState }
  busy: string[]
  flash: Flash | null
  starting: Starting | null
  confirm: string | null
  watching: boolean
  picks: Record<string, number[]>
  runTrouble: Trouble | null
  expanded: string[]
  now: number
  columns: number
  rows: number
  // Whether the panel may offer to open the Codex app: it opens on the Mac, so not from a phone.
  canOpenCodex: boolean
  notify: boolean
}

async function snapshot($: Engine, columns: number, rows: number, surface: string): Promise<Snapshot> {
  const [
    current, runRows, loaded, keys, shownFlash, pending, confirm, watching, chosenPicks, troubleRun, opened,
    wanted, now,
  ] = await Promise.all([
    read($, run), read($, runs), read($, loads), read($, busy), read($, flash), read($, starting), read($, confirming),
    read($, observing), read($, picks), read($, runTrouble), read($, expanded), read($, notifyOn),
    $.clock.now(),
  ])
  return {
    run: current, runs: runRows, loads: loaded, busy: keys, flash: shownFlash, starting: pending, confirm, watching,
    picks: chosenPicks, runTrouble: troubleRun, expanded: opened, now, columns, rows,
    canOpenCodex: surface !== 'mobile', notify: wanted,
  }
}

function flashLine(els: Els, $: Engine, s: Snapshot): JSX.Element | null {
  const { Box, Text, Button } = els
  const shown = s.flash
  if (!shown) return null
  if (shown.tone === 'done') {
    return s.now - shown.at > FLASH_MS ? null : <Text color="success">✓ {shown.text}</Text>
  }
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
      <Box flexShrink={1}>
        <Text color="error">✕ {shown.text}</Text>
      </Box>
      <Button key="flash-dismiss" plain dimColor label="Dismiss" onPress={() => inBackground(update($, flash, () => null))} />
    </Box>
  )
}

function troubleLine(els: Els, trouble: Trouble | null, what: string): JSX.Element | null {
  const { Text } = els
  if (!trouble || trouble.count < 2) return null
  return <Text color="warning">Tandem cannot reach {what} right now: {clipText(trouble.text, 160)}. It keeps trying.</Text>
}

// Each task as a stretch of the bar in the color of whoever has it, in plan order, so the list below reads the same way.
function batonBar(els: Els, states: TaskState[], columns: number): JSX.Element {
  const { Text } = els
  const n = Math.max(1, states.length)
  let width = Math.floor((columns + 1) / n) - 1
  let gap = ' '
  if (width < 2) {
    width = Math.max(1, Math.floor(columns / n))
    gap = ''
  }
  return (
    <Text mono wrap="truncate-end">
      {states.map((state, i) => (
        <Text color={HOLDERS[state.holder].color} dimColor={state.holder === 'cancelled'}>
          {(i > 0 ? gap : '') + '━'.repeat(width)}
        </Text>
      ))}
    </Text>
  )
}

function legend(els: Els, states: TaskState[]): JSX.Element {
  const { Box, Text } = els
  const counts = HOLDER_ORDER.map(holder => [holder, states.filter(state => state.holder === holder).length] as const)
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {counts
        .filter(([, n]) => n > 0)
        .map(([holder, n]) =>
          holder === 'codex' || holder === 'claude' ? (
            <Box key={`legend-${holder}`} flexDirection="row" alignItems="center" gap={1}>
              {agentIcon(els, holder, 12)}
              <Text size="footnote">
                {n} {HOLDERS[holder].label(n)}
              </Text>
            </Box>
          ) : (
            <Text size="footnote">
              <Text color={HOLDERS[holder].color}>{HOLDERS[holder].glyph}</Text> {n} {HOLDERS[holder].label(n)}
            </Text>
          ),
        )}
    </Box>
  )
}

function startingCard(els: Els, $: Engine, pending: Starting): JSX.Element {
  const { Box, Text, Button } = els
  const goal = pending.kind === 'goal'
  const title = { goal: 'Setting up your run', thread: 'Starting a Codex thread', review: 'Getting the change ready for Codex' }
  const says = {
    goal: 'Claude asks in the chat how to organize the work. Answer there; the plan shows up here for your approval.',
    thread: 'The conversation opens here once Codex has the thread, which can take a minute.',
    review: 'Tandem fetches the change and starts a read-only Codex thread to review it, which can take a minute.',
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={goal ? 'claude' : 'ide'} paddingX={1}>
      <Text weight="semibold">{title[pending.kind]}</Text>
      <Text dimColor>
        {quote(clipText(pending.text, 80))}
      </Text>
      <Text>{says[pending.kind]}</Text>
      {goal && <Button key="starting-dismiss" plain dimColor label="Dismiss" onPress={() => inBackground(update($, starting, () => null))} />}
    </Box>
  )
}

// Keys that press the run view's main buttons while the panel has the keyboard (after a click in it, or ctrl+x tab):
// a approves the plan or applies the picks, 1 to 9 tick proposals, k keeps the code as is, m merges the one task ready,
// o opens a working agent in Codex. Each goes to one button, named here by its task; stopping is never a single key.
type Hotkeys = { picks: string | null; merge: string | null; open: string | null }

// What every part of the run view draws from.
type RunCtx = {
  els: Els
  s: Snapshot
  r: RunView
  lead: 'Claude' | 'Codex'
  // A Codex thread runs this run: the person answers Codex there, so the panel shows what waits without buttons.
  answerInCodex: boolean
  keys: Hotkeys
}

function busyLabel(c: RunCtx, key: string, label: string, working: string): string {
  return c.s.busy.includes(key) ? working : label
}

// A phone has no keyboard, so its buttons get no keys.
function hot(key: string): string | undefined {
  return drawingOn === 'mobile' ? undefined : key
}

// A button's label with its key. A desktop draws a button's key beside it, and the terminal a plain button's before
// it (`1: label`), so only the terminal's framed button carries its key in its label.
function keyed(label: string, key: string | undefined, plain = false): string {
  return key && !plain && drawingOn === 'terminal' ? `${label} · ${key}` : label
}

function decideOn($: Engine, decision: Decision): () => void {
  return () => inBackground(decide($, decision))
}

// Work started and not merged yet, as the core's UNMERGED: it holds the paths it may change.
const UNMERGED = [...WORKING, 'reported', 'proposals', 'approved', 'conflict', 'blocked']

type Owned = { head: string; glob: boolean }

// What an `owns` entry covers, as the core reads it: a plain path itself and everything under it, a glob every path
// that starts with its text before the first wildcard.
function ownedPath(pattern: string): Owned {
  const head = pattern.split(/[*?[]/, 1)[0] ?? ''
  return head !== pattern ? { head, glob: true } : { head: pattern.replace(/\/+$/, ''), glob: false }
}

function pathsMeet(x: Owned, y: Owned): boolean {
  if (!x.head || !y.head) return true
  if (x.glob || y.glob) return x.head.startsWith(y.head) || y.head.startsWith(x.head)
  return `${x.head}/`.startsWith(`${y.head}/`) || `${y.head}/`.startsWith(`${x.head}/`)
}

// Whether two tasks may change the same files, by the core's rule: a task that lists no paths may change any file, and
// a read-only one changes none.
function mayOverlap(a: TaskView, b: TaskView): boolean {
  if (a.read_only || b.read_only) return false
  const cover = (task: TaskView) => (task.owns?.length ? task.owns.map(ownedPath) : [{ head: '', glob: false }])
  return cover(a).some(x => cover(b).some(y => pathsMeet(x, y)))
}

// A task of the plan in its step: what held it back in the step before (its dependencies, or work on the same paths
// when `overlap`), and whether it waits in its own step for a free worker.
type PlanEntry = { task: TaskView; waited: string[]; overlap: boolean; slot: boolean }
// Tasks that start together once what they wait for (`after`) is merged or done; `stuck` ones wait for tasks that did
// not finish.
type PlanStep = { entries: PlanEntry[]; after: string[]; stuck: boolean }

// The plan's tasks in the order they start, by the core's own rule (dispatch_ready): a task starts once its
// dependencies are merged or done; a Codex worker also needs a free slot, and waits while unmerged work may change the
// same files. Each step after the first takes the work before it as merged, work already under way included.
function planSteps(r: RunView): PlanStep[] {
  const finished = new Set(r.tasks.filter(task => ['merged', 'done'].includes(task.status)).map(task => task.id))
  let underway = r.tasks.filter(task => [...UNMERGED, 'assigned'].includes(task.status))
  let holding = underway.filter(task => UNMERGED.includes(task.status))
  let busy = r.tasks.filter(task => WORKING.includes(task.status)).length
  let left = r.tasks.filter(task => ['proposed', 'pending'].includes(task.status))
  const held = new Map<string, { on: string[]; overlap: boolean }>()
  const steps: PlanStep[] = []
  while (left.length > 0) {
    const entries: PlanEntry[] = []
    for (const task of left) {
      const deps = task.deps.filter(id => !finished.has(id))
      if (deps.length > 0) {
        held.set(task.id, { on: deps, overlap: false })
        continue
      }
      const blocking = task.vendor === 'claude' ? [] : holding.filter(other => mayOverlap(task, other))
      if (blocking.length > 0) {
        held.set(task.id, { on: blocking.map(other => other.id), overlap: true })
        continue
      }
      const before = steps.length > 0 ? held.get(task.id) : undefined
      let slot = false
      if (task.vendor !== 'claude') {
        holding = [...holding, task]
        busy += 1
        slot = busy > r.workers.max_parallel
      }
      entries.push({ task, waited: before?.on ?? [], overlap: before?.overlap ?? false, slot })
    }
    if (entries.length === 0) break
    steps.push({ entries, after: [...new Set(entries.flatMap(entry => entry.waited))], stuck: false })
    for (const task of [...entries.map(entry => entry.task), ...underway]) finished.add(task.id)
    underway = []
    holding = []
    busy = 0
    left = left.filter(task => !entries.some(entry => entry.task === task))
  }
  if (left.length > 0) {
    const ids = new Set(left.map(task => task.id))
    const on = [...new Set(left.flatMap(task => task.deps))].filter(id => !finished.has(id) && !ids.has(id))
    const entries = left.map(task => ({ task, waited: [], overlap: false, slot: false }))
    steps.push({ entries, after: on, stuck: true })
  }
  return steps
}

// What a step waits for, said as each of those tasks ends: one that changes files is merged by the person; a read-only
// or Claude task, or any task of a read-only run, is done.
function afterText(ids: string[], r: RunView): string {
  const merges = (id: string) => {
    const task = r.tasks.find(other => other.id === id)
    return task?.vendor === 'codex' && !task.read_only
  }
  const part = (list: string[], word: string) =>
    list.length > 0 ? `${titles(list, r)} ${list.length === 1 ? 'is' : 'are'} ${word}` : ''
  return [part(ids.filter(merges), 'merged'), part(ids.filter(id => !merges(id)), 'done')].filter(Boolean).join(' and ')
}

function stepHeading(step: PlanStep, r: RunView): string {
  if (step.stuck) {
    return step.after.length > 0 ? `Wait for ${titles(step.after, r)}, which did not finish` : 'Cannot start yet'
  }
  if (step.after.length > 0) return `After ${afterText(step.after, r)}`
  const verb = step.entries.length === 1 ? 'Starts' : 'Start'
  return r.paused ? `${verb} when you approve and the run is no longer paused` : `${verb} when you approve`
}

// The paths of `task` that work in `others` may change too.
function sharedPaths(task: TaskView, others: TaskView[]): string[] {
  const own = task.owns ?? []
  const shared = own.filter(path =>
    others.some(other => (other.owns ?? []).some(theirs => pathsMeet(ownedPath(path), ownedPath(theirs)))),
  )
  return shared.length > 0 ? shared : own
}

// Why a task of the plan waits beyond its dependencies: work that may change the same files is merged first, and a
// worker has to be free.
function waitNote(entry: PlanEntry, r: RunView): string {
  const notes: string[] = []
  if (entry.overlap) {
    const others = r.tasks.filter(task => entry.waited.includes(task.id))
    // The tasks among them that list no paths, and so may change any file.
    const open = others.filter(other => !other.owns?.length)
    const they = open.length === 1 ? 'it' : 'they'
    const who = open.length === others.length ? they : titles(open.map(other => other.id), r)
    const why = !entry.task.owns?.length
      ? 'this task lists no paths, so it may change any file'
      : open.length > 0
        ? `${who} ${open.length === 1 ? 'lists' : 'list'} no paths, so ${they} may change any file`
        : `${others.length === 1 ? 'it' : 'they'} may change ${sharedPaths(entry.task, others).join(', ')} too`
    notes.push(`Waits for ${titles(entry.waited, r)} to be merged first: ${why}.`)
  }
  if (entry.slot) notes.push(`Starts when a worker is free (${plural(r.workers.max_parallel, 'worker')} at a time).`)
  return notes.join(' ')
}

// The opening of a brief as one short line: whole sentences up to about 160 characters, else its first words and an
// ellipsis; headings, code and Markdown marks are left out. Details shows the brief itself.
function briefSummary(brief: string, size = 160): string {
  const text = brief
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*#{1,6}\s.*$/gm, ' ')
    .replace(/^\s*([-*+]|\d+[.)]|>)\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const flat = text || brief.replace(/\s+/g, ' ').trim()
  if (flat.length <= size) return flat
  const head = flat.slice(0, size + 1)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (end >= size / 2) return flat.slice(0, end + 1)
  const space = head.lastIndexOf(' ', size - 1)
  return `${flat.slice(0, space >= size / 2 ? space : size - 1).replace(/[\s,;:([{–—-]+$/, '')}…`
}

// One task of the plan: its number, who does it and when, the opening of its brief, and the rest on request.
function planTask(c: RunCtx, $: Engine, entry: PlanEntry, n: number): JSX.Element {
  const { Box, Text, Button } = c.els
  const { r, s } = c
  const { task } = entry
  const key = `details-${task.id}`
  const open = s.expanded.includes(key)
  const whole = wholeBrief($, s, task)
  const note = waitNote(entry, r)
  return (
    <Box key={`plan-${task.id}`} flexDirection="column">
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text weight="medium">{n}.</Text>
        {agentIcon(c.els, task.vendor === 'claude' ? 'claude' : 'codex')}
        <Box flexShrink={1}>
          <Text weight="medium">{task.title}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <Text size="footnote" dimColor>
          {planLine(task, r)}
        </Text>
        {note ? (
          <Text size="footnote" dimColor>
            {note}
          </Text>
        ) : null}
        {task.brief && !open ? <Text size="footnote">{briefSummary(task.brief)}</Text> : null}
        {hasDetails(task) ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key={key} plain dimColor label={open ? 'Hide details' : 'Details'} onPress={toggleOn($, s, key)} />
          </Box>
        ) : null}
      </Box>
      {open ? taskDetails(c.els, task, r, whole) : null}
    </Box>
  )
}

// The plan to approve, and what approving does: Codex workers start on the tasks that are ready, each on a branch of
// its own, and nothing reaches the person's branch until they merge it. The tasks show in the order they start.
function planCard(c: RunCtx, $: Engine): JSX.Element {
  const { Box, Text, Button } = c.els
  const Input = inputOf(c.els)
  const { r, s } = c
  const proposed = r.tasks.filter(task => task.status === 'proposed')
  const numbers = new Map(proposed.map((task, i) => [task.id, i + 1]))
  // Only the plan's own tasks show; tasks from before it count for when these start.
  const steps = planSteps(r)
    .map(step => ({ ...step, entries: step.entries.filter(entry => entry.task.status === 'proposed') }))
    .filter(step => step.entries.length > 0)
  // Each step is headed by what it waits for; a plan that all starts when approved needs no heading.
  const headed = !!r.paused || steps.length > 1 || steps.some(step => step.stuck || step.after.length > 0)
  const keys = proposed.filter(hasDetails).map(task => `details-${task.id}`)
  const allOpen = keys.length > 0 && keys.every(key => s.expanded.includes(key))
  const where = r.workers.where === 'app' ? ', in a thread you can watch in the Codex app' : ', in the background'
  return (
    <Box key="plan-card" flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
          <Box flexDirection="column" flexShrink={1}>
            <Text weight="semibold">Review the plan</Text>
            <Text size="footnote" dimColor>
              {plural(proposed.length, 'task')}. No worker starts until you approve.
            </Text>
          </Box>
          {keys.length > 0 ? (
            <Button
              key="plan-details"
              plain
              dimColor
              label={allOpen ? 'Hide all details' : 'Show all details'}
              onPress={() => inBackground(setExpanded($, keys, !allOpen))}
            />
          ) : null}
        </Box>
        {proposed.some(task => task.vendor === 'codex') ? (
          <Text size="footnote" dimColor>
            Approve plan starts Codex workers on the tasks that are ready, each on its own branch{' '}
            <Text mono>{r.task_branch}</Text>
            {where}. Nothing reaches your branch: {c.lead} reviews every change, and each one comes back here for you
            to merge.
          </Text>
        ) : (
          <Text size="footnote" dimColor>
            Approve plan lets Claude start on the tasks that are ready.
          </Text>
        )}
      </Box>
      <Box flexDirection="column" gap={1}>
        {steps.map((step, i) => (
          <Box key={`plan-step-${i + 1}`} flexDirection="column">
            {headed ? (
              <Text size="footnote" weight="semibold">
                {stepHeading(step, r)}
              </Text>
            ) : null}
            <Box flexDirection="column" gap={1}>
              {step.entries.map(entry => planTask(c, $, entry, numbers.get(entry.task.id) ?? 0))}
            </Box>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text size="footnote" dimColor>
          {workersLine(r)}.{r.simplify ? ' A simplifier reads each approved change.' : ''}
          {r.auto_merge ? ' Approved tasks merge on their own.' : ''}
        </Text>
        {whereNote(r) ? (
          <Text size="footnote" dimColor>
            {whereNote(r)}
          </Text>
        ) : null}
        {r.setup_command ? (
          <Text size="footnote" dimColor>
            Each worktree first runs <Text mono>{r.setup_command}</Text>
          </Text>
        ) : null}
        {r.copy.length > 0 ? (
          <Text size="footnote" dimColor>
            Copied into each worktree: {r.copy.join(', ')}
          </Text>
        ) : null}
      </Box>
      {!c.answerInCodex && (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button
            key="approve-plan"
            variant="primary"
            hotkey={hot('a')}
            autoFocus
            label={busyLabel(c, 'approve-plan', keyed('Approve plan', hot('a')), 'Approving…')}
            onPress={decideOn($, {
              key: 'approve-plan',
              verb: 'approve',
              // The tasks shown: a plan Claude submitted since the person looked is not approved with this press.
              args: [opt('--tasks', proposed.map(task => task.id).join(','))],
              tell: true,
              done: after => {
                const started = after?.tasks.filter(task => task.status === 'running').length ?? 0
                return started > 0
                  ? `Plan approved. ${started === 1 ? 'One Codex worker started' : `${started} Codex workers started`}.`
                  : 'Plan approved. Workers start as tasks become ready.'
              },
              failed: 'Could not approve the plan',
            })}
          />
          {!Input && !s.watching && (
            <Button
              key="reject-plan"
              label={busyLabel(c, 'reject-plan', 'Reject plan', 'Rejecting…')}
              onPress={decideOn($, {
                key: 'reject-plan',
                verb: 'reject',
                tell: true,
                done: () => 'Plan rejected. Claude asks you in the chat what to change.',
                failed: 'Could not reject the plan',
              })}
            />
          )}
        </Box>
      )}
      {Input && !s.watching ? (
        <Box flexDirection="column">
          <Text size="footnote" dimColor>
            Or tell {c.lead} what to change, and the plan comes back revised:
          </Text>
          <Input
            key="plan-changes"
            rows={2}
            placeholder="What should change?"
            submitLabel="Send"
            onSubmit={value => {
              const note = value.trim()
              if (!note) return
              decideOn($, {
                key: 'plan-changes',
                verb: 'reject',
                tell: true,
                message:
                  `The user wants changes to the plan before approving it:\n\n${note}\n\n` +
                  'The proposed tasks were dropped; submit a revised plan with orch_plan.',
                done: () => 'Sent your changes to Claude. The revised plan shows up here.',
                failed: 'Could not send the plan back',
              })()
            }}
          />
        </Box>
      ) : null}
    </Box>
  )
}

function budgetCard(c: RunCtx, $: Engine): JSX.Element {
  const { Box, Text } = c.els
  const { r } = c
  return (
    <Box key="budget-card" flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
      <Box flexDirection="column">
        <Text weight="semibold">The run used its {r.budget.limit} worker turns</Text>
        <Text size="footnote" dimColor>
          Each message to a Codex worker is a turn. The limit keeps a run from spending your Codex usage without you.
        </Text>
      </Box>
      {!c.answerInCodex && moreTurns(c, $, 'Allow 10 more', true)}
    </Box>
  )
}

// The meter warns from 80%, and from there the header offers more: the orchestrator may ask for them before Tandem
// refuses it a turn. A run that Tandem paused for its budget asks in its own card.
function turnsRunningOut(r: RunView): boolean {
  return r.status === 'running' && r.paused !== 'budget' && r.budget.used >= r.budget.limit * 0.8
}

// The orchestrator hears of the turns at once, so whatever waited for them goes on.
function moreTurns(c: RunCtx, $: Engine, label: string, primary: boolean): JSX.Element {
  const { Button } = c.els
  const limit = c.r.budget.limit + 10
  return (
    <Button
      key="more-budget"
      variant={primary ? 'primary' : undefined}
      autoFocus={primary || undefined}
      label={busyLabel(c, 'more-budget', label, 'Adding…')}
      onPress={decideOn($, {
        key: 'more-budget',
        verb: 'more',
        tell: true,
        message: `The user allowed 10 more worker turns, ${limit} in all; what waited for them can go on.`,
        done: after => `Allowed 10 more worker turns, ${after?.budget.limit ?? limit} in all.`,
        failed: 'Could not allow more worker turns',
      })}
    />
  )
}

// A task ready to merge, in one line: how big the change is, and what the person picked of the simplifier's proposals.
function readyFacts(task: TaskView): string {
  const picked = (task.applied ?? []).length
  const simplified = task.proposals.length > 0 ? `simplifier: ${picked} of ${task.proposals.length} picked` : ''
  return [changeSize(task.diffstat), simplified].filter(Boolean).join(' · ')
}

// The tasks still to come that wait for `task` to be merged.
function waitingOn(task: TaskView, r: RunView): TaskView[] {
  return r.tasks.filter(other => other.deps.includes(task.id) && !['merged', 'done', 'cancelled'].includes(other.status))
}

// What merging `task` lets happen next, one line for each task that waits for it.
function unblockLines(task: TaskView, r: RunView): string[] {
  const merged = (id: string) => ['merged', 'done'].includes(r.tasks.find(other => other.id === id)?.status ?? '')
  return waitingOn(task, r)
    .slice(0, 3)
    .map(next => {
      const others = next.deps.filter(id => id !== task.id && !merged(id))
      return others.length === 0
        ? `${quote(next.title)} starts once this is merged.`
        : `${quote(next.title)} starts once this and ${titles(others, r)} are merged.`
    })
}

// What the person merges, and what it means: the run's reviewer approved it, its changes go to the run's branch (not
// theirs), and the tasks that wait for it start from there. Under each task, what it came to: a summary, or the
// worker's whole chat in the Codex app.
function mergeCard(c: RunCtx, $: Engine, ready: TaskView[]): JSX.Element {
  const { Box, Text, Button } = c.els
  const { r } = c
  const merging = c.s.busy.includes('merge-all')
  const one = ready.length === 1
  return (
    <Box key="merge-card" flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
      <Box flexDirection="column">
        <Text weight="semibold">{one ? 'Ready to merge' : `${ready.length} tasks ready to merge`}</Text>
        <Text size="footnote" dimColor>
          {c.lead} reviewed and approved {one ? 'it' : 'them'}. Merge commits {one ? 'its' : 'their'} changes and adds them to the
          run's branch <Text mono>{r.branch}</Text>, where the tasks that wait for {one ? 'it' : 'them'} start. Your own branch is
          not touched: you merge the run's branch into it yourself when the run is done.
        </Text>
      </Box>
      {ready.map((task, i) => (
        <Box key={`ready-${task.id}`} flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>{task.title}</Text>
            {readyFacts(task) ? (
              <Text size="footnote" dimColor>
                {readyFacts(task)}
              </Text>
            ) : null}
            {task.role === 'designer' ? (
              <Text size="footnote" dimColor>
                Its Figma work is already in the file; merging adds the record of it.
              </Text>
            ) : null}
            {unblockLines(task, r).map(line => (
              <Text key={`unblock-${task.id}-${line}`} size="footnote">
                → {line}
              </Text>
            ))}
          </Box>
          {/* The decision has a row of its own, under what it decides on. */}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
            {!c.answerInCodex && (
              <Button
                key={`merge-${task.id}`}
                variant="primary"
                hotkey={c.keys.merge === task.id ? hot('m') : undefined}
                autoFocus={i === 0 || undefined}
                label={merging ? 'Merging…' : busyLabel(c, `merge-${task.id}`, keyed('Merge', c.keys.merge === task.id ? hot('m') : undefined), 'Merging…')}
                // While Merge all runs, it merges this one too.
                onPress={
                  merging
                    ? () => undefined
                    : decideOn($, {
                        key: `merge-${task.id}`,
                        verb: 'merge',
                        args: ['--task', task.id],
                        tell: true,
                        message: `The user merged ${task.id} (${quote(task.title)}) into ${r.branch}.`,
                        done: after => {
                          const started = (after?.tasks ?? []).filter(next => next.deps.includes(task.id) && WORKING.includes(next.status))
                          const next = started.length > 0 ? ` ${titles(started.map(item => item.id), after ?? r)} started.` : ''
                          return `Merged ${quote(task.title)} into ${r.branch}.${next}`
                        },
                        failed: `Could not merge ${quote(task.title)}`,
                      })
                }
              />
            )}
            <Button
              key={`summary-${task.id}`}
              plain
              dimColor
              label={c.s.expanded.includes(`summary-${task.id}`) ? 'Hide summary' : 'Summary'}
              onPress={toggleOn($, c.s, `summary-${task.id}`)}
            />
            {c.s.canOpenCodex && task.thread ? (
              <Button
                key={`chat-${task.id}`}
                plain
                dimColor
                label={busyLabel(c, `codex-${task.thread}`, 'Open the chat in Codex', 'Opening…')}
                onPress={() => inBackground(openInCodex($, task.thread ?? ''))}
              />
            ) : null}
          </Box>
          {c.s.expanded.includes(`summary-${task.id}`) ? taskSummary(c.els, task, c.lead) : null}
        </Box>
      ))}
      {!c.answerInCodex && ready.length > 1 && (
        <Button key="merge-all" label={merging ? 'Merging…' : `Merge all ${ready.length}`} onPress={() => inBackground(mergeAll($))} />
      )}
    </Box>
  )
}

function picksCard(c: RunCtx, $: Engine, task: TaskView): JSX.Element {
  const { Box, Text, Button, Markdown } = c.els
  const mine = c.s.picks[task.id] ?? []
  const all = task.proposals.length > 0 && task.proposals.every(item => mine.includes(item.id))
  // The keys go to the first task waiting for picks; `a` approves a plan first when one waits too.
  const keysHere = c.keys.picks === task.id
  const applyKey = keysHere && !c.r.needs_approval ? hot('a') : undefined
  const keepKey = keysHere ? hot('k') : undefined
  return (
    <Box key={`picks-${task.id}`} flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
      <Box flexDirection="column">
        <Text weight="semibold">Simplify {quote(task.title)}?</Text>
        <Text size="footnote" dimColor>
          {plural(task.proposals.length, 'suggestion')} from a fresh Codex agent that read the change. Nothing has changed
          yet: tick what the worker should apply.
        </Text>
      </Box>
      <Box flexDirection="column" gap={1}>
        {task.proposals.map((item, i) => {
          const picked = mine.includes(item.id)
          const changeKey = `change-${task.id}-${item.id}`
          const open = c.s.expanded.includes(changeKey)
          const facts = proposalFacts(item)
          const digit = keysHere && item.id >= 1 && item.id <= 9 ? hot(String(item.id)) : undefined
          return (
            <Box key={`proposal-${task.id}-${item.id}`} flexDirection="row" alignItems="flex-start" gap={1}>
              {c.answerInCodex ? (
                <Text>{item.id}.</Text>
              ) : (
                <Button
                  key={`pick-${task.id}-${item.id}`}
                  plain
                  hotkey={digit}
                  autoFocus={(keysHere && i === 0) || undefined}
                  label={keyed(picked ? '☑' : '☐', digit, true)}
                  onPress={() => inBackground(togglePick($, task.id, item.id))}
                />
              )}
              <Box flexDirection="column" flexShrink={1}>
                <Text>{item.why}</Text>
                {facts ? (
                  <Text size="footnote" dimColor>
                    {facts}
                  </Text>
                ) : null}
                {item.change ? (
                  <Button key={changeKey} plain dimColor label={open ? 'Hide the change' : 'Show the change'} onPress={toggleOn($, c.s, changeKey)} />
                ) : null}
                {open && item.change ? <Markdown key={`${changeKey}-text`} text={item.change} /> : null}
                {open && item.proof ? (
                  <Text size="footnote" dimColor>
                    Behaviour shown to stay by: {item.proof}
                  </Text>
                ) : null}
              </Box>
            </Box>
          )
        })}
      </Box>
      {!c.answerInCodex && (
        <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          {mine.length === 0 && (
            <Text size="footnote" dimColor>
              Tick a suggestion to have the worker apply it.
            </Text>
          )}
          {mine.length > 0 && (
            <Button
              key={`apply-${task.id}`}
              variant="primary"
              hotkey={applyKey}
              label={busyLabel(c, `apply-${task.id}`, keyed(`Apply ${plural(mine.length, 'change')}`, applyKey), 'Sending…')}
              onPress={() => inBackground(applyPicks($, task, false))}
            />
          )}
          {task.proposals.length > 1 && (
            <Button key={`all-${task.id}`} label={all ? 'Clear picks' : 'Pick all'} onPress={() => inBackground(pickAll($, task, !all))} />
          )}
          <Button
            key={`skip-${task.id}`}
            hotkey={keepKey}
            label={busyLabel(c, `skip-${task.id}`, keyed('Keep as is', keepKey), 'Saving…')}
            onPress={() => inBackground(applyPicks($, task, true))}
          />
        </Box>
      )}
    </Box>
  )
}

function stuckCard(c: RunCtx, $: Engine, task: TaskView): JSX.Element {
  const { Box, Text, Button } = c.els
  return (
    <Box key={`blocked-${task.id}`} flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
      <Box flexDirection="column">
        <Text weight="semibold">{quote(task.title)} is stuck</Text>
        <Text size="footnote" dimColor>
          {c.lead} still asks for changes after {plural(task.fix_rounds, 'round')} of fixes. Accept the work as it is, or cancel the
          task.
        </Text>
      </Box>
      {!c.answerInCodex && (
        <Box flexDirection="row" gap={1}>
          <Button
            key={`accept-${task.id}`}
            label={busyLabel(c, `accept-${task.id}`, 'Accept as is', 'Accepting…')}
            onPress={decideOn($, {
              key: `accept-${task.id}`,
              verb: 'accept',
              args: ['--task', task.id],
              tell: true,
              done: after => `Accepted ${quote(task.title)}. ${landed(after, task)}`.trim(),
              failed: `Could not accept ${quote(task.title)}`,
            })}
          />
          <Button
            key={`cancel-${task.id}`}
            label={busyLabel(c, `cancel-${task.id}`, 'Cancel task', 'Cancelling…')}
            onPress={decideOn($, {
              key: `cancel-${task.id}`,
              verb: 'cancel',
              args: ['--task', task.id],
              tell: true,
              done: () => `Cancelled ${quote(task.title)}.`,
              failed: `Could not cancel ${quote(task.title)}`,
            })}
          />
        </Box>
      )}
    </Box>
  )
}

// A task whose worker failed: it holds back the tasks that wait for it, and the run cannot finish, until the orchestrator
// sends it back to its worker or the person cancels it.
function failedCard(c: RunCtx, $: Engine, task: TaskView): JSX.Element {
  const { Box, Text, Button } = c.els
  return (
    <Box key={`failed-${task.id}`} flexDirection="column" gap={1} borderStyle="round" borderColor="error" paddingX={1}>
      <Box flexDirection="column">
        <Text weight="semibold">{quote(task.title)} failed</Text>
        {task.error ? (
          <Text size="footnote" color="error">
            {clipText(task.error, 600)}
          </Text>
        ) : null}
        <Text size="footnote" dimColor>
          {c.lead} can send it back to its worker. Cancel task gives it up, and the tasks that wait for it with it.
        </Text>
      </Box>
      {!c.answerInCodex && (
        <Box flexDirection="row" gap={1}>
          <Button
            key={`cancel-${task.id}`}
            label={busyLabel(c, `cancel-${task.id}`, 'Cancel task', 'Cancelling…')}
            onPress={decideOn($, {
              key: `cancel-${task.id}`,
              verb: 'cancel',
              args: ['--task', task.id],
              tell: true,
              done: () => `Cancelled ${quote(task.title)}.`,
              failed: `Could not cancel ${quote(task.title)}`,
            })}
          />
        </Box>
      )}
    </Box>
  )
}

// One running agent, in the run view's Working now: what it is on, what it did last, and its controls.
function workingCard(c: RunCtx, $: Engine, task: TaskView): JSX.Element {
  const { Box, Text, Button } = c.els
  const thread = task.thread
  const step = lastStep(task, c.s.now)
  // Working and standing still look different: no new step for a while, and the card says what may hold it.
  const idle = stalledFor(task, c.s.now)
  const stoppable = task.status === 'running' && !c.answerInCodex
  // Stopping a simplifier skips the simplification: the approved change stays and waits for the person's Merge.
  const simplifying = task.phase === 'simplify'
  const confirmKey = `stop-${task.id}`
  const asked = c.s.confirm === confirmKey
  const openKey = c.keys.open === task.id ? hot('o') : undefined
  return (
    <Box key={`working-${task.id}`} flexDirection="column" borderStyle="round" borderColor={idle !== null ? 'warning' : 'ide'} paddingX={1}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        {workingMark(c.els, task.vendor === 'claude' ? 'claude' : 'codex')}
        {agentIcon(c.els, task.vendor === 'claude' ? 'claude' : 'codex', 16)}
        <Box flexShrink={1} flexGrow={1}>
          <Text weight="semibold">{task.title}</Text>
        </Box>
        <Text size="footnote" dimColor>
          {workTime(task)}
        </Text>
      </Box>
      <Text size="footnote" color={task.status === 'stopping' ? 'warning' : undefined} dimColor={task.status !== 'stopping'}>
        {workPhase(task)}
      </Text>
      {idle !== null ? (
        <Box flexDirection="column">
          <Text size="footnote" color="warning">
            ⚠ No new step for {idle} min.{task.activity && task.activity.text !== 'Starting' ? ` Last: ${task.activity.text}` : ''}
          </Text>
          <Text size="footnote" dimColor>
            {stallHint(c.r)}
          </Text>
        </Box>
      ) : step ? (
        <Text size="footnote">Last: {step}</Text>
      ) : null}
      {task.phase === 'apply' && (task.applied ?? []).length > 0 ? (
        <Box flexDirection="column">
          <Text size="footnote" weight="semibold">
            Applying what you picked:
          </Text>
          {task.proposals
            .filter(item => (task.applied ?? []).includes(item.id))
            .map(item => (
              <Text size="footnote">
                • {item.id}. {item.why}
              </Text>
            ))}
        </Box>
      ) : null}
      {(c.s.canOpenCodex && thread) || stoppable ? (
        <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          {c.s.canOpenCodex && thread ? (
            <Button
              key={`codex-${task.id}`}
              hotkey={openKey}
              label={busyLabel(c, `codex-${thread}`, keyed('Open in Codex', openKey), 'Opening…')}
              onPress={() => inBackground(openInCodex($, thread))}
            />
          ) : null}
          {stoppable && !asked && (
            <Button key={`stop-${task.id}`} plain dimColor label="Stop" onPress={() => inBackground(update($, confirming, () => confirmKey))} />
          )}
        </Box>
      ) : null}
      {stoppable && asked && (
        <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          <Text color="warning">
            {simplifying
              ? `Stop the simplifier? The approved change stays, without simplifications, and ${c.r.auto_merge ? 'is merged' : 'waits for your Merge'}.`
              : 'Stop this task? Its worker is cancelled.'}
          </Text>
          <Button
            key={`stop-${task.id}-confirm`}
            label={busyLabel(c, confirmKey, simplifying ? 'Stop simplifier' : 'Stop task', 'Stopping…')}
            onPress={decideOn($, {
              key: confirmKey,
              verb: 'stop',
              args: ['--task', task.id],
              tell: true,
              done: (after, text) =>
                readable(text, c.r)
                  .replace(/^Stopped task \S+\./, `Stopped ${quote(task.title)}.`)
                  .replace(/^Stopped the simplifier of \S+;.*$/, `Stopped the simplifier. ${quote(task.title)} stays as it is. ${landed(after, task)}`.trim()),
              failed: `Could not stop ${quote(task.title)}`,
            })}
          />
          <Button key={`stop-${task.id}-keep`} plain label="Keep it" onPress={() => inBackground(update($, confirming, () => null))} />
        </Box>
      )}
    </Box>
  )
}

function taskRow(c: RunCtx, $: Engine, state: TaskState): JSX.Element {
  const { Box, Text, Button } = c.els
  const { task, holder } = state
  const size = changeSize(task.diffstat)
  const thread = task.thread
  const working = WORKING.includes(task.status)
  // A worker's thread is worth opening while its task is in progress; a working one has its button in Working now.
  const openable = c.s.canOpenCodex && !working && !['merged', 'done', 'cancelled'].includes(task.status)
  const detailsKey = `details-${task.id}`
  const open = c.s.expanded.includes(detailsKey)
  return (
    <Box key={`task-${task.id}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
        <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
          {working ? (
            workingMark(c.els, task.vendor === 'claude' ? 'claude' : 'codex')
          ) : (
            <Text color={HOLDERS[holder].color}>{HOLDERS[holder].glyph}</Text>
          )}
          {agentIcon(c.els, task.vendor === 'claude' ? 'claude' : 'codex')}
          <Box flexShrink={1}>
            <Text>{task.title}</Text>
          </Box>
        </Box>
        <Box flexDirection="row" gap={2}>
          {openable && thread ? (
            <Button
              key={`codex-${task.id}`}
              plain
              dimColor
              label={busyLabel(c, `codex-${thread}`, 'Open in Codex', 'Opening…')}
              onPress={() => inBackground(openInCodex($, thread))}
            />
          ) : null}
          {hasDetails(task) ? (
            <Button key={detailsKey} plain dimColor label={open ? 'Hide' : 'Details'} onPress={toggleOn($, c.s, detailsKey)} />
          ) : null}
        </Box>
      </Box>
      <Box paddingLeft={2}>
        <Text size="footnote" color={holder === 'failed' ? 'error' : undefined} dimColor={holder !== 'failed'}>
          {state.text}
          {size ? `, ${size}` : ''}
        </Text>
      </Box>
      {open ? taskDetails(c.els, task, c.r, wholeBrief($, c.s, task)) : null}
    </Box>
  )
}

function finishedCard(c: RunCtx, $: Engine): JSX.Element {
  const { Box, Text, Button, Code } = c.els
  const { r } = c
  const merged = r.tasks.filter(task => task.status === 'merged').length
  const done = r.tasks.filter(task => task.status === 'done').length
  // After Clean up: the worktrees are gone, and the workers' threads the Codex app still keeps wait to be archived there.
  const tidy = r.cleanup ?? null
  const cleaned = !!tidy && tidy.cleaned && tidy.worktrees === 0
  const open = cleaned ? (tidy?.threads ?? []) : []
  const cleanup: Decision = {
    key: 'cleanup',
    verb: 'cleanup',
    tell: false,
    done: (_, text) => readable(text, r).replace(/^Removed worktrees: [^.]*\.\s*/, 'Cleaned up the worktrees. '),
    failed: 'Could not clean up',
  }
  return (
    <Box flexDirection="column" gap={1} borderStyle="round" borderColor={r.status === 'done' ? 'success' : 'inactive'} paddingX={1}>
      <Text weight="semibold">
        {r.status === 'done'
          ? `Finished: ${plural(merged + done, 'task')} done`
          : merged > 0
            ? `Stopped after ${plural(merged, 'merged task')}`
            : 'Stopped before anything was merged'}
      </Text>
      {merged > 0 && <Text>The work is on branch {r.branch}. Merge it into your branch when you are happy with it:</Text>}
      {merged > 0 && <Code language="bash" source={`git merge ${r.branch}`} />}
      {cleaned ? (
        <Text color="success">
          ✓ Cleaned up: the worktrees are removed{open.length === 0 ? " and the workers' Codex threads archived" : ''}.
        </Text>
      ) : (
        <Text size="footnote" dimColor>
          Clean up removes the task worktrees and archives the workers' Codex threads. Work that was not merged stays on its own
          branch.
        </Text>
      )}
      {open.length > 0 ? (
        <Box flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
          <Text>
            {open.length === 1 ? 'One worker thread is' : `${open.length} worker threads are`} still open in the Codex app. Codex
            archives a thread only once the app lets go of it, which it does when it restarts. Archive{' '}
            {open.length === 1 ? 'it' : 'them'} in the Codex app now (right-click the thread, Archive), or press Archive again after
            the app restarts.
          </Text>
          {open.map(item => (
            <Box key={`open-${item.thread}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
              <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
                {agentIcon(c.els, 'codex')}
                <Box flexShrink={1}>
                  <Text>{item.name ?? item.thread}</Text>
                </Box>
              </Box>
              {c.s.canOpenCodex ? (
                <Box flexShrink={0}>
                  <Button
                    key={`codex-open-${item.thread}`}
                    plain
                    dimColor
                    label={busyLabel(c, `codex-${item.thread}`, 'Open in Codex', 'Opening…')}
                    onPress={() => inBackground(openInCodex($, item.thread))}
                  />
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="row" gap={1}>
        {!cleaned ? (
          <Button key="cleanup" variant="primary" label={busyLabel(c, 'cleanup', 'Clean up', 'Cleaning up…')} onPress={decideOn($, cleanup)} />
        ) : open.length > 0 ? (
          <Button key="cleanup" label={busyLabel(c, 'cleanup', 'Archive again', 'Archiving…')} onPress={decideOn($, cleanup)} />
        ) : null}
        <Button key="close-run" variant={cleaned ? 'primary' : undefined} label="Close run" onPress={() => inBackground(closeRun($))} />
      </Box>
    </Box>
  )
}

function mergedCount(r: RunView): number {
  return r.tasks.filter(task => ['merged', 'done'].includes(task.status)).length
}

// The steps every task of a run goes through, named with this run's own branch: what Merge does, and what comes after.
function howRunWorks(els: Els, r: RunView, lead: 'Claude' | 'Codex'): JSX.Element {
  const { Box, Text } = els
  const steps = [
    `A Codex worker builds each task on its own git branch (${r.task_branch}) in its own folder; you can watch it in the Codex app.`,
    `${lead} reviews each change when its worker reports, and sends it back with notes until it holds.`,
    ...(r.simplify ? ['A simplifier then proposes simplifications, and you pick the ones the worker applies.'] : []),
    `${r.auto_merge ? 'Tandem merges' : 'You merge'} each approved task into the run's branch ${r.branch}. A task that depends on others starts once they are merged, from that branch.`,
    `When every task is merged, you merge ${r.branch} into your own branch, or open a pull request from it. Tandem never pushes.`,
  ]
  return (
    <Box key="how-run-steps" flexDirection="column" paddingLeft={1}>
      {steps.map((step, i) => (
        <Text size="footnote">
          {i + 1}. {step}
        </Text>
      ))}
    </Box>
  )
}

// Finished tasks fold into one row under the others: what they came to, and the tasks themselves on request.
function finishedRow(c: RunCtx, $: Engine, finished: TaskState[]): JSX.Element {
  const { Box, Text, Button } = c.els
  const count = (status: string) => finished.filter(state => state.task.status === status).length
  const parts = [
    count('merged') ? `${count('merged')} merged` : '',
    count('done') ? `${count('done')} done` : '',
    count('cancelled') ? `${count('cancelled')} cancelled` : '',
  ].filter(Boolean)
  const size = totalSize(finished.filter(state => state.task.status === 'merged').map(state => state.task))
  const good = count('merged') + count('done') > 0
  const open = c.s.expanded.includes('tasks-done')
  return (
    <Box key="tasks-done" flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
        <Box flexShrink={1}>
          <Text>
            <Text color={good ? 'success' : 'inactive'}>{good ? '✓' : '–'}</Text> {parts.join(', ')}
            {size ? <Text dimColor> · {size}</Text> : null}
          </Text>
        </Box>
        <Button key="tasks-done-toggle" plain dimColor label={open ? 'Hide' : 'Show'} onPress={toggleOn($, c.s, 'tasks-done')} />
      </Box>
      {open ? finished.map(state => taskRow(c, $, state)) : null}
    </Box>
  )
}

// How much of an allowance the run has spent, as a bar and a number that turn to a warning as it fills: the worker
// turns it may start, and the Codex usage limit (as of the last turn Tandem ran).
function meter(els: Els, label: string, share: number, value: string, columns: number): JSX.Element {
  const { Box, Text } = els
  const width = Math.max(6, Math.min(24, columns - 24))
  const filled = Math.round(Math.max(0, Math.min(1, share)) * width)
  const color = share >= 0.95 ? 'error' : share >= 0.8 ? 'warning' : undefined
  const dim = share < 0.6
  return (
    <Box key={`meter-${label}`} flexDirection="row" alignItems="center" gap={1}>
      <Box width={12} flexShrink={0}>
        <Text size="footnote" dimColor>
          {label}
        </Text>
      </Box>
      <Text mono>
        <Text color={color} dimColor={dim}>
          {'━'.repeat(filled)}
        </Text>
        <Text dimColor>{'─'.repeat(width - filled)}</Text>
      </Text>
      <Text size="footnote" tabular color={color} dimColor={dim}>
        {value}
        {color ? ' ⚠' : ''}
      </Text>
    </Box>
  )
}

function runControls(c: RunCtx, $: Engine): JSX.Element {
  const { Box, Text, Button } = c.els
  const { r, s } = c
  return (
    <Box flexDirection="column" gap={1}>
      {!r.needs_approval && (
        <Text size="footnote" dimColor>
          {workersLine(r)}.{r.simplify ? ' Simplifier on.' : ''}
          {r.auto_merge ? ' Auto merge on.' : ''}
        </Text>
      )}
      {!s.watching && (
        <Button
          key="notify-toggle"
          plain
          dimColor
          label={`Notify me when the run needs me: ${s.notify ? 'on' : 'off'}`}
          onPress={() => inBackground(setNotify($, !s.notify))}
        />
      )}
      {s.confirm === 'stop-run' ? (
        <Box flexDirection="column" gap={1} borderStyle="round" borderColor="error" paddingX={1}>
          <Text>
            Stop the run? Running workers are cancelled and no new ones start. Merged work stays on the run's branch; work not
            merged yet stays on each task's own branch.
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="stop-run-confirm"
              label={busyLabel(c, 'stop-run', 'Stop run', 'Stopping…')}
              onPress={decideOn($, {
                key: 'stop-run',
                verb: 'stop',
                tell: true,
                done: () => 'Stopped the run. Running workers were cancelled.',
                failed: 'Could not stop the run',
              })}
            />
            <Button key="stop-run-keep" label="Keep running" onPress={() => inBackground(update($, confirming, () => null))} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row" gap={1}>
          {!c.answerInCodex && r.status === 'running' && r.paused !== 'budget' && (
            <Button
              key="pause-run"
              label={r.paused ? busyLabel(c, 'pause-run', 'Resume run', 'Resuming…') : busyLabel(c, 'pause-run', 'Pause run', 'Pausing…')}
              onPress={decideOn($, {
                key: 'pause-run',
                verb: r.paused ? 'resume' : 'pause',
                tell: false,
                done: () => (r.paused ? 'Resumed.' : 'Paused. Running workers finish their turn; no new ones start.'),
                failed: r.paused ? 'Could not resume the run' : 'Could not pause the run',
              })}
            />
          )}
          <Button key="stop-run" label="Stop run" onPress={() => inBackground(update($, confirming, () => 'stop-run'))} />
          {s.watching && <Button key="stop-watching" label="Stop watching" onPress={() => inBackground(closeRun($))} />}
        </Box>
      )}
    </Box>
  )
}

function byHolder(states: TaskState[]): TaskState[] {
  return [...states].sort((a, b) => HOLDER_ORDER.indexOf(a.holder) - HOLDER_ORDER.indexOf(b.holder))
}

function runView(els: Els, $: Engine, s: Snapshot, r: RunView): JSX.Element {
  const { Box, Text, Button } = els
  const lead = leadOf(r)
  const ready = r.tasks.filter(task => task.status === 'approved')
  const working = r.tasks.filter(task => WORKING.includes(task.status))
  const stalled = working.find(task => stalledFor(task, s.now) !== null)
  const keys: Hotkeys = {
    picks: r.tasks.find(task => task.status === 'proposals')?.id ?? null,
    merge: ready.length === 1 ? (ready[0]?.id ?? null) : null,
    open: s.canOpenCodex ? ((stalled ?? working.find(task => task.thread))?.id ?? null) : null,
  }
  const c: RunCtx = { els, s, r, lead, answerInCodex: s.watching && lead === 'Codex', keys }
  const states = byHolder(r.tasks.map(task => taskState(task, r)))
  const head = runHeadline(r, states, c.answerInCodex, s.now)
  const finished = r.status === 'done' || r.status === 'stopped'
  const orchestratorThread = r.orchestrator?.thread
  const who = finished
    ? !s.watching
      ? 'Claude planned and reviewed it in this session.'
      : `${lead === 'Codex' ? 'A Codex thread' : 'Another Claude session'} ran it.`
    : !s.watching
      ? 'Claude plans and reviews in this session.'
      : lead === 'Codex'
        ? "A Codex thread plans and reviews this run. You're watching it."
        : "Another Claude session runs this. You're watching it, and what you decide here still counts."
  const longGoal = r.goal.length > 180
  const wholeGoal = s.expanded.includes('goal')

  const needsYou = [
    r.needs_approval ? planCard(c, $) : null,
    r.paused === 'budget' ? budgetCard(c, $) : null,
    ready.length > 0 ? mergeCard(c, $, ready) : null,
    ...r.tasks.map(task =>
      task.status === 'proposals'
        ? picksCard(c, $, task)
        : task.status === 'blocked'
          ? stuckCard(c, $, task)
          : task.status === 'failed'
            ? failedCard(c, $, task)
            : null,
    ),
  ].filter((card): card is JSX.Element => card !== null)
  const listed = states.filter(state => !(r.needs_approval && state.task.status === 'proposed'))
  const active = listed.filter(state => !FINISHED_HOLDERS.includes(state.holder))
  const done = listed.filter(state => FINISHED_HOLDERS.includes(state.holder))
  const workersStarted = r.tasks.some(task => task.vendor === 'codex' && task.thread)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text size="footnote" dimColor>
          {s.watching ? 'Watching a run' : 'Run'} in {projectName(r)}
        </Text>
        <Text size={longGoal ? 'body' : 'heading'} weight="semibold">
          {longGoal && !wholeGoal ? clipText(r.goal, 180) : r.goal}
        </Text>
        {longGoal ? (
          <Button key="goal-more" plain dimColor label={wholeGoal ? 'Show less' : 'Show the whole goal'} onPress={toggleOn($, s, 'goal')} />
        ) : null}
        <Box flexDirection="row" alignItems="center" gap={1}>
          {!head.color && working.length > 0 ? workingMark(els, 'codex') : null}
          <Text color={head.color} weight="medium">
            {head.text}
          </Text>
        </Box>
        {!finished ? (
          <Box flexDirection="column">
            {meter(els, 'Worker turns', r.budget.used / Math.max(1, r.budget.limit), `${r.budget.used}/${r.budget.limit}`, s.columns)}
            {r.codex_quota !== null ? meter(els, 'Codex limit', r.codex_quota / 100, `${r.codex_quota}%`, s.columns) : null}
            {!c.answerInCodex && turnsRunningOut(r) ? (
              <Box flexDirection="row">{moreTurns(c, $, 'Allow 10 more worker turns', false)}</Box>
            ) : null}
          </Box>
        ) : null}
        {r.tasks.length > 0 && !r.needs_approval ? (
          <Text size="footnote" dimColor>
            Merged work collects on <Text mono>{r.branch}</Text>: {mergedCount(r)} of {plural(r.tasks.length, 'task')} so far.
          </Text>
        ) : null}
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
          <Box flexShrink={1}>
            <Text size="footnote" dimColor>
              {who}
            </Text>
          </Box>
          <Box flexDirection="row" gap={2} flexShrink={0}>
            {s.canOpenCodex && lead === 'Codex' && orchestratorThread ? (
              <Button
                key="codex-orchestrator"
                plain
                dimColor
                label={busyLabel(c, `codex-${orchestratorThread}`, 'Open in Codex', 'Opening…')}
                onPress={() => inBackground(openInCodex($, orchestratorThread))}
              />
            ) : null}
            <Button
              key="how-run"
              plain
              dimColor
              label={s.expanded.includes('how-run') ? 'Hide how it works' : 'How a run works'}
              onPress={toggleOn($, s, 'how-run')}
            />
          </Box>
        </Box>
        {s.expanded.includes('how-run') ? howRunWorks(els, r, lead) : null}
        {lead === 'Codex' && r.conductor === false && !finished && (
          <Text size="footnote" color="warning">
            Updates are not reaching Codex right now. Ask Codex in its thread to start Tandem's watcher again.
          </Text>
        )}
      </Box>
      {states.length > 0 && (
        <Box flexDirection="column">
          {batonBar(els, states, s.columns - 2)}
          {legend(els, states)}
        </Box>
      )}
      {troubleLine(els, s.runTrouble, 'the run')}
      {needsYou.length > 0 && (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold" color="warning">
            Needs you
          </Text>
          {c.answerInCodex && <Text dimColor>Codex asks you about these in its thread. Answer it there.</Text>}
          {needsYou}
        </Box>
      )}
      {working.length > 0 && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text weight="semibold">Working now</Text>
            {s.canOpenCodex && r.workers.where === 'app' && (
              <Text size="footnote" dimColor>
                Each worker is a thread named “{projectName(r)} · task” in the Codex app, where you can watch it and write to it.
              </Text>
            )}
          </Box>
          {working.map(task => workingCard(c, $, task))}
        </Box>
      )}
      {finished ? finishedCard(c, $) : null}
      {listed.length > 0 && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text weight="semibold">Tasks</Text>
            {workersStarted && s.canOpenCodex && !finished && r.workers.where === 'app' && working.length === 0 && (
              <Text size="footnote" dimColor>
                Workers show in the Codex app as “{projectName(r)} · task”.
              </Text>
            )}
          </Box>
          <Box flexDirection="column">
            {active.map(state => taskRow(c, $, state))}
            {done.length > 0 ? finishedRow(c, $, done) : null}
          </Box>
        </Box>
      )}
      {r.tasks.length === 0 && (
        <Text dimColor>
          {c.answerInCodex
            ? 'Codex is writing the plan.'
            : `${lead} is reading the code and writing the plan. It shows up here, and no worker starts until you approve it.`}
        </Text>
      )}
      {finished ? null : runControls(c, $)}
    </Box>
  )
}

// The run's tasks as one bar: done, then working, then the rest.
function progressBar(els: Els, r: RunView, width: number): JSX.Element {
  const { Text } = els
  const total = Math.max(1, r.tasks.length)
  const done = r.tasks.filter(task => ['merged', 'done'].includes(task.status)).length
  const working = r.tasks.filter(task => WORKING.includes(task.status)).length
  const doneCells = Math.round((done / total) * width)
  const workingCells = Math.min(width - doneCells, working > 0 ? Math.max(1, Math.round((working / total) * width)) : 0)
  return (
    <Text mono>
      <Text color="success">{'━'.repeat(doneCells)}</Text>
      <Text color="ide">{'━'.repeat(workingCells)}</Text>
      <Text dimColor>{'─'.repeat(width - doneCells - workingCells)}</Text>
    </Text>
  )
}

function progressText(r: RunView): string {
  const done = r.tasks.filter(task => ['merged', 'done'].includes(task.status)).length
  const working = r.tasks.filter(task => WORKING.includes(task.status)).length
  return `${done} of ${plural(r.tasks.length, 'task')} done${working > 0 ? `, ${working} working` : ''}`
}

type Band = { glyph: string; color: string; text: string; urgent: boolean; action: string }

// The band above the prompt: what needs the person first, by name (then a worker that may be stuck), else how the run
// or the conversation is going.
function runBand(r: RunView, watching: boolean, now: number): Band {
  const answerInCodex = watching && leadOf(r) === 'Codex'
  const states = r.tasks.map(task => taskState(task, r))
  const head = runHeadline(r, states, answerInCodex, now)
  const goal = quote(clipText(r.goal, 36))
  if (r.status === 'done') return { glyph: '✓', color: 'success', text: `${goal} is finished`, urgent: false, action: 'Open' }
  if (r.status === 'stopped') return { glyph: '–', color: 'inactive', text: `${goal} was stopped`, urgent: false, action: 'Open' }
  const waiting = answerInCodex ? [] : asks(r, now)
  const [first] = waiting
  if (first) {
    const more = waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''
    return { glyph: first.stalled ? '⚠' : '◆', color: 'warning', text: `${first.band}${more}`, urgent: true, action: 'Review' }
  }
  if (head.color === 'warning') return { glyph: '◆', color: 'warning', text: `${head.text} in ${goal}`, urgent: true, action: 'Review' }
  const working = states.some(state => state.holder === 'codex')
  return { glyph: '●', color: working ? 'ide' : 'claude', text: `${head.text} in ${goal}`, urgent: false, action: 'Open' }
}

function chatBand(current: RoomView): Band {
  const name = current.threadName ?? 'Codex thread'
  if (current.used >= current.limit && !current.closed) {
    return { glyph: '◆', color: 'warning', text: `Your turn: allow more messages with ${name} (/tandem more)`, urgent: true, action: 'Open in Codex' }
  }
  const status = chatStatus(current)
  return { glyph: status.glyph, color: status.color, text: `${name}: ${status.text}`, urgent: false, action: 'Open in Codex' }
}

// --- Tandem's messages in Claude's conversation ------------------------------------------------------

type Delivery =
  | { kind: 'goal'; body: string }
  | { kind: 'codex'; thread: string; head: string; body: string }
  | { kind: 'run'; head: string; body: string }

// What Tandem submitted to Claude, read back from its text: an orchestrate request, a Codex message or a run update.
function parseDelivery(text: string): Delivery | null {
  if (text.startsWith('[Tandem orchestrator]')) {
    const goal = text.split('\n\n---\n')[0] ?? ''
    return { kind: 'goal', body: goal.split('\n').slice(1).join('\n').trim() }
  }
  const end = text.lastIndexOf('\n\n---\n')
  const [first = '', ...rest] = (end >= 0 ? text.slice(0, end) : text).split('\n')
  const tagged = /^\[Tandem · ([^\]]+)\]\s*(.*?):?$/.exec(first)
  if (!tagged) return null
  const tag = tagged[1] ?? ''
  const head = tagged[2] ?? ''
  const body = rest.join('\n').trim()
  if (/^run r-[a-z0-9]+$/.test(tag)) return { kind: 'run', head, body }
  return { kind: 'codex', thread: tag, head, body }
}

function updateHead(head: string): string {
  const found = /^Update from run r-[a-z0-9]+ \((.*)\)$/.exec(head)
  return found ? `update on ${quote(found[1] ?? '')}` : readable(head, null)
}

function clipLines(text: string, count: number): string {
  const lines = text.split('\n')
  return lines.length <= count ? text : `${lines.slice(0, count).join('\n')}\n…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, cwd, () => e.cwd)
    await $.command.register({
      name: 'tandem',
      description:
        'Orchestrate Codex workers in the panel, talk live with a Codex thread, or have Codex review a change: open the panel, ' +
        'orchestrate, list, connect, start, review, post findings, allow more messages, close',
      argumentHint: USAGE,
    })
    await $.tool.register({
      name: 'send',
      description: SEND_HELP,
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: 'The self-contained message for Codex.' } },
        required: ['message'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'connect',
      description:
        'Connect this session to a Codex thread of this project so the send tool reaches it. ' +
        'thread: a number from the threads list, a thread id, or part of the thread name. Confirm the thread with the user first, ' +
        'and never connect again on your own after the user disconnected.',
      inputSchema: {
        type: 'object',
        properties: { thread: { type: 'string', description: 'Number, id or part of the name.' } },
        required: ['thread'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'start_codex',
      description:
        'Start a new Codex thread in this project, connect it, and send it a first message. The thread shows up in the ' +
        "Codex app and Codex's answer comes back here automatically. Set worktree to true when Codex will edit files " +
        "while you also edit, so each works in its own git worktree. Uses the user's Codex limits: ask the user first.",
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The self-contained first message for Codex.' },
          worktree: { type: 'boolean', description: 'Run the new Codex thread in its own git worktree.' },
        },
        required: ['message'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'review',
      description:
        'Have Codex review a change in this project, read-only, in a Codex thread of its own: a pull request (its number or ' +
        'URL), a branch, a commit, or with no target the uncommitted changes. Codex checks the bugs the change introduces, how ' +
        'it fits the codebase, tests, security and performance; its findings come back here as a new message, and you check ' +
        "each one in the code before telling the user. Uses the user's Codex limits. Posting findings to GitHub is the user's, " +
        'with /tandem post <numbers>.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'A pull request number or URL, a branch or a commit; leave out for the uncommitted changes.',
          },
          focus: { type: 'string', description: 'What the user wants looked at especially.' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'threads',
      description: "List this project's Codex threads, newest first, and which are open in a Codex app.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'ask_thread',
      description:
        'Ask an existing Codex thread a question with its full context through a read-only fork: no writes, no apps or MCP tools, ' +
        'and the original thread is not touched. Uses the user\'s Codex limits, so read first and group questions.',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: 'The Codex thread id.' },
          question: { type: 'string', description: 'A self-contained question.' },
        },
        required: ['thread', 'question'],
      },
    })
    await $.tool.register({
      name: 'orch_start',
      description:
        'Start an orchestrated run in this project: you plan and review, Tandem runs Codex workers in their own git worktrees ' +
        '(the user watches them in the Codex app), and the user approves the plan and each merge in the Tandem panel. Before ' +
        'calling, ask the user how to organize the work (preset, Codex workers at once, their reasoning effort, what they may ' +
        "do) with AskUserQuestion; /tandem orchestrate starts this. Uses the user's Codex limits.",
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the run should achieve, in a sentence or two.' },
          setup: {
            type: 'object',
            description: "The user's answers. Leave out what they did not choose.",
            properties: {
              workers: {
                type: 'object',
                properties: {
                  max_parallel: { type: 'integer', minimum: 1, maximum: 6 },
                  effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
                  model: { type: 'string', description: 'Codex model; leave out for the Codex default.' },
                  access: { type: 'string', enum: ['full', 'worktree', 'worktree+network', 'read-only'] },
                  where: {
                    type: 'string',
                    enum: ['app', 'background'],
                    description: 'app: each worker opens in the Codex app, where the user can watch and write; background: without the app.',
                  },
                },
              },
              simplify: { type: 'boolean', description: 'A fresh simplifier agent goes over each approved code task.' },
              auto_merge: {
                type: 'boolean',
                description: "Tandem merges each approved task into the run's branch itself (default); false: each waits for the user's Merge.",
              },
              fix_rounds: { type: 'integer', minimum: 0 },
              budget: { type: 'integer', minimum: 1, description: 'Worker turns the run may start before the user steps in.' },
              setup_command: { type: 'string', description: 'Runs in each new worktree first, such as npm ci.' },
              copy: { type: 'array', items: { type: 'string' }, description: 'Git-ignored files to copy into worktrees.' },
            },
          },
        },
        required: ['goal'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'orch_plan',
      description:
        "Propose the run's tasks; the user approves them in the Tandem panel. Each task: id (lowercase, digits, -), title, role, " +
        'brief (self-contained), acceptance (list), owns (paths it may change), deps (task ids merged first).',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                role: { type: 'string' },
                brief: { type: 'string' },
                acceptance: { type: 'array', items: { type: 'string' } },
                owns: { type: 'array', items: { type: 'string' } },
                deps: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'title', 'role', 'brief'],
            },
          },
        },
        required: ['tasks'],
      },
    })
    await $.tool.register({
      name: 'orch_status',
      description: "The orchestrated run's tasks, their status, diff sizes and the budget.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'orch_diff',
      description: "A task's changes against the commit it started from (read before orch_review).",
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, stat: { type: 'boolean', description: 'Only the files and line counts.' } },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'orch_review',
      description:
        "Your verdict on a reported task: approve (after the run's simplification pass, if it has one, Tandem merges it into " +
        "the run's branch, or with auto merge off it waits for the user's Merge click), or changes with concrete notes, " +
        'which the worker gets as its next turn.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          verdict: { type: 'string', enum: ['approve', 'changes'] },
          notes: { type: 'string', description: 'Required for changes: what to change and why.' },
        },
        required: ['task', 'verdict'],
      },
    })
    await $.tool.register({
      name: 'orch_send',
      description: "A message to a task's Codex worker outside a review, such as an answer to its question. It runs as the worker's next turn.",
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, message: { type: 'string' } },
        required: ['task', 'message'],
      },
    })
    await $.tool.register({
      name: 'orch_done',
      description: 'Report a task whose role runs on Claude as finished, with a short summary of the result.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, summary: { type: 'string' } },
        required: ['task', 'summary'],
      },
    })
    await $.tool.register({
      name: 'orch_stop',
      description:
        "Stop one task's worker and cancel the task, or skip a running simplifier. Stopping the whole run, and what happens " +
        "to a task that waits for the user's merge, pick or decision, are the user's, in the Tandem panel.",
      inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    })
    await $.tool.register({
      name: 'orch_note',
      description:
        "Note what the run's state does not hold, in a sentence or two: what the user told you in the chat that matters for " +
        'the run, why you sent a task back, what you learned about the codebase that later tasks need. Tandem hands your ' +
        'notes back with the run when your conversation is compacted, resumed or cleared.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The note, at most 600 characters.' } },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'hold',
      description: "Tandem's watcher waits here while Codex works. Only the watcher calls it.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.agent.register({
      name: 'watcher',
      description: 'Keeps the session marked as working while Codex works for it. Tandem starts it itself; never delegate to it.',
      prompt: WATCHER_PROMPT,
      tools: [HOLD_TOOL],
      disallowedTools: ['SubagentHandback', 'SendMessage'],
      model: 'haiku',
      effort: 'low',
      omitClaudeMd: true,
      maxTurns: HOLDS + 5,
    })
    inBackground(loadAgentIcons($))
    const saved = await $.store.get('notify').catch(() => undefined)
    if (typeof saved === 'boolean') await update($, notifyOn, () => saved)
    $.clock.every(POLL_MS, () => {
      inBackground(syncCwd($))
      inBackground(poll($))
      inBackground(pollRun($))
      inBackground(refreshBusy($))
      inBackground(tellPerson($))
    })
    return next(e)
  })

  // A press in the panel or the band means the person is there: what waits is in front of them, so no notification yet.
  on('ui.press', async ($, e, next) => {
    if (e.plugin === 'tandem') lastPress = await $.clock.now()
    return next(e)
  })

  // The transcript a queued prompt's record lands in; a /clear or a resume names a new one. A conversation that was
  // compacted, resumed or cleared while it orchestrates a run gets the run back: its state, latest events and notes.
  on('classic.SessionStart', async ($, e, next) => {
    await follow($, e.transcript_path)
    const done = await next(e)
    const journal = ['compact', 'resume', 'clear'].includes(e.source) ? await runJournal($, e.source).catch(() => null) : null
    return journal ? { ...done, additionalContext: [...(done.additionalContext ?? []), journal] } : done
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await follow($, e.transcript_path)
    return next(e)
  })

  // The watcher is Tandem's own: the model never delegates to it, and its start asks no one in any mode (auto mode's
  // classifier refuses a spawn no request asked for). Its only tool is the hold.
  on('agent.offer', { agent: WATCHER }, () => ({ isOffered: false }))

  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const input = e.input as { subagent_type?: string } | undefined
    return input?.subagent_type === WATCHER && next.origin.plugin === 'tandem' ? { decision: 'allow' } : next(e)
  })

  on('tool.call', { tool: HOLD_TOOL }, async ($, e, next) => {
    const mine = await read($, watcher)
    const id = e.agentId
    if (!mine || !id || (mine.id !== null && id !== mine.id)) return reply("Only Tandem's watcher holds.", true)
    watchers.add(id)
    await update($, watcher, w => w && { id, holds: w.holds + 1 })
    if (mine.holds >= HOLDS || !codexAtWork) {
      stoppedFor.set(id, codexAtWork ? 'hour' : 'idle')
      return reply('stop')
    }
    const held = await hold($, next.signal, (await $.clock.now()) + HOLD_MS)
    if (held === 'idle') stoppedFor.set(id, 'idle')
    return reply(held === 'idle' ? 'stop' : 'keep watching')
  }).catch(() => reply('stop'))

  // The watcher starts when Claude's turn ends while Codex works: inside a hook, where its spawn reaches tool.check (a
  // spawn from the poll's timer reaches none, and auto mode's classifier refuses it).
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const mine = await read($, watcher)
    if (mine && e.agentId !== undefined && e.agentId === mine.id) await update($, watcher, () => null)
    if (e.agentId === undefined) {
      await refreshBusy($)
      if (codexAtWork) await startWatcher($)
    }
    return done
  })

  // A watcher's hand-back (Haiku sends one even with the tool disallowed) is no news for Claude: dropped here, it costs
  // no model call. Claude Code shows the person the reason, so it says why the watcher stopped.
  on('prompt.submit', async ($, e, next) => {
    const from = /<agent-message from="([^"]+)">/.exec(e.text)?.[1]
    if (e.origin.kind === 'peer' && from && watchers.has(from)) {
      const why = stoppedFor.get(from) ?? 'other'
      stoppedFor.delete(from)
      return { drop: STOP_NOTES[why] }
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__tandem__orch_start' }, async ($, e) => {
    const goal = String(e.goal ?? '').trim()
    if (!goal) return reply('Say what the run should achieve.', true)
    let owner = ''
    try {
      owner = await $.session.id()
    } catch {
      owner = ''
    }
    const setup = JSON.stringify(e.setup ?? {})
    const started = await orchCall($, 'init', [opt('--goal', goal), opt('--setup', setup), ...(owner ? ['--owner', owner] : [])])
    if (!started.ok) return reply(started.text, true)
    await update($, observing, () => false)
    await update($, starting, () => null)
    await update($, runTrouble, () => null)
    await update($, confirming, () => null)
    inBackground(openPane($))
    return reply(`${started.text}\n\n${await orchestratorGuide($)}`)
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__tandem__orch_plan' }, async ($, e) => {
    if (!(await read($, run))) return reply('No run is open: start one with orch_start.', true)
    if (await read($, observing)) return reply(WATCHED_ONLY, true)
    const planned = await orchCall($, 'plan', [], JSON.stringify({ tasks: e.tasks ?? [] }))
    if (planned.ok) inBackground(openPane($))
    return reply(planned.text, !planned.ok)
  }).catch(toolFailed)

  for (const [name, verb, args] of [
    ['orch_status', 'status', (_: Record<string, unknown>) => []],
    ['orch_diff', 'diff', (e: Record<string, unknown>) => ['--task', String(e.task ?? ''), ...(e.stat === true ? ['--stat'] : [])]],
    ['orch_review', 'review', (e: Record<string, unknown>) => [
      '--task', String(e.task ?? ''), '--verdict', String(e.verdict ?? ''), ...(e.notes ? [opt('--notes', String(e.notes))] : []),
    ]],
    ['orch_send', 'send', (e: Record<string, unknown>) => ['--task', String(e.task ?? ''), opt('--message', String(e.message ?? ''))]],
    ['orch_done', 'done', (e: Record<string, unknown>) => ['--task', String(e.task ?? ''), opt('--summary', String(e.summary ?? ''))]],
    ['orch_stop', 'stop', (e: Record<string, unknown>) => ['--task', String(e.task ?? '')]],
    ['orch_note', 'note', (e: Record<string, unknown>) => [opt('--text', String(e.text ?? ''))]],
  ] as const) {
    on('tool.call', { tool: `mcp__tandem__${name}` }, async ($, e) => {
      if (!(await read($, run))) return reply('No run is open: start one with orch_start.', true)
      if (!['orch_status', 'orch_diff'].includes(name) && (await read($, observing))) return reply(WATCHED_ONLY, true)
      if (name === 'orch_stop' && !e.task) return reply("Name the task to stop: stopping the whole run is the user's, in the Tandem panel.", true)
      const done = await orchCall($, verb, args(e as Record<string, unknown>))
      // What the call set going comes along: a merge on approval starts the tasks that waited for it.
      return reply([done.text, ...(done.out.events ?? []).map(event => event.text)].join('\n\n'), !done.ok)
    }).catch(toolFailed)
  }

  on('tool.call', { tool: 'mcp__tandem__send' }, async ($, e) => {
    const sent = await sendMessage($, 'claude', String(e.message ?? '').trim())
    return reply(sent.ok ? `${sent.text} Codex's answer arrives here as a new message.` : sent.text, !sent.ok)
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__tandem__connect' }, async ($, e) => {
    const done = await connect($, String(e.thread ?? ''))
    return reply(done.text, !done.ok)
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__tandem__start_codex' }, async ($, e) => {
    const started = await startCodex($, String(e.message ?? ''), e.worktree === true)
    return reply(started.text, !started.ok)
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__tandem__review' }, async ($, e) => {
    const started = await startReview($, String(e.target ?? ''), String(e.focus ?? ''))
    return reply(started.text, !started.ok)
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__tandem__threads' }, async $ => {
    const listed = await loadThreads($)
    return listed.error ? reply(`Could not list Codex threads: ${listed.error}`, true) : reply(listThreads(listed.rows))
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__tandem__ask_thread' }, async ($, e) => {
    const dir = await read($, cwd)
    const ran = await runCore(
      $,
      ['ask-thread', opt('--thread', String(e.thread ?? '')), '--cd', dir || '.', '--timeout-sec', '570', opt('--message', String(e.question ?? ''))],
      600_000,
    )
    return ran.exitCode === 0 ? reply(ran.stdout.trim()) : reply(ran.stderr.trim() || 'The fork failed.', true)
  }).catch(toolFailed)

  on('command.run', { command: 'tandem' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'threads') {
      const listed = await loadThreads($)
      return { text: listed.error ? `Could not list Codex threads: ${listed.error}` : listThreads(listed.rows) }
    }
    if (verb === 'connect') {
      return { text: (await connect($, rest.join(' '))).text }
    }
    if (verb === 'close') return { text: (await closeRoom($)).text }
    if (verb === 'new') {
      const worktree = rest[0] === '--worktree'
      const started = await startCodex($, (worktree ? rest.slice(1) : rest).join(' '), worktree)
      return { text: started.text }
    }
    if (verb === 'orchestrate') {
      const goal = rest.join(' ').trim()
      if (!goal) return { text: 'Usage: /tandem orchestrate <what the run should achieve>' }
      const at = await $.clock.now()
      await update($, starting, () => ({ kind: 'goal' as const, text: goal, at }))
      inBackground(openPane($))
      inBackground(orchestratePrompt($, goal).then(prompt => submitPrompt($, prompt)))
      return { text: 'Tandem orchestrator: Claude first asks how you want the work organized.' }
    }
    if (verb === 'review') return { text: (await startReview($, rest.join(' '))).text }
    // The person's own gates for a conversation, which no agent passes: more messages, and posting a review's findings.
    if (verb === 'more' || verb === 'post') {
      if (!PERSON.includes(e.origin.kind)) return { text: `/tandem ${verb} is the user's: type it yourself.` }
      return { text: (verb === 'more' ? await allowMore($) : await postReview($, rest.join(','))).text }
    }
    if (verb !== '') {
      return { text: `Usage: /tandem ${USAGE}` }
    }
    await openPane($)
    return { text: 'Tandem panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const s = await snapshot($, e.props.bodyColumns, e.props.scroll.bodyRows, e.surface)
    drawingOn = e.surface
    const { Box } = els
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        {flashLine(els, $, s)}
        {s.run ? runView(els, $, s, s.run) : orchestrateStart(els, $, s)}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const orchestrated = await read($, run)
    const current = await read($, room)
    if ((!current && !orchestrated) || e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    const band = orchestrated
      ? runBand(orchestrated, await read($, observing), now)
      : current
        ? chatBand(current)
        : null
    if (!band) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // While Codex works, the band shows it moving: a spinner, the run's progress and the last step a worker took.
    const working = orchestrated ? orchestrated.tasks.filter(task => WORKING.includes(task.status)) : []
    const live = !!orchestrated && orchestrated.tasks.length > 0 && !['done', 'stopped'].includes(orchestrated.status)
    const latest = working.find(task => task.activity)
    // Most of the Codex usage limit spent shows here too, before the run stops on it.
    const quota = live ? (orchestrated?.codex_quota ?? null) : null
    drawingOn = e.surface
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          {!band.urgent && (working.length > 0 || (!orchestrated && current?.turnRunning)) ? (
            workingMark(els, 'codex')
          ) : (
            <Text color={band.color}>{band.glyph}</Text>
          )}
          <Box flexShrink={0}>
            <Text weight="semibold">Tandem</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={band.urgent ? 'warning' : undefined} dimColor={!band.urgent}>
              {band.text}
              {quota !== null && quota >= 80 ? <Text color={quota >= 95 ? 'error' : 'warning'}> · Codex {quota}%</Text> : null}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Button
              key="open"
              plain
              label={band.action}
              // A conversation has no view in the panel: its thread opens in the Codex app.
              onPress={() => inBackground(orchestrated || !current ? openPane($, band.urgent) : openInCodex($, current.thread))}
            />
          </Box>
        </Box>
        {live && orchestrated ? (
          <Box flexDirection="row" gap={1} alignItems="center" paddingLeft={2}>
            {progressBar(els, orchestrated, 16)}
            <Box flexShrink={1}>
              <Text size="footnote" dimColor>
                {progressText(orchestrated)}
                {latest ? ` · ${latest.title}: ${lastStep(latest, now)}` : ''}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, async ($, e, next) => {
    const origin = e.props.origin as { kind: string; name?: string }
    if (origin.name !== 'tandem' || e.props.isExpanded) return next(e)
    const delivery = parseDelivery(e.props.text)
    if (!delivery) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    if (delivery.kind === 'goal') {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text color="claude" weight="semibold">
            You asked Claude to orchestrate
          </Text>
          <Text>{delivery.body}</Text>
        </Box>
      )
    }
    if (delivery.kind === 'codex') {
      const missed = delivery.head.startsWith('Codex did not answer')
      const color = missed ? 'warning' : 'ide'
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          <Text>
            <Text color={color} weight="semibold">
              Codex
            </Text>
            <Text dimColor>
              {' '}
              {delivery.head.replace(/^Codex /, '')} in {delivery.thread}
            </Text>
          </Text>
          {delivery.body ? <Markdown key="body" text={delivery.body} /> : null}
        </Box>
      )
    }
    if (!delivery.body) {
      return (
        <Text dimColor>
          Tandem told Claude: {readable(delivery.head, null)}
        </Text>
      )
    }
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
        <Text>
          <Text weight="semibold">Tandem</Text>
          <Text dimColor> {updateHead(delivery.head)}</Text>
        </Text>
        <Markdown key="body" text={clipLines(delivery.body, 12)} dimColor />
      </Box>
    )
  })
}
