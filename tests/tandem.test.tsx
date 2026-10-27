import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const THREAD = '01a17000-0000-7000-8000-000000000001'
const WORKER = '01a17000-0000-7000-8000-000000000003'
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const PANE = {
  plugin: 'tandem',
  component: 'Pane',
  requestId: 'tandem',
  props: {
    title: 'Tandem',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const
const BAND = {
  plugin: 'tandem',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const QUIET = { closed: false, turn_running: false, pending: [], limit: 20, used: 1, events: [] }

function ok(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

function failed(stderr: string) {
  return { value: { exitCode: 2, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

// Stands for the engine beneath the plugin: commands, tools and panes register.
function engine(on: On) {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'tandem' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__tandem__${e.name}` } }))
  on('agent.register', (_, e) => ({ value: { agent: `tandem:${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return clock
}

function prompts(on: On) {
  const texts: string[] = []
  on('prompt.submit', (_, e) => {
    texts.push(e.text)
    return { text: e.text }
  })
  return texts
}

// Every Text the drawing shows, as one string: what a person reads.
async function shown(ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) {
  return (await ui.findAll({ type: 'Text' })).map(found => found.text).join('\n')
}

// Stands for the tandem core script: answers each subcommand like the real one; `answers` replaces a verb's answer.
function core(on: On, polls: object[], openRoom = 'review-the-settings-screen-c6377805', answers: Record<string, () => object> = {}) {
  const calls: string[][] = []
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const verb = argv[1] ?? ''
    const answer = answers[verb]
    if (answer) return answer()
    if (verb === 'threads') {
      return ok(JSON.stringify([
        { id: THREAD, name: 'Review the settings screen', branch: 'main', updated: '2026-10-25 11:56', open_in: 'Codex app' },
      ]))
    }
    if (verb === 'open') {
      return ok(JSON.stringify({
        room: openRoom,
        root: '/repo',
        thread: THREAD,
        thread_name: 'Review the settings screen',
        limit: 20,
        used: 0,
      }))
    }
    if (verb === 'new-codex') {
      return ok(JSON.stringify({ room: argv[3], root: '/repo', thread: THREAD, thread_name: null, limit: 20, used: 1, sent: 1 }))
    }
    if (verb === 'send') return ok(`#${calls.filter(c => c[1] === 'send').length} queued for Codex thread ${THREAD}`)
    if (verb === 'poll') return ok(JSON.stringify(polls.shift() ?? QUIET))
    return ok('')
  })
  return calls
}

test('send without a connected thread says what to do', async ($, on) => {
  engine(on)
  core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ran = await $.tool.call({ tool: 'mcp__tandem__send', message: 'hi' })

  expect(JSON.stringify(ran)).toContain('No Codex thread is connected')
})

test('connect joins the room Codex opened for the thread', async ($, on) => {
  engine(on)
  const calls = core(on, [], 'from-codex')
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const connected = await $.tool.call({ tool: 'mcp__tandem__connect', thread: THREAD })
  await $.tool.call({ tool: 'mcp__tandem__send', message: 'Ready.' })

  expect(JSON.stringify(connected)).toContain('room from-codex')
  expect(calls.some(c => c[1] === 'open' && c.includes('--join'))).toBe(true)
  const send = calls.find(c => c[1] === 'send') ?? []
  expect(send[send.indexOf('--room') + 1]).toBe('from-codex')
})

test('a Codex answer reaches Claude as a prompt and shows in the panel', async ($, on) => {
  const clock = engine(on)
  const answer = { ...QUIET, events: [{ type: 'answer', numbers: [1], text: 'Pages 1-4 match the design.' }] }
  const calls = core(on, [answer])
  const texts = prompts(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const connected = await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' })
  expect(JSON.stringify(connected)).toContain('Review the settings screen')
  await $.tool.call({ tool: 'mcp__tandem__send', message: 'Which pages differ?' })
  expect(calls.some(c => c[1] === 'send' && c.includes('claude') && c.includes('--message=Which pages differ?'))).toBe(true)

  await clock.advance(2000)
  await clock.advance(0)

  expect(texts.length).toBe(1)
  expect(texts[0]).toContain('Codex answered #1')
  expect(texts[0]).toContain('not from the user')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Markdown', text: /Which pages differ\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Pages 1-4 match the design/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'answer to #1' })).toBeDefined()
    await ui.unmount()
  }
})

test('the person can message Codex from the panel', async ($, on) => {
  engine(on)
  const calls = core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No messages yet/ })).toBeDefined()
  await ui.input({ key: 'say', text: 'Keep Figma read-only for now' })
  expect(await ui.find({ type: 'Text', text: /No messages yet/ })).toBeUndefined()
  await ui.unmount()

  const sent = calls.find(c => c[1] === 'send')
  expect(sent?.includes('user')).toBe(true)
  expect(sent?.includes('--message=Keep Figma read-only for now')).toBe(true)
})

test('a message the core could not send is shown in the conversation', async ($, on) => {
  engine(on)
  core(on, [], undefined, { send: () => failed('tandem: codex queue did not answer in 30s') })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'say', text: 'Are you there?' })

  expect(await ui.find({ type: 'Text', text: /Could not send your message: codex queue did not answer in 30s/ })).toBeDefined()
  await ui.unmount()
})

test('Open in Codex opens the thread in the Codex app', async ($, on) => {
  engine(on)
  const calls = core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'codex-thread' })
  await ui.unmount()
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.find({ key: 'codex-thread' })).toBeUndefined()
  await phone.unmount()

  expect(calls.some(c => c[0] === '/usr/bin/open' && c[1] === `codex://threads/${THREAD}`)).toBe(true)
})

test('pause holds Codex answers until resumed', async ($, on) => {
  const clock = engine(on)
  core(on, [{ ...QUIET, events: [{ type: 'answer', numbers: [1], text: 'Done.' }] }])
  const texts = prompts(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pause' })
  await clock.advance(2000)
  await clock.advance(0)
  expect(texts.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /answers are on hold: 1 waiting/ })).toBeDefined()

  await ui.press({ key: 'pause' })
  expect(texts.length).toBe(1)
  await ui.unmount()
})

