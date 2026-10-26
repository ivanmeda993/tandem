export type ChatEntry = {
  id: string
  from: 'claude' | 'codex' | 'user' | 'notice'
  numbers: number[]
  text: string
  at: number
  // The conversation it belongs to: the panel shows only the open conversation's entries.
  room?: string
}

export type RoomView = {
  name: string
  root: string
  thread: string
  threadName: string | null
  limit: number
  used: number
  turnRunning: boolean
  pending: number[]
  closed: boolean
  // A review room: what Codex reviews and, once it answered, its findings.
  review?: ReviewView | null
}

// One problem Codex found in a change: P0 (blocks release) to P3 (minor), where it is, and why.
export type ReviewFinding = {
  id: number
  priority: number
  kind: string
  title: string
  body: string
  file: string
  line_start: number
  line_end: number
  confidence: number
}

export type ReviewView = {
  kind: 'pr' | 'branch' | 'commit' | 'uncommitted'
  label: string
  pr?: { number: number; title: string; url: string | null; head_sha: string } | null
  result?: {
    n: number
    verdict: 'correct' | 'incorrect' | null
    explanation: string
    findings: ReviewFinding[]
    // The findings the person posted to the pull request, and where.
    posted?: { url: string; items: number[]; inline: boolean } | null
  } | null
}

export type ThreadRow = {
  id: string
  name: string | null
  branch: string | null
  updated: string
  updatedTs: number | null
  openIn: string | null
  // A worker of an orchestrated run: the run's, not a thread to talk to.
  worker: boolean
  // For a thread with no name: the opening words of its first message.
  preview?: string | null
}

// A run of this project, as `tandem orch list` reports it.
export type RunRow = {
  id: string
  goal: string
  status: string
  owner: string | null
  orchestrator: 'claude' | 'codex'
}

// An orchestrated run as `tandem orch poll` reports it.
export type TaskView = {
  id: string
  title: string
  role: string
  vendor: 'codex' | 'claude'
  status: string
  phase: string | null
  deps: string[]
  turns: number
  fix_rounds: number
  diffstat: string | null
  thread: string | null
  error: string | null
  minutes: number | null
  proposals: Proposal[]
  // What the plan says about the task; absent from cores before 0.1.0's run details.
  brief?: string
  acceptance?: string[]
  owns?: string[]
  // A read-only role's task: it changes no files, so it waits for no one's paths and ends done, with nothing to merge.
  read_only?: boolean
  // While its worker runs: what it did last in its turn (from its Codex thread), and when.
  activity?: { text: string; at: number | null } | null
  // A pending task: the tasks it waits for (unfinished dependencies, unmerged work on the same paths).
  waits_for?: string[]
  // The simplifier's proposals stay after the pick: `applied` names the ones the user picked, and its summary says why.
  applied?: number[]
  simplifier_summary?: string | null
  // What the worker reported last, the reviewer's notes, and the files the task changed (lines added and removed).
  report?: string | null
  review?: string | null
  files?: { path: string; added: number | null; removed: number | null }[]
}

// One of the simplifier's proposals, waiting for the user's pick.
export type Proposal = {
  id: number
  kind: string
  where: string
  why: string
  lines_removed: number
  risk?: string
  // Exactly what to edit, and the test that shows the behaviour stays.
  change?: string
  proof?: string
}

export type RunView = {
  id: string
  root: string
  goal: string
  status: 'planning' | 'running' | 'done' | 'stopped'
  paused: string | null
  needs_approval: boolean
  branch: string
  budget: { used: number; limit: number }
  // where: in the Codex app, which opens each worker's thread, or in the background
  workers: { model: string | null; effort: string; max_parallel: number; access: string; where: 'app' | 'background' }
  simplify: boolean
  setup_command: string | null
  copy: string[]
  codex_quota: number | null
  // Who plans and reviews: a Claude session, or a Codex thread that Tandem's conductor keeps informed.
  orchestrator?: { vendor: 'claude' | 'codex'; thread?: string; session?: string | null }
  conductor?: boolean | null
  // A finished run: what Clean up left (worktrees on disk; the workers' Codex threads not archived yet, which the
  // Codex app keeps while it has them open) and whether it ran.
  cleanup?: { worktrees: number; threads: { thread: string; name: string | null; task: string }[]; cleaned: boolean } | null
  tasks: TaskView[]
}

// What the last action in a tab came to: shown at the top of that tab (`home` is from before the tabs: any tab).
export type Flash = {
  scope: 'home' | 'run' | 'chat' | 'archived'
  tone: 'done' | 'error'
  text: string
  at: number
}

// A list the panel loads from the core, and how that went.
export type LoadState = {
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  at: number
}

// A run, a thread or a review the person started from the panel that has not opened yet.
export type Starting = {
  kind: 'goal' | 'thread' | 'review'
  text: string
  at: number
}

// A poll that keeps failing; the panel shows it from the second failure in a row.
export type Trouble = {
  text: string
  count: number
}

declare module 'claude-code' {
  interface PluginState {
    tandem: {
      room: RoomView | null
      entries: ChatEntry[]
      threads: ThreadRow[]
      // the project's archived Codex threads, for the Archived tab
      archived: ThreadRow[]
      paused: boolean
      held: string[]
      cwd: string
      run: RunView | null
      picks: Record<string, number[]>
      // the open tab; auto: the run when there is one, else the connected thread, else the start of a run
      // (home is from before the tabs and reads as auto)
      view: 'auto' | 'home' | 'run' | 'chat' | 'archived'
      runs: RunRow[]
      observing: boolean
      // keys of the panel's actions in flight
      busy: string[]
      flash: Flash | null
      loads: { threads: LoadState; runs: LoadState; archived?: LoadState }
      starting: Starting | null
      // the key of a stop the person has to confirm
      confirm: string | null
      // the parts the person opened: a task's details, a proposal's change, the whole goal, the older threads
      expanded: string[]
      runTrouble: Trouble | null
      chatTrouble: Trouble | null
      // the background agent that keeps the session marked as working while Codex works; its id comes with its first hold
      watcher: { id: string | null; holds: number } | null
      // whether Tandem notifies the person when a run waits for them (kept in the plugin's store between sessions)
      notify: boolean
    }
  }
}