test('Claude can start a new Codex thread in its own worktree', async ($, on) => {
  engine(on)
  const calls = core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ran = await $.tool.call({ tool: 'mcp__tandem__start_codex', message: 'Review the retry plan', worktree: true })

  expect(JSON.stringify(ran)).toContain('own git worktree')
  const started = calls.find(c => c[1] === 'new-codex')
  expect(started?.includes('--worktree')).toBe(true)
  expect(started?.includes('--message=Review the retry plan')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Markdown', text: /Review the retry plan/ })).toBeDefined()
  await ui.unmount()
})

const REVIEW = {
  kind: 'pr',
  label: 'PR #7 “Add the greeting”',
  pr: { number: 7, title: 'Add the greeting', url: 'https://github.com/acme/app/pull/7', head_sha: 'abc123' },
}
const REVIEWED = {
  ...QUIET,
  events: [{ type: 'answer', numbers: [1], text: 'Codex reviewed PR #7 “Add the greeting”: 2 findings.' }],
  review: {
    ...REVIEW,
    result: {
      n: 1,
      verdict: 'incorrect',
      explanation: 'An empty name prints a blank greeting.',
      findings: [
        { id: 1, priority: 1, kind: 'bug', title: 'Handle an empty name', body: 'An empty name prints `hi `.', file: 'greet.py', line_start: 1, line_end: 1, confidence: 0.9 },
        { id: 2, priority: 2, kind: 'fit', title: 'Use the existing say helper', body: '`say()` in util.py does this.', file: 'greet.py', line_start: 1, line_end: 2, confidence: 0.7 },
      ],
    },
  },
}

test('Claude has Codex review a pull request; the findings show in the panel and the user posts the ones they pick', async ($, on) => {
  const clock = engine(on)
  const calls = core(on, [REVIEWED], 'unused', {
    review: () =>
      ok(JSON.stringify({ room: 'review-pr-7', root: '/repo', thread: THREAD, thread_name: null, limit: 20, used: 1, sent: 1, review: REVIEW })),
    'review-post': () => ok(JSON.stringify({ url: 'https://github.com/acme/app/pull/7#pullrequestreview-1', posted: 1, inline: true })),
  })
  const texts = prompts(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const started = await $.tool.call({ tool: 'mcp__tandem__review', target: '7', focus: 'the empty name' })
  expect(JSON.stringify(started)).toContain('Codex is reviewing PR #7')
  const review = calls.find(c => c[1] === 'review') ?? []
  expect([review.find(arg => arg.startsWith('--target=')), review.find(arg => arg.startsWith('--focus='))]).toEqual(['--target=7', '--focus=the empty name'])
  await clock.advance(2000)
  await clock.advance(0)

  // Claude checks each finding before the user hears of it.
  expect(texts.length).toBe(1)
  expect(texts[0]).toContain('check each finding in the code yourself')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = await shown(ui)
  expect(text).toContain('PR #7 “Add the greeting”')
  expect(text).toContain('2 findings')
  expect(text).toContain('Codex finds the change incorrect')
  expect(text).toContain('Handle an empty name')
  expect(text).toContain('greet.py:1–2 · 70% sure')
  expect(text.indexOf('Handle an empty name')).toBeLessThan(text.indexOf('Use the existing say helper'))
  expect(await ui.find({ type: 'Markdown', text: /Codex reviewed PR #7/ })).toBeUndefined() // the card stands for it

  await ui.press({ key: 'pick-finding-1' })
  await ui.press({ key: 'post-review' })
  expect(await shown(ui)).toContain('Post 1 finding as a review on PR #7?')
  expect(calls.some(c => c[1] === 'review-post')).toBe(false) // nothing reaches GitHub before the user confirms
  await ui.press({ key: 'post-review-confirm' })
  const post = calls.find(c => c[1] === 'review-post') ?? []
  expect([post[post.indexOf('--room') + 1], post[post.indexOf('--items') + 1]]).toEqual(['review-pr-7', '1'])
  expect(await shown(ui)).toContain('Posted 1 finding to the pull request, each on its lines.')
  await ui.unmount()
})

test('All chats shows the list while the conversation stays connected, and Back to it returns', async ($, on) => {
  engine(on)
  core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shown(ui)).toContain('Talking with Codex')
  await ui.press({ key: 'all-chats' })
  const list = await shown(ui)
  expect(list).toContain('Connected to Review the settings screen')
  expect(list).toContain('Talk with Codex')
  expect(list).toContain('Review a change')
  await ui.press({ key: 'back-to-chat' })
  expect(await shown(ui)).toContain('Talking with Codex')
  await ui.unmount()
})

const RUN = {
  id: 'r-test1',
  root: '/repo',
  goal: 'Add dark mode',
  status: 'planning',
  paused: null,
  needs_approval: false,
  branch: 'tandem/r-test1',
  task_branch: 'tandem/r-test1-<task>',
  budget: { used: 0, limit: 40 },
  workers: { model: null, effort: 'high', max_parallel: 2, access: 'worktree', where: 'app' },
  simplify: true,
  auto_merge: false,
  setup_command: null,
  copy: [],
  codex_quota: null,
  tasks: [] as object[],
}
const TASK = {
  id: 'a',
  title: 'Theme tokens',
  role: 'implementer',
  vendor: 'codex',
  status: 'proposed',
  phase: null,
  deps: [],
  turns: 0,
  fix_rounds: 0,
  diffstat: null,
  thread: null,
  error: null,
  minutes: null,
  proposals: [],
}
const PROPOSED = { ...RUN, needs_approval: true, tasks: [TASK] }
const RUNNING = { ...RUN, status: 'running', tasks: [{ ...TASK, status: 'running', minutes: 1 }] }
// One task in each state a person meets during a run.
const MIXED = {
  ...RUN,
  status: 'running',
  budget: { used: 7, limit: 40 },
  tasks: [
    { ...TASK, status: 'merged', diffstat: ' 3 files changed, 40 insertions(+), 2 deletions(-)', thread: THREAD },
    { ...TASK, id: 'b', title: 'Settings screen', status: 'running', minutes: 4, thread: WORKER },
    { ...TASK, id: 'c', title: 'Dark icons', status: 'approved', diffstat: ' 1 file changed, 5 insertions(+)', thread: THREAD },
    { ...TASK, id: 'd', title: 'Docs', status: 'pending', deps: ['b'] },
    { ...TASK, id: 'e', title: 'Contrast check', status: 'blocked', fix_rounds: 2 },
    { ...TASK, id: 'f', title: 'Old styles', status: 'failed', error: 'the worker exited\nTraceback' },
  ],
}

// Stands for `tandem orch ...`: answers each verb like the real core, and records argv and stdin. `answers.notifier`
// answers for Tandem's notifier app, which otherwise posts.
// `tap` sees each call first and may hold it.
function orchCore(
  on: On,
  polls: object[],
  answers: Record<string, () => object> = {},
  tap: (argv: string[]) => Promise<void> | void = () => undefined,
) {
  const calls: { argv: string[]; stdin?: string }[] = []
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    calls.push({ argv, stdin: e.init?.stdin })
    await tap(argv)
    const verb = argv[2] ?? ''
    if (argv[0]?.endsWith(NOTIFIER)) return answers.notifier?.() ?? ok('')
    if (argv[1] !== 'orch') return ok(argv[1] === 'threads' ? '[]' : '')
    const answer = answers[verb]
    if (answer) return answer()
    if (verb === 'roles') {
      return ok(JSON.stringify({
        implementer: { vendor: 'codex', access: 'worktree', summary: 'Builds code.' },
        designer: { vendor: 'claude', access: 'none', summary: 'Figma design.' },
      }))
    }
    if (verb === 'list') return ok('[]')
    if (verb === 'init') return ok(JSON.stringify({ ok: true, text: 'Started run r-test1.', run: RUN }))
    if (verb === 'plan') return ok(JSON.stringify({ ok: true, text: 'Plan submitted: 1 tasks.', run: PROPOSED }))
    if (verb === 'approve') {
      return ok(JSON.stringify({ ok: true, text: 'The user approved the plan (1 tasks). Workers started: a.', run: RUNNING }))
    }
    if (verb === 'poll') return ok(JSON.stringify(polls.shift() ?? { run: RUNNING, events: [] }))
    return ok(JSON.stringify({ ok: true, text: `${verb} done`, run: RUNNING }))
  })
  return calls
}

// A run this session started, after one poll: the core's first poll answer is the state the test wants.
async function startRun($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__orch_start', goal: 'Add dark mode' })
  await clock.advance(2000)
  await clock.advance(0)
}

test('orch_start opens a run and gives Claude the workflow and roles', async ($, on) => {
  engine(on)
  const calls = orchCore(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const started = JSON.stringify(
    await $.tool.call({ tool: 'mcp__tandem__orch_start', goal: 'Add dark mode', setup: { workers: { max_parallel: 3, where: 'background' } } }),
  )
  expect(started).toContain('Started run r-test1')
  expect(started).toContain('implementer (Codex worker)')
  expect(started).toContain('designer (Claude: you do it)')
  expect(started).toContain('a Codex thread named \\"<project> · <task>\\"')
  expect(calls.find(c => c.argv[2] === 'init')?.argv.includes('--setup={"workers":{"max_parallel":3,"where":"background"}}')).toBe(true)

  const planned = await $.tool.call({
    tool: 'mcp__tandem__orch_plan',
    tasks: [{ id: 'a', title: 'Theme tokens', role: 'implementer', brief: 'Add the tokens' }],
  })
  expect(JSON.stringify(planned)).toContain('Plan submitted')
  const plan = calls.find(c => c.argv[2] === 'plan')
  expect(plan?.argv.includes('r-test1')).toBe(true)
  expect(plan?.stdin).toContain('"Theme tokens"')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.drawn()).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Review the plan' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'A Codex worker builds it.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /at a time in the Codex app, high effort/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /In the Codex app you can watch each worker and write to it/ })).toBeDefined()
    expect(await ui.find({ key: 'approve-plan' })).toBeDefined()
    await ui.unmount()
  }
})

test('the user approves the plan in the panel and Claude hears of it', async ($, on) => {
  const clock = engine(on)
  const calls = orchCore(on, [])
  const texts = prompts(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__orch_start', goal: 'Add dark mode' })
  await $.tool.call({ tool: 'mcp__tandem__orch_plan', tasks: [{ id: 'a', title: 'Theme tokens', role: 'implementer', brief: 'x' }] })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'approve-plan' })
  await clock.advance(0)

  expect(calls.some(c => c.argv[2] === 'approve' && c.argv.includes('r-test1'))).toBe(true)
  expect(texts.some(text => text.includes('The user approved the plan'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Plan approved\. One Codex worker started\./ })).toBeDefined()
  await ui.unmount()
})

test('the user sends the plan back to Claude with what to change', async ($, on) => {
  engine(on)
  const calls = orchCore(on, [], {
    reject: () => ok(JSON.stringify({ ok: true, text: 'The user rejected the proposed tasks (a).', run: RUN })),
  })
  const texts = prompts(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__orch_start', goal: 'Add dark mode' })
  await $.tool.call({ tool: 'mcp__tandem__orch_plan', tasks: [{ id: 'a', title: 'Theme tokens', role: 'implementer', brief: 'x' }] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'plan-changes', text: 'Split the tokens from the icons' })

  expect(calls.some(c => c.argv[2] === 'reject')).toBe(true)
  expect(texts.some(text => text.includes('Split the tokens from the icons') && text.includes('orch_plan'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Sent your changes to Claude/ })).toBeDefined()
  await ui.unmount()
})

test("the workers' digest reaches Claude as one prompt", async ($, on) => {
  const clock = engine(on)
  orchCore(on, [{ run: RUNNING, events: [{ type: 'digest', text: 'Update from run r-test1: a reported' }] }])
  const texts = prompts(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__orch_start', goal: 'Add dark mode' })

  await clock.advance(2000)
  await clock.advance(0)

  expect(texts.length).toBe(1)
  expect(texts[0]).toContain('Update from run r-test1: a reported')
  expect(texts[0]).toContain('not from the user')
})

test('the run view leads with what needs the person and reads each task plainly, on every surface', async ($, on) => {
  const clock = engine(on)
  orchCore(on, [{ run: MIXED, events: [] }])
  await startRun($, clock)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.drawn()).toBeDefined()
    const text = await shown(ui)
    expect(text).toContain('Your turn: 3 decisions waiting')
    expect(text).toContain('Needs you')
    expect(text).toContain('Ready to merge')
    expect(text).toContain('“Contrast check” is stuck')
    expect(text).toContain('Codex is working on it, 4 min')
    expect(text).toContain('Waits for “Settings screen”')
    expect(text).toContain('Failed: the worker exited')
    expect(text).toContain('2 need you')
    // The run's id shows only as part of its branch, which the person merges at the end.
    expect(text.replaceAll('tandem/r-test1', '')).not.toContain('r-test1')
    expect(text).toContain("Claude reviewed and approved it. Merge commits its changes and adds them to the run's branch tandem/r-test1")
    expect(text).toContain('Merged work collects on tandem/r-test1: 1 of 6 tasks so far.')
    expect(text.indexOf('Needs you')).toBeLessThan(text.indexOf('Tasks'))
    // The list leads with what needs the person, then what an agent has, what waits and what failed; finished tasks
    // fold into one row at the end.
    const list = text.slice(text.indexOf('Tasks'))
    const order = ['Ready to merge, 1 file, +5', 'Needs your decision', 'Codex is working on it', 'Waits for', 'Failed:', '1 merged · 3 files, +40 −2']
    const at = order.map(part => list.indexOf(part))
    expect(at.every(n => n >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(list).not.toContain('Merged, 3 files')
    expect(await ui.find({ key: 'merge-c' })).toBeDefined()
    expect(await ui.find({ key: 'accept-e' })).toBeDefined()
    expect(Boolean(await ui.find({ key: 'codex-b' }))).toBe(surface !== 'mobile')
    expect(text.includes('Each worker is a thread named “repo · task” in the Codex app')).toBe(surface !== 'mobile')
    await ui.unmount()
  }
})

test('working agents show what they are doing, with a spinner where the surface draws SVG', async ($, on) => {
  const clock = engine(on)
  const working = {
    ...RUNNING,
    tasks: [{ ...TASK, status: 'running', minutes: 3, thread: WORKER, activity: { text: 'Ran npm test', at: null } }],
  }
  orchCore(on, [{ run: working, events: [] }])
  await startRun($, clock)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = await shown(ui)
    expect(text).toContain('Working now')
    expect(text).toContain('Last: Ran npm test')
    expect(text).toContain('3 min')
    expect(Boolean(await ui.find({ type: 'Svg' }))).toBe(surface !== 'terminal')
    await ui.unmount()
  }
  // The band above the prompt shows the run moving, in Claude's chat: progress and the worker's last step.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = await shown(band)
  expect(text).toContain('0 of 1 task done, 1 working')
  expect(text).toContain('Theme tokens: Ran npm test')
  await band.unmount()
  const tab = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await tab.find({ key: 'tab-run' })).toBeDefined()
  await tab.unmount()
})

test('the plan shows each task in full when asked, and a stopping task says where to stop it', async ($, on) => {
  const clock = engine(on)
  const detailed = {
    ...PROPOSED,
    tasks: [{ ...TASK, brief: 'Add the color tokens for the dark theme.', acceptance: ['Tokens exist for both themes'], owns: ['src/theme'] }],
  }
  orchCore(on, [{ run: detailed, events: [] }])
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Markdown', text: /color tokens/ })).toBeUndefined()
  // The brief's opening shows under the task; a plan that all starts when approved needs no step headings.
  const closed = await shown(ui)
  expect(closed).toContain('Add the color tokens for the dark theme.')
  expect(closed).not.toContain('when you approve')
  await ui.press({ key: 'details-a' })
  expect(await ui.find({ type: 'Markdown', text: /color tokens/ })).toBeDefined()
  expect(await shown(ui)).toContain('• Tokens exist for both themes')
  expect(await shown(ui)).toContain('May change: src/theme')
  await ui.press({ key: 'plan-details' })
  expect(await ui.find({ type: 'Markdown', text: /color tokens/ })).toBeUndefined()
  await ui.unmount()
})

test('the plan card says what Approve plan does and shows the tasks in the order they start, on every surface', async ($, on) => {
  const clock = engine(on)
  const invite =
    'Build the invite screen with the accept and decline buttons, the name and avatar of the person who invited you, the date ' +
    'and place of the event, a link to its page, and an error state for invites that expired'
  // Two workers at a time: the store and the research start at once, the tokens when a worker is free. The invite
  // screen may change the store's paths, the feed needs the research, and the browser check needs the screen.
  const plan = {
    ...PROPOSED,
    tasks: [
      { ...TASK, title: 'Session store', owns: ['src/auth'], brief: 'Keep the session store in src/auth. It must survive a restart.' },
      { ...TASK, id: 'b', title: 'Invite research', role: 'researcher', read_only: true, brief: 'Find how invites are sent today.' },
      { ...TASK, id: 'c', title: 'Invite screen', owns: ['src/auth/invite'], brief: invite },
      { ...TASK, id: 'd', title: 'Theme tokens', owns: ['src/theme'], brief: 'Add the dark theme tokens.' },
      { ...TASK, id: 'e', title: 'Event feed', deps: ['b'], owns: ['src/events'], brief: 'Show the events.' },
      { ...TASK, id: 'f', title: 'Browser check', role: 'browser-tester', vendor: 'claude', deps: ['c'], brief: 'Check the invite flow.' },
    ],
  }
  orchCore(on, [{ run: plan, events: [] }])
  await startRun($, clock)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.drawn()).toBeDefined()
    const text = await shown(ui)
    expect(text).toContain(
      'Approve plan starts Codex workers on the tasks that are ready, each on its own branch tandem/r-test1-<task>, in a ' +
        'thread you can watch in the Codex app. Nothing reaches your branch: Claude reviews every change, and each one comes ' +
        'back here for you to merge.',
    )
    const order = [
      'Start when you approve',
      'Session store',
      'Keep the session store in src/auth. It must survive a restart.',
      'Invite research',
      'Theme tokens',
      'Starts when a worker is free (2 workers at a time).',
      'After “Session store” is merged and “Invite research” is done',
      'Invite screen',
      'Waits for “Session store” to be merged first: it may change src/auth/invite too.',
      'Event feed',
      'A Codex worker builds it once “Invite research” is done.',
      'After “Invite screen” is merged',
      'Browser check',
      'Claude tests it in a browser once “Invite screen” is done.',
    ]
    const at = order.map(part => text.indexOf(part))
    expect(at.every(n => n >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    // A brief longer than the card's line is cut between words, with an ellipsis.
    const summary = (await ui.find({ type: 'Text', text: /^Build the invite screen/ }))?.text ?? ''
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(160)
    expect(invite.startsWith(summary.slice(0, -1))).toBe(true)
    expect(invite.charAt(summary.length - 1)).toBe(' ')
    const approve = await ui.find({ key: 'approve-plan' })
    expect(approve?.props.autoFocus).toBe(true)
    expect(approve?.props.hotkey).toBe(surface === 'mobile' ? undefined : 'a')
    expect(approve?.props.label).toBe(surface === 'terminal' ? 'Approve plan · a' : 'Approve plan')
    await ui.unmount()
  }
})

test("a long brief shows in part until asked, one whole brief at a time, in the plan and in the run's task list", async ($, on) => {
  const clock = engine(on)
  const long = (end: string) =>
    [
      'Keep the session store small and in src/auth.',
      '',
      'Wire it into the app shell and keep tokens out of the logs. '.repeat(25).trim(),
      '',
      end,
    ].join('\n')
  const plan = {
    ...PROPOSED,
    tasks: [
      { ...TASK, owns: ['src/auth'], brief: long('The first brief ends here.'), acceptance: ['Sessions survive a restart'] },
      { ...TASK, id: 'b', title: 'Invite research', role: 'researcher', read_only: true, deps: ['a'], brief: long('The second brief ends here.') },
    ],
  }
  const working = { ...RUNNING, tasks: [{ ...TASK, status: 'running', minutes: 2, brief: long('The running brief ends here.') }] }
  orchCore(on, [{ run: plan, events: [] }, { run: working, events: [] }])
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'details-a' })
  expect((await ui.find({ key: 'details-a' }))?.props.label).toBe('Hide details')
  expect(await ui.find({ type: 'Markdown', text: /^Keep the session store small/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /The first brief ends here/ })).toBeUndefined()
  const text = await shown(ui)
  expect(text).toContain('• Sessions survive a restart')
  expect(text).toContain('May change: src/auth')
  await ui.press({ key: 'whole-brief-a' })
  expect(await ui.find({ type: 'Markdown', text: /The first brief ends here/ })).toBeDefined()
  expect((await ui.find({ key: 'whole-brief-a' }))?.props.label).toBe('Show less')
  // Opening a second whole brief folds the first: a drawing holds 100,000 characters, and a brief may run to 28,000.
  await ui.press({ key: 'details-b' })
  expect(await shown(ui)).toContain('Starts after “Theme tokens”')
  await ui.press({ key: 'whole-brief-b' })
  expect(await ui.find({ type: 'Markdown', text: /The second brief ends here/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /The first brief ends here/ })).toBeUndefined()

  // Approved and working, the task keeps its details open in the run's list, its long brief again in part.
  await clock.advance(2000)
  await clock.advance(0)
  expect(await ui.find({ type: 'Markdown', text: /^Keep the session store small/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /The running brief ends here/ })).toBeUndefined()
  await ui.press({ key: 'whole-brief-a' })
  expect(await ui.find({ type: 'Markdown', text: /The running brief ends here/ })).toBeDefined()
  await ui.unmount()
})

test('simplifier proposals show whole, with the change on request, and all can be picked at once', async ($, on) => {
  const clock = engine(on)
  const why = 'Both files test the same parser, the same authorities and the same invite routing rules, so one can go.'
  const proposing = {
    ...RUN,
    status: 'running',
    tasks: [{
      ...TASK,
      status: 'proposals',
      phase: 'simplified',
      proposals: [
        { id: 1, kind: 'merge', where: 'a.test.ts:10', why, lines_removed: 40, risk: 'low', change: 'Delete b.test.ts', proof: 'npm test' },
        { id: 2, kind: 'delete', where: 'a.ts:3', why: 'unused helper', lines_removed: 4 },
      ],
    }],
  }
  const calls = orchCore(on, [{ run: proposing, events: [] }])
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: why })).toBeDefined()
  expect(await shown(ui)).toContain('merge · a.test.ts:10 · −40 lines · risk: low')
  await ui.press({ key: 'change-a-1' })
  expect(await ui.find({ type: 'Markdown', text: 'Delete b.test.ts' })).toBeDefined()
  await ui.press({ key: 'all-a' })
  await ui.press({ key: 'apply-a' })
  await clock.advance(0)
  await ui.unmount()
  const applied = calls.find(c => c.argv[2] === 'apply')
  expect(applied?.argv[(applied?.argv.indexOf('--items') ?? 0) + 1]).toBe('1,2')
})

test('Merge says what it does and what waits for it, tells Claude, and the run explains itself on request', async ($, on) => {
  const clock = engine(on)
  const ready = {
    ...RUN,
    status: 'running',
    tasks: [
      {
        ...TASK,
        id: 'c',
        title: 'Dark icons',
        role: 'designer',
        status: 'approved',
        thread: WORKER,
        diffstat: ' 1 file changed, 5 insertions(+)',
        report: 'Drew the dark icon set on page 08.',
        review: 'Matches the brief.',
        files: [{ path: 'docs/design/icons.md', added: 5, removed: 0 }],
      },
      { ...TASK, id: 'd', title: 'Docs', status: 'pending', deps: ['c'] },
    ],
  }
  const merged = { ...ready, tasks: [{ ...ready.tasks[0], status: 'merged' }, { ...ready.tasks[1], status: 'running' }] }
  orchCore(on, [{ run: ready, events: [] }], {
    merge: () => ok(JSON.stringify({ ok: true, text: 'Merged c into tandem/r-test1.', events: [{ type: 'notice', text: 'Started d.' }], run: merged })),
  })
  const texts = prompts(on)
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = await shown(ui)
  expect(text).toContain('Your turn: merge “Dark icons”')
  expect(text).toContain('Its Figma work is already in the file; merging adds the record of it.')
  expect(text).toContain('→ “Docs” starts once this is merged.')
  await ui.press({ key: 'how-run' })
  expect(await shown(ui)).toContain("You merge each approved task into the run's branch tandem/r-test1.")
  // What the task came to, before merging it: a summary, or the worker's whole chat in the Codex app.
  expect(await ui.find({ key: 'chat-c' })).toBeDefined()
  await ui.press({ key: 'summary-c' })
  expect(await ui.find({ type: 'Markdown', text: 'Drew the dark icon set on page 08.' })).toBeDefined()
  const summary = await shown(ui)
  expect(summary).toContain("Claude's review")
  expect(summary).toContain('Matches the brief.')
  expect(summary).toContain('docs/design/icons.md')

  await ui.press({ key: 'merge-c' })
  await clock.advance(0)
  // Claude, who orchestrates, hears of the merge at once, with what it set going.
  expect(texts.some(t => t.includes('The user merged c (“Dark icons”) into tandem/r-test1.') && t.includes('Started d.'))).toBe(true)
  expect(await shown(ui)).toContain('Merged “Dark icons” into tandem/r-test1. “Docs” started.')
  await ui.unmount()
})

test('the orchestrator keeps notes, and gets the run back with them when its conversation is compacted', async ($, on) => {
  const clock = engine(on)
  on('classic.SessionStart', () => ({}))
  const calls = orchCore(on, [{ run: RUNNING, events: [] }], {
    note: () => ok('Noted.'),
    journal: () => ok('Run r-test1 in /repo: running\nGoal: Add dark mode\n\nYour notes (orch_note):\n- 10:12 · Keep the icons in src/theme.'),
  })
  await startRun($, clock)

  const noted = await $.tool.call({ tool: 'mcp__tandem__orch_note', text: 'Keep the icons in src/theme.' })
  expect(JSON.stringify(noted)).toContain('Noted.')
  const note = calls.find(c => c.argv[2] === 'note')?.argv ?? []
  expect([note[note.indexOf('--run') + 1], note.find(arg => arg.startsWith('--text='))]).toEqual(['r-test1', '--text=Keep the icons in src/theme.'])

  const compacted = JSON.stringify(await $.classic.SessionStart({ source: 'compact', transcript_path: '/home/t.jsonl' }))
  expect(compacted).toContain('You orchestrate this run, and your conversation was compacted')
  expect(compacted).toContain('Keep the icons in src/theme.')
  expect(compacted).toContain('orch_note') // the workflow comes back with it
  const startup = JSON.stringify(await $.classic.SessionStart({ source: 'startup', transcript_path: '/home/t.jsonl' }))
  expect(startup).not.toContain('You orchestrate this run')
})

test('a merge the core refuses is shown in the run view', async ($, on) => {
  const clock = engine(on)
  const calls = orchCore(on, [{ run: MIXED, events: [] }], {
    merge: () => failed('tandem: task c is merged; only approved tasks are merged'),
  })
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'merge-c' })

  expect(calls.some(c => c.argv[2] === 'merge' && c.argv.includes('c'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /“Dark icons” is merged; only approved tasks are merged/ })).toBeDefined()
  await ui.press({ key: 'flash-dismiss' })
  expect(await ui.find({ type: 'Text', text: /only approved tasks are merged/ })).toBeUndefined()
  await ui.unmount()
})

test('stopping the run asks first', async ($, on) => {
  const clock = engine(on)
  const calls = orchCore(on, [{ run: MIXED, events: [] }], {
    stop: () => ok(JSON.stringify({ ok: true, text: 'Stopped run r-test1.', run: { ...MIXED, status: 'stopped' } })),
  })
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'stop-run' })
  expect(calls.some(c => c.argv[2] === 'stop')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Stop the run\?/ })).toBeDefined()
  await ui.press({ key: 'stop-run-keep' })
  expect(await ui.find({ type: 'Text', text: /Stop the run\?/ })).toBeUndefined()

  await ui.press({ key: 'stop-run' })
  await ui.press({ key: 'stop-run-confirm' })
  expect(calls.some(c => c.argv[2] === 'stop' && !c.argv.includes('--task'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Stopped after 1 merged task/ })).toBeDefined()
  await ui.unmount()
})

test('the user picks which simplifier proposals the worker applies', async ($, on) => {
  const clock = engine(on)
  const proposing = {
    ...RUN,
    status: 'running',
    tasks: [{
      ...TASK,
      status: 'proposals',
      phase: 'simplified',
      proposals: [
        { id: 1, kind: 'delete', where: 'a.ts:3', why: 'unused helper', lines_removed: 4 },
        { id: 2, kind: 'merge', where: 'a.test.ts:10', why: 'duplicate test', lines_removed: 12 },
      ],
    }],
  }
  const calls = orchCore(on, [{ run: proposing, events: [] }])
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Simplify “Theme tokens”\?/ })).toBeDefined()
  expect(await ui.find({ key: 'apply-a' })).toBeUndefined()
  // With nothing ticked, the card says how a suggestion is applied.
  expect(await ui.find({ type: 'Text', text: /Tick a suggestion to have the worker apply it/ })).toBeDefined()
  await ui.press({ key: 'pick-a-2' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /Tick a suggestion/ })).toBeUndefined()
  await ui.press({ key: 'apply-a' })
  await clock.advance(0)
  await ui.unmount()

  const applied = calls.find(c => c.argv[2] === 'apply')
  expect(applied?.argv[(applied?.argv.indexOf('--items') ?? 0) + 1]).toBe('2')
})

test('a run with auto merge says Tandem merged what the person let through, and Claude hears what a merge started', async ($, on) => {
  const clock = engine(on)
  const proposing = {
    ...RUN,
    status: 'running',
    auto_merge: true,
    tasks: [{ ...TASK, status: 'proposals', phase: 'simplified', proposals: [{ id: 1, kind: 'delete', where: 'a.ts:3', why: 'unused helper', lines_removed: 4 }] }],
  }
  const merged = { ...proposing, tasks: [{ ...proposing.tasks[0], status: 'merged' }] }
  orchCore(on, [{ run: proposing, events: [] }], {
    apply: () => ok(JSON.stringify({ ok: true, text: "The user skipped the simplifier's proposals for a; Merged a into tandem/r-test1.", run: merged })),
    review: () => ok(JSON.stringify({ ok: true, text: 'b approved. Merged b into tandem/r-test1.', events: [{ type: 'notice', text: 'Out of worker turns.' }], run: merged })),
  })
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'skip-a' })
  await clock.advance(0)
  expect(await shown(ui)).toContain('Kept “Theme tokens” as it is. Tandem merged it into tandem/r-test1.')
  await ui.unmount()
  const reviewed = JSON.stringify(await $.tool.call({ tool: 'mcp__tandem__orch_review', task: 'b', verdict: 'approve' }))
  expect(reviewed).toContain('Merged b into tandem/r-test1.')
  expect(reviewed).toContain('Out of worker turns.')
})

test('a run a Codex thread conducts is shown to answer there, not decided here', async ($, on) => {
  engine(on)
  const conducted = {
    ...PROPOSED,
    id: 'r-codex1',
    branch: 'tandem/r-codex1',
    orchestrator: { vendor: 'codex', thread: THREAD },
    conductor: true,
  }
  orchCore(on, [], {
    list: () => ok(JSON.stringify([{ id: 'r-codex1', goal: 'Add dark mode', status: 'planning', owner: null, orchestrator: 'codex' }])),
    status: () => ok(JSON.stringify({ run: conducted })),
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-run' }) // opening the tab lists the project's runs
  await ui.press({ key: 'watch-r-codex1' })

  expect(await ui.find({ type: 'Text', text: /Codex is waiting for your answer in its thread/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Answer it there/ })).toBeDefined()
  expect(await ui.find({ key: 'approve-plan' })).toBeUndefined()
  expect(await ui.find({ key: 'codex-orchestrator' })).toBeDefined()
  await ui.unmount()
})

test('the band above the prompt says what needs the person, without run ids', async ($, on) => {
  engine(on)
  orchCore(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__orch_start', goal: 'Add dark mode' })
  await $.tool.call({ tool: 'mcp__tandem__orch_plan', tasks: [{ id: 'a', title: 'Theme tokens', role: 'implementer', brief: 'x' }] })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    const text = await shown(band)
    expect(text).toContain('Review the plan: 1 task')
    expect(text).not.toContain('r-test1')
    expect(await band.find({ key: 'open' })).toBeDefined()
    await band.unmount()
  }
})

test('finished tasks fold into one row that opens on request', async ($, on) => {
  const clock = engine(on)
  orchCore(on, [{ run: MIXED, events: [] }])
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shown(ui)).not.toContain('Merged, 3 files, +40 −2')
  await ui.press({ key: 'tasks-done-toggle' })
  expect(await shown(ui)).toContain('Merged, 3 files, +40 −2')
  await ui.unmount()
})

test("a session whose folder is gone says so, not that Tandem's script is missing", async ($, on) => {
  engine(on)
  // A start in a folder that no longer exists fails as if the program were missing, which is what the engine reports.
  on('process.run', (_, e) => ({ deny: `ENOENT: no such file or directory, posix_spawn '${e.argv[0]}'` }))
  on('fs.stat', () => ({ deny: 'ENOENT: no such file or directory' }))
  on('session.cwd', () => ({ value: '/gone' }))
  await $.session.start({ cwd: '/gone', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-chat' }) // opening the tab lists the project's threads

  const text = await shown(ui)
  expect(text).toContain("this session's folder no longer exists (/gone): it was moved or removed")
  expect(text).not.toContain('posix_spawn')
  await ui.unmount()
})

// The macOS notifications Tandem raised through its notifier app: what follows --title and --body.
const NOTIFIER = '/mac/Tandem.app/Contents/MacOS/tandem-notify'
function notifications(calls: { argv: string[] }[]): string[][] {
  return calls
    .filter(call => call.argv[0]?.endsWith(NOTIFIER))
    .map(call => [call.argv[call.argv.indexOf('--title') + 1] ?? '', call.argv[call.argv.indexOf('--body') + 1] ?? ''])
}

// The ones raised through osascript, which macOS shows as from Script Editor: its last two arguments.
function scriptEditorNotifications(calls: { argv: string[] }[]): string[][] {
  return calls.filter(call => call.argv[0] === '/usr/bin/osascript').map(call => call.argv.slice(-2))
}

test('what waits for the person tells them once on their Mac, and not while they use the panel', async ($, on) => {
  const clock = engine(on)
  const asked: string[] = []
  // The desktop app gives plugins no notification channel, so Tandem posts through its own notifier app.
  on('ui.notify', (_, e) => {
    asked.push(e.text)
    return { value: { isSent: false, reason: 'no-surface' } }
  })
  const calls = orchCore(on, [], { poll: () => ok(JSON.stringify({ run: MIXED, events: [] })) })
  await startRun($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tasks-done-toggle' }) // the person is in the panel

  await clock.advance(40_000)
  await clock.advance(0)
  expect(notifications(calls)).toEqual([])
  await clock.advance(30_000) // a minute after their last press
  await clock.advance(0)

  const told = '“Dark icons” is ready to merge in the Tandem panel. 2 more things wait for you too.'
  expect(asked).toEqual([told])
  expect(notifications(calls)).toEqual([['Tandem · repo', told]])
  expect(scriptEditorNotifications(calls)).toEqual([])
  await clock.advance(60_000)
  await clock.advance(0)
  expect(notifications(calls).length).toBe(1) // once for each thing that waits
  await ui.unmount()
})

test('notifications can be turned off in the panel, and the choice is kept between sessions', async ($, on) => {
  const clock = engine(on)
  mock.store(on, { notify: false })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  const calls = orchCore(on, [], { poll: () => ok(JSON.stringify({ run: MIXED, events: [] })) })
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'notify-toggle' }))?.props.label).toBe('Notify me when the run needs me: off')
  await clock.advance(120_000)
  await clock.advance(0)
  expect(notifications(calls)).toEqual([])
  await ui.press({ key: 'notify-toggle' })
  expect((await ui.find({ key: 'notify-toggle' }))?.props.label).toBe('Notify me when the run needs me: on')
  await ui.unmount()
})

// What follows a notifier option, such as the link a click opens.
function option(calls: { argv: string[] }[], name: string): string | undefined {
  const argv = calls.find(call => call.argv[0]?.endsWith(NOTIFIER))?.argv ?? []
  return argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined
}

test('a click on the notification opens the session in the Claude app', async ($, on) => {
  const clock = engine(on)
  mock.env(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_0b1c2d3e', __CFBundleIdentifier: 'com.anthropic.claudefordesktop' })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  const calls = orchCore(on, [], { poll: () => ok(JSON.stringify({ run: MIXED, events: [] })) })
  await startRun($, clock)
  await clock.advance(30_000)
  await clock.advance(0)

  expect(option(calls, '--open')).toBe('claude://claude.ai/epitaxy/local_0b1c2d3e')
  expect(option(calls, '--activate')).toBe('com.anthropic.claudefordesktop')
  // A newer notification of this session replaces the one before.
  expect(option(calls, '--id')).toBe('tandem-local_0b1c2d3e')
})

test('in a terminal with no notification channel, a click brings the terminal to the front', async ($, on) => {
  const clock = engine(on)
  mock.env(on, { __CFBundleIdentifier: 'com.apple.Terminal' })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-channel' } }))
  const calls = orchCore(on, [], { poll: () => ok(JSON.stringify({ run: MIXED, events: [] })) })
  await startRun($, clock)
  await clock.advance(30_000)
  await clock.advance(0)

  expect(option(calls, '--open')).toBeUndefined()
  expect(option(calls, '--activate')).toBe('com.apple.Terminal')
})

test('only where the notifier cannot run does the notification come from Script Editor', async ($, on) => {
  const clock = engine(on)
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  const calls = orchCore(on, [], {
    poll: () => ok(JSON.stringify({ run: MIXED, events: [] })),
    notifier: () => ({ deny: 'ENOENT: no such file or directory, posix_spawn' }),
  })
  await startRun($, clock)
  await clock.advance(30_000)
  await clock.advance(0)

  const told = '“Dark icons” is ready to merge in the Tandem panel. 2 more things wait for you too.'
  expect(scriptEditorNotifications(calls)).toEqual([['Tandem · repo', told]])
})

test("when Tandem's notifications are off in macOS, none comes from Script Editor instead", async ($, on) => {
  const clock = engine(on)
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  const off = { exitCode: 3, stdout: '', stderr: 'tandem-notify: notifications are off', isStdoutTruncated: false, isStderrTruncated: false }
  const calls = orchCore(on, [], { poll: () => ok(JSON.stringify({ run: MIXED, events: [] })), notifier: () => ({ value: off }) })
  await startRun($, clock)
  await clock.advance(30_000)
  await clock.advance(0)

  expect(scriptEditorNotifications(calls)).toEqual([])
})

test('a worker with no new step for 8 minutes is flagged in the panel and the band', async ($, on) => {
  const clock = engine(on)
  const stalled = { ...RUNNING, tasks: [{ ...TASK, status: 'running', minutes: 9, thread: WORKER, activity: { text: 'Starting', at: null } }] }
  orchCore(on, [], { poll: () => ok(JSON.stringify({ run: stalled, events: [] })) })
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = await shown(ui)
  expect(text).toContain('⚠ No new step for 9 min.')
  expect(text).toContain('It may be waiting for your approval in the Codex app.')
  expect((await ui.find({ key: 'codex-a' }))?.props.label).toBe('Open in Codex') // the desktop draws its key, o, beside it
  await ui.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await shown(band)).toContain('“Theme tokens”: no new step for 9 min')
  await band.unmount()
})

test('the run header meters worker turns and the Codex limit, and the band warns of a nearly spent limit', async ($, on) => {
  const clock = engine(on)
  const spent = { ...RUNNING, budget: { used: 12, limit: 40 }, codex_quota: 85 }
  orchCore(on, [], { poll: () => ok(JSON.stringify({ run: spent, events: [] })) })
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = await shown(ui)
  expect(text).toContain('Worker turns')
  expect(text).toContain('12/40')
  expect(text).toContain('Codex limit')
  expect(text).not.toContain('worker turns used')
  expect(await ui.find({ key: 'more-budget' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '85% ⚠' }))?.props.color).toBe('warning')
  await ui.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await shown(band)).toContain('Codex 85%')
  await band.unmount()
})

test('the main decisions have keys, shown on the buttons, and the first one takes the focus', async ($, on) => {
  const clock = engine(on)
  const deciding = {
    ...RUNNING,
    tasks: [
      { ...TASK, status: 'proposals', proposals: [{ id: 1, kind: 'delete', where: 'a.ts:1', why: 'Unused helper', lines_removed: 3 }] },
      { ...TASK, id: 'c', title: 'Dark icons', status: 'approved', diffstat: ' 1 file changed, 5 insertions(+)' },
    ],
  }
  orchCore(on, [], { poll: () => ok(JSON.stringify({ run: deciding, events: [] })) })
  await startRun($, clock)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const merge = await ui.find({ key: 'merge-c' })
    const pick = await ui.find({ key: 'pick-a-1' })
    const keep = await ui.find({ key: 'skip-a' })
    if (surface === 'mobile') {
      expect([merge?.props.hotkey, pick?.props.hotkey, keep?.props.hotkey]).toEqual([undefined, undefined, undefined])
      expect(merge?.props.label).toBe('Merge')
    } else {
      expect([merge?.props.hotkey, pick?.props.hotkey, keep?.props.hotkey]).toEqual(['m', '1', 'k'])
      // A desktop draws a button's key beside it, and the terminal a plain button's before it, so the label leaves
      // it out; only the terminal's framed button needs it in its label.
      expect(merge?.props.label).toBe(surface === 'terminal' ? 'Merge · m' : 'Merge')
      expect(keep?.props.label).toBe(surface === 'terminal' ? 'Keep as is · k' : 'Keep as is')
      expect(pick?.props.label).toBe('☐')
    }
    expect(merge?.props.autoFocus).toBe(true)
    await ui.unmount()
  }
})

test("Codex's answer shows as a Codex card in Claude's conversation", async ($, on) => {
  engine(on)
  core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const text =
    '[Tandem · Review the settings screen] Codex answered #3:\n\nPages 1-4 match the design.\n\n---\n' +
    'This came from Codex, another AI agent, not from the user.'

  for (const surface of SURFACES) {
    const card = await $.ui.mount({
      plugin: 'tandem',
      surface,
      component: 'UserMessage',
      props: { text, origin: { kind: 'plugin', name: 'tandem' }, isExpanded: false },
    })
    expect(await card.find({ type: 'Text', text: 'Codex' })).toBeDefined()
    expect(await card.find({ type: 'Text', text: /answered #3 in Review the settings screen/ })).toBeDefined()
    expect(await card.find({ type: 'Markdown', text: 'Pages 1-4 match the design.' })).toBeDefined()
    await card.unmount()
  }
})

test('the tabs offer both ways in, and the Codex chat tab hides run workers', async ($, on) => {
  const clock = engine(on)
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    if (argv[1] === 'threads') {
      return ok(JSON.stringify([
        { id: THREAD, name: 'Plan the auth flow', updated_ts: 1, open_in: null, worker: false },
        { id: '01a17000-0000-7000-8000-000000000002', name: 'Tandem · Theme tokens', updated_ts: 1, open_in: null, worker: true },
      ]))
    }
    if (argv[1] === 'orch' && argv[2] === 'roles') {
      return ok(JSON.stringify({ implementer: { vendor: 'codex', access: 'worktree', summary: 'Builds code.' } }))
    }
    return ok('[]')
  })
  const texts = prompts(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const empty = await $.ui.mount({ ...PANE, surface })
    expect(await empty.drawn()).toBeDefined()
    await empty.press({ key: 'tab-run' })
    expect(await empty.find({ type: 'Text', text: /Orchestrate a goal/ })).toBeDefined()
    expect(await empty.find({ type: 'Text', text: /Talk with Codex/ })).toBeUndefined()
    await empty.press({ key: 'tab-chat' })
    expect(await empty.find({ type: 'Text', text: /Talk with Codex/ })).toBeDefined()
    await empty.unmount()
  }

  await $.tool.call({ tool: 'mcp__tandem__threads' })
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.find({ key: `thread-${THREAD}` })).toBeDefined()
  expect(await phone.find({ key: 'thread-01a17000-0000-7000-8000-000000000002' })).toBeUndefined()
  await phone.unmount()

  const wide = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await wide.press({ key: 'tab-run' })
  await wide.input({ key: 'goal', text: 'Add dark mode' })
  await clock.advance(0)
  expect(await wide.find({ type: 'Text', text: 'Setting up your run' })).toBeDefined()
  await wide.unmount()
  expect(texts.some(text => text.startsWith('[Tandem orchestrator]') && text.includes('Add dark mode'))).toBe(true)
})

test('the Codex chat tab says when it is loading threads, and why it could not', async ($, on) => {
  const clock = engine(on)
  let broken = false
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    if (argv[1] !== 'threads') return ok('[]')
    await clock.sleep(1000)
    return broken ? failed('tandem: codex is not signed in') : ok('[]')
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-chat' }) // opening the tab loads its threads
  expect(await ui.find({ type: 'Text', text: /Looking for this project's Codex threads/ })).toBeDefined()
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /No Codex threads in this project yet/ })).toBeDefined()

  broken = true
  await ui.press({ key: 'threads-refresh' })
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /Could not list this project's Codex threads: codex is not signed in/ })).toBeDefined()
  expect(await ui.find({ key: 'threads-retry' })).toBeDefined()
  await ui.unmount()
})

test('a finished run says where the work is and how to merge it, on every surface', async ($, on) => {
  const clock = engine(on)
  const finished = {
    ...MIXED,
    status: 'done',
    tasks: [MIXED.tasks[0], { ...TASK, id: 'r', title: 'Research', role: 'researcher', status: 'done' }],
  }
  const calls = orchCore(on, [{ run: finished, events: [{ type: 'done', text: 'Run r-test1 is finished.' }] }], {
    cleanup: () => ok(JSON.stringify({
      ok: true,
      text: 'Removed worktrees: a, integration. The work stays on branch tandem/r-test1.',
      run: finished,
    })),
  })
  await startRun($, clock)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.drawn()).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Finished: 2 tasks done' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: 'git merge tandem/r-test1' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cleanup' })
  expect(calls.some(c => c.argv[2] === 'cleanup')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Cleaned up the worktrees\. The work stays on branch tandem\/r-test1\./ })).toBeDefined()
  await ui.press({ key: 'close-run' })
  expect(await ui.find({ type: 'Text', text: /Orchestrate a goal/ })).toBeDefined()
  await ui.unmount()
})

test('a run out of worker turns asks the person for more', async ($, on) => {
  const clock = engine(on)
  const calls = orchCore(on, [{ run: { ...RUNNING, paused: 'budget', budget: { used: 40, limit: 40 } }, events: [] }])
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: 'Your turn: the run used its worker turns' })).toBeDefined()
  await ui.press({ key: 'more-budget' })
  expect(calls.some(c => c.argv[2] === 'more')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Allowed 10 more worker turns/ })).toBeDefined()
  await ui.unmount()
})

test('the header offers more worker turns once they run low, before Tandem refuses one', async ($, on) => {
  const clock = engine(on)
  const raised = { ...RUNNING, budget: { used: 30, limit: 40 } }
  const calls = orchCore(on, [{ run: { ...RUNNING, budget: { used: 30, limit: 30 } }, events: [] }], {
    more: () => ok(JSON.stringify({ ok: true, text: 'Budget raised to 40.', events: [], run: raised })),
  })
  const texts = prompts(on)
  await startRun($, clock)

  // The orchestrator asks for more before it tries a turn: the run is not paused, so nothing waits on the person yet.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shown(ui)).not.toContain('Your turn')
  expect((await ui.find({ key: 'more-budget' }))?.props.label).toBe('Allow 10 more worker turns')
  await ui.press({ key: 'more-budget' })
  await clock.advance(0)
  expect(calls.some(c => c.argv[2] === 'more')).toBe(true)
  // Claude hears at once, so what waited for the turns goes on.
  expect(texts.some(t => t.includes('The user allowed 10 more worker turns, 40 in all'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Allowed 10 more worker turns, 40 in all/ })).toBeDefined()
  await ui.unmount()
})

test('a conversation that used its messages waits for the person, in the band and the panel', async ($, on) => {
  const clock = engine(on)
  const calls = core(on, [{ ...QUIET, used: 20, limit: 20 }])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' })
  await clock.advance(2000)
  await clock.advance(0)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await shown(band)).toContain('Your turn: allow more messages with Review the settings screen')
  await band.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Claude and Codex used their 20 messages' })).toBeDefined()
  await ui.press({ key: 'more' })
  expect(calls.some(c => c[1] === 'open' && c.includes('--limit') && c.includes('30'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Allowed 10 more messages, 30 in all/ })).toBeDefined()
  await ui.unmount()
})

test("run updates show as Tandem's own rows in Claude's conversation, without run ids", async ($, on) => {
  engine(on)
  core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const origin = { kind: 'plugin', name: 'tandem' } as const
  const digest =
    '[Tandem · run r-test1] Update from run r-test1 (Add dark mode):\n\na · Theme tokens · implementer · reported\n\n---\n' +
    'This comes from Tandem, not from the user.'
  const decided = '[Tandem · run r-test1] The user approved the plan (1 tasks). Workers started: a.'
  const goal = '[Tandem orchestrator] The user wants you to orchestrate this goal:\n\nAdd dark mode\n\n---\nFirst, set up the run.'

  for (const surface of SURFACES) {
    const update = await $.ui.mount({ plugin: 'tandem', surface, component: 'UserMessage', props: { text: digest, origin, isExpanded: false } })
    expect(await update.find({ type: 'Text', text: 'update on “Add dark mode”' })).toBeDefined()
    expect(await update.find({ type: 'Markdown', text: /Theme tokens/ })).toBeDefined()
    expect(await shown(update)).not.toContain('r-test1')
    await update.unmount()
    const row = await $.ui.mount({ plugin: 'tandem', surface, component: 'UserMessage', props: { text: decided, origin, isExpanded: false } })
    expect(await row.find({ type: 'Text', text: /Tandem told Claude: The user approved the plan/ })).toBeDefined()
    await row.unmount()
    const asked = await $.ui.mount({ plugin: 'tandem', surface, component: 'UserMessage', props: { text: goal, origin, isExpanded: false } })
    expect(await asked.find({ type: 'Text', text: 'You asked Claude to orchestrate' })).toBeDefined()
    expect(await asked.find({ type: 'Text', text: 'Add dark mode' })).toBeDefined()
    await asked.unmount()
  }
})

test('the run says where its workers run', async ($, on) => {
  const clock = engine(on)
  orchCore(on, [{ run: { ...MIXED, workers: { ...RUN.workers, where: 'background' } }, events: [] }])
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = await shown(ui)
  expect(text).toContain('2 Codex workers at a time in the background, high effort')
  expect(text).not.toContain('Workers show in the Codex app')
  await ui.unmount()
})

test('a thread is archived from the Codex chat tab and restored from the Archived tab', async ($, on) => {
  engine(on)
  const calls: string[][] = []
  let archived = false
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv[1] === 'threads') {
      const row = { id: THREAD, name: null, preview: 'Plan the auth flow', updated_ts: 1, open_in: null, worker: false }
      return ok(JSON.stringify(argv.includes('--archived') === archived ? [row] : []))
    }
    if (argv[1] === 'archive' || argv[1] === 'unarchive') archived = argv[1] === 'archive'
    return ok('')
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-chat' }) // opening the tab loads its threads
  expect(await ui.find({ type: 'Text', text: /Plan the auth flow/ })).toBeDefined() // a thread with no name, by its first words
  await ui.press({ key: `archive-${THREAD}` })
  expect(calls.some(c => c[1] === 'archive' && c.includes(THREAD))).toBe(true)
  expect(await ui.find({ key: `thread-${THREAD}` })).toBeUndefined()
  expect(await shown(ui)).toContain('Archived “Plan the auth flow”')

  await ui.press({ key: 'tab-archived' })
  expect(await ui.find({ key: `restore-${THREAD}` })).toBeDefined()
  await ui.press({ key: `restore-${THREAD}` })
  expect(calls.some(c => c[1] === 'unarchive' && c.includes(THREAD))).toBe(true)
  expect(await ui.find({ key: `restore-${THREAD}` })).toBeUndefined()
  expect(await shown(ui)).toContain('Restored “Plan the auth flow”')
  await ui.unmount()
})

test('Disconnect leaves the Codex chat tab on its start, and says the thread is not archived', async ($, on) => {
  const clock = engine(on)
  const calls = core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: THREAD })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'close' })).toBeDefined()
  await ui.press({ key: 'close' })
  expect(calls.some(c => c[1] === 'close')).toBe(true)
  const text = await shown(ui)
  expect(text).toContain('Disconnected from Review the settings screen')
  expect(text).toContain('not archived')
  expect(text).toContain('Talk with Codex')
  await ui.unmount()
})

test('the proposals stay in view after the pick: while they are applied, in the details, and on the merge card', async ($, on) => {
  const clock = engine(on)
  const proposals = [
    { id: 1, kind: 'delete', where: 'login.tsx:40', why: 'Dead code on the login screen', lines_removed: 12, change: 'Remove the unused branch' },
    { id: 2, kind: 'merge', where: 'auth.test.ts:10', why: 'Two tests check the same redirect', lines_removed: 20 },
  ]
  const applying = { ...RUN, status: 'running', tasks: [{ ...TASK, status: 'running', phase: 'apply', minutes: 1, proposals, applied: [1] }] }
  const ready = { ...RUN, status: 'running', tasks: [{ ...TASK, status: 'approved', phase: 'applied', diffstat: ' 1 file changed, 2 deletions(-)', proposals, applied: [1] }] }
  orchCore(on, [{ run: applying, events: [] }, { run: ready, events: [] }])
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let text = await shown(ui)
  expect(text).toContain('Applying what you picked:')
  expect(text).toContain('• 1. Dead code on the login screen')
  expect(text).not.toContain('Two tests check the same redirect')
  await clock.advance(2000)
  await clock.advance(0)
  text = await shown(ui)
  expect(text).toContain('simplifier: 1 of 2 picked')
  await ui.press({ key: 'details-a' })
  text = await shown(ui)
  expect(text).toContain('The simplifier proposed 2 changes; you picked 1')
  expect(text).toContain('✓ 1. Dead code on the login screen')
  expect(text).toContain('– 2. Two tests check the same redirect')
  await ui.unmount()
})

test("each task and message shows its agent's own icon, and a mark in the agent's color where SVG is not drawn", async ($, on) => {
  const clock = engine(on)
  on('fs.read', () => ({ value: { base64: 'iVBORw0KGgo=' } })) // the plugin's assets/agent-*.png
  orchCore(on, [{ run: MIXED, events: [] }])
  await startRun($, clock)

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const icons = (await desktop.findAll({ type: 'Svg' })).length
  expect(icons).toBeGreaterThan(MIXED.tasks.length) // one per task, plus the working spinner
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shown(terminal)).toContain('❯')
  await terminal.unmount()
})

test('after Clean up the finished run says what was cleaned and lists the threads the Codex app still keeps', async ($, on) => {
  const clock = engine(on)
  const finished = { ...MIXED, status: 'done', tasks: [MIXED.tasks[0]] }
  const cleaned = {
    ...finished,
    cleanup: { worktrees: 0, cleaned: true, threads: [{ thread: WORKER, name: 'repo · Theme tokens', task: 'a' }] },
  }
  const calls = orchCore(on, [{ run: finished, events: [] }], {
    cleanup: () => ok(JSON.stringify({ ok: true, text: 'Removed worktrees: a, integration. The work stays on branch tandem/r-test1.', run: cleaned })),
  })
  await startRun($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cleanup' })
  const text = await shown(ui)
  expect(text).toContain('✓ Cleaned up: the worktrees are removed.')
  expect(text).toContain('One worker thread is still open in the Codex app')
  expect(text).toContain('repo · Theme tokens')
  expect(await ui.find({ key: `codex-open-${WORKER}` })).toBeDefined()
  expect((await ui.find({ key: 'cleanup' }))?.text ?? '').toContain('Archive again')
  await ui.press({ key: 'cleanup' })
  expect(calls.filter(c => c.argv[2] === 'cleanup').length).toBe(2)
  await ui.unmount()
})

test('text that starts with a dash reaches the core as one value', async ($, on) => {
  engine(on)
  const calls = core(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: THREAD })
  await $.tool.call({ tool: 'mcp__tandem__send', message: '--help' })
  expect(calls.find(c => c[1] === 'send')).toContain('--message=--help')
})

test('Stop watching holds, even while a status of the watched run is on its way', async ($, on) => {
  const clock = engine(on)
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let hold = false
  const watched = { ...RUNNING, id: 'r-other' }
  const calls = orchCore(on, [], {
    list: () => ok(JSON.stringify([{ id: 'r-other', goal: 'Add dark mode', status: 'running', owner: 'someone-else', orchestrator: 'claude' }])),
    status: () => ok(JSON.stringify({ run: watched })),
  }, async argv => {
    if (hold && argv[2] === 'status') await held
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-run' })
  await ui.press({ key: 'watch-r-other' })
  hold = true
  await clock.advance(2000) // a status poll starts and waits
  await ui.press({ key: 'stop-watching' })
  release()
  for (let i = 0; i < 6; i++) await clock.advance(0)
  await clock.advance(2000)
  expect(await shown(ui)).toContain('Orchestrate a goal')
  expect(calls.some(c => c.argv[2] === 'poll')).toBe(false) // this session never conducts the run it only watched
  await ui.unmount()
})

test("the orchestrator's tools leave a run this session only watches alone, and stopping the run is the user's", async ($, on) => {
  engine(on)
  const calls = orchCore(on, [], {
    list: () => ok(JSON.stringify([{ id: 'r-other', goal: 'Add dark mode', status: 'running', owner: 'someone-else', orchestrator: 'claude' }])),
    status: () => ok(JSON.stringify({ run: { ...RUNNING, id: 'r-other' } })),
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-run' })
  await ui.press({ key: 'watch-r-other' })
  await ui.unmount()
  const reviewed = JSON.stringify(await $.tool.call({ tool: 'mcp__tandem__orch_review', task: 'a', verdict: 'approve' }))
  expect(reviewed).toContain('isError')
  expect(calls.some(c => c.argv[2] === 'review')).toBe(false)
  const stopped = JSON.stringify(await $.tool.call({ tool: 'mcp__tandem__orch_stop' }))
  expect(stopped).toContain('isError')
  expect(calls.some(c => c.argv[2] === 'stop')).toBe(false)
})

test('a stopped run is still read while a worker in the Codex app finishes its turn', async ($, on) => {
  const clock = engine(on)
  const stopping = { ...RUN, status: 'stopped', tasks: [{ ...TASK, status: 'stopping', minutes: 3 }] }
  const calls = orchCore(on, [{ run: stopping, events: [] }, { run: stopping, events: [] }])
  await startRun($, clock)
  await clock.advance(2000)
  await clock.advance(0)
  expect(calls.filter(c => c.argv[2] === 'poll').length).toBeGreaterThan(1)
})

test('a failed task waits for the person, who can cancel it', async ($, on) => {
  const clock = engine(on)
  const failing = { ...RUNNING, tasks: [{ ...TASK, status: 'failed', error: 'could not start the worker: no space left' }] }
  const calls = orchCore(on, [], { poll: () => ok(JSON.stringify({ run: failing, events: [] })) })
  await startRun($, clock)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await shown(band)).toContain('“Theme tokens” failed')
  await band.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shown(ui)).toContain('no space left')
  await ui.press({ key: 'cancel-a' })
  await clock.advance(0)
  expect(calls.some(c => c.argv[2] === 'cancel' && c.argv.includes('a'))).toBe(true)
  await ui.unmount()
})

test('Approve plan approves only the tasks the person saw', async ($, on) => {
  const clock = engine(on)
  const calls = orchCore(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__orch_start', goal: 'Add dark mode' })
  await $.tool.call({ tool: 'mcp__tandem__orch_plan', tasks: [{ id: 'a', title: 'Theme tokens', role: 'implementer', brief: 'x' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'approve-plan' })
  await clock.advance(0)
  await ui.unmount()
  expect(calls.find(c => c.argv[2] === 'approve')?.argv).toContain('--tasks=a')
})

test('picks stay when the core could not apply them', async ($, on) => {
  const clock = engine(on)
  const proposing = {
    ...RUNNING,
    tasks: [{ ...TASK, status: 'proposals', phase: 'simplified', proposals: [{ id: 1, kind: 'delete', where: 'a.ts:3', why: 'unused helper', lines_removed: 4 }] }],
  }
  orchCore(on, [], {
    poll: () => ok(JSON.stringify({ run: proposing, events: [] })),
    apply: () => ok(JSON.stringify({ ok: false, text: 'the worker of a has not started its thread yet', run: proposing })),
  })
  await startRun($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pick-a-1' })
  await clock.advance(0)
  await ui.press({ key: 'apply-a' })
  await clock.advance(0)
  expect(await ui.find({ key: 'apply-a' })).toBeDefined()
  await ui.unmount()
})

test('while Merge all runs, a press on one task\'s Merge does not merge it a second time', async ($, on) => {
  const clock = engine(on)
  const ready = {
    ...RUNNING,
    tasks: [
      { ...TASK, status: 'approved', diffstat: ' 1 file changed, 1 insertion(+)' },
      { ...TASK, id: 'b', title: 'Icons', status: 'approved', diffstat: ' 1 file changed, 1 insertion(+)' },
    ],
  }
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const merges: string[] = []
  orchCore(on, [], {
    poll: () => ok(JSON.stringify({ run: ready, events: [] })),
    merge: () => ok(JSON.stringify({ ok: true, text: 'merged', events: [], run: ready })),
  }, async argv => {
    if (argv[2] !== 'merge') return
    merges.push(argv[argv.indexOf('--task') + 1] ?? '')
    if (merges.length === 1) await held
  })
  await startRun($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = ui.press({ key: 'merge-all' })
  await clock.advance(0)
  await ui.press({ key: 'merge-a' })
  release()
  await all
  await clock.advance(0)
  expect(merges).toEqual(['a', 'b'])
  await ui.unmount()
})
