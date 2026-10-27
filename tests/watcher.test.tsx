// Tandem's watcher: a background agent that keeps the session marked as working in the Claude app while Codex works.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentSpawnResult, On } from 'claude-code'

const HOLD = 'mcp__tandem__hold'
const WATCHER = 'tandem:watcher'
const TRANSCRIPT = '/home/.claude/projects/repo/session.jsonl'
const ENQUEUED = '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-25T21:55:29.137Z","sessionId":"s1"}\n'
const RUN = {
  id: 'r-test1',
  root: '/repo',
  goal: 'Add dark mode',
  status: 'running',
  paused: null,
  needs_approval: false,
  branch: 'tandem/r-test1',
  task_branch: 'tandem/r-test1-<task>',
  budget: { used: 1, limit: 40 },
  workers: { model: null, effort: 'high', max_parallel: 2, access: 'full', where: 'app' },
  simplify: false,
  auto_merge: false,
  setup_command: null,
  copy: [],
  codex_quota: null,
  tasks: [
    { id: 'a', title: 'Dark mode', role: 'implementer', vendor: 'codex', status: 'running', deps: [], proposals: [] },
    { id: 'b', title: 'Settings page', role: 'implementer', vendor: 'codex', status: 'pending', deps: ['a'], proposals: [] },
  ],
}
const WORKING = { run: RUN, events: [] }
const REPORTED = {
  run: { ...RUN, tasks: [{ ...RUN.tasks[0], status: 'reported' }, { ...RUN.tasks[1], status: 'running' }] },
  events: [{ type: 'digest', text: 'Update from run r-test1 (Add dark mode): the worker reported.' }],
}
const IDLE = { run: { ...RUN, tasks: RUN.tasks.map(task => ({ ...task, status: 'reported' })) }, events: [] }

function ok(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

// Stands for the engine beneath the plugin and for the core. Each `orch poll` answers the next of `polls`, the last one
// for good; `/bin/sleep 1` takes a second of the mocked clock; the transcript grows by what a test appends; each spawn
// answers the next of `spawned`, else a started watcher `w<n>`.
function engine(on: On, polls: object[], spawned: AgentSpawnResult[] = []) {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const spawns: string[] = []
  const transcript = { text: '{"type":"user"}\n' }
  on('command.register', () => ({ value: { command: 'tandem' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__tandem__${e.name}` } }))
  on('agent.register', (_, e) => ({ value: { agent: `tandem:${e.name}` } }))
  // A plugin's spawn reaches the engine as the Agent tool's call: `subagent_type`, and no agent id comes back here.
  on('agent.spawn', (_, e) => {
    spawns.push((e as { subagent_type?: string }).subagent_type ?? e.subagentType)
    return spawned.shift() ?? { model: 'claude-haiku-5-5', agentId: `w${spawns.length}` }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: transcript.text.length, mtimeMs: 0, isLink: false } }))
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    if (argv[0] === '/bin/sleep') {
      await clock.sleep(1000)
      return ok('')
    }
    if (argv[0] === '/usr/bin/tail') return ok(transcript.text.slice(Number(argv[2]?.slice(1)) - 1))
    if (argv[1] !== 'orch') return ok('[]')
    if (argv[2] === 'init') return ok(JSON.stringify({ ok: true, text: 'Started run r-test1.', run: RUN }))
    if (argv[2] === 'poll') return ok(JSON.stringify(polls.length > 1 ? polls.shift() : polls[0]))
    if (argv[2] === 'roles') return ok('{}')
    return ok('[]')
  })
  return { clock, prompts, spawns, transcript }
}

// A run this session conducts, after one poll.
async function start($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT })
  await $.tool.call({ tool: 'mcp__tandem__orch_start', goal: 'Add dark mode' })
  await clock.advance(2000)
}

// Claude's turn in the main conversation ends.
async function turnEnds($: Engine, turnId = 't1') {
  await $.turn.complete({ answer: 'OK.', durationMs: 3000, isAborted: false, turnId, reason: 'answer' })
}

test("when Claude's turn ends while Codex works, one watcher starts, and only one", async ($, on) => {
  const { clock, spawns } = engine(on, [WORKING])
  await start($, clock)

  await turnEnds($, 't1')
  await clock.advance(4000)
  await turnEnds($, 't2')

  expect(spawns).toEqual([WATCHER])
})

test('no watcher starts while Codex is not working', async ($, on) => {
  const { clock, spawns } = engine(on, [IDLE])
  await start($, clock)
  await clock.advance(2000)

  await turnEnds($, 't1')

  expect(spawns).toEqual([])
})

test('a hold ends within a second of a prompt being queued, so the session takes it', async ($, on) => {
  const { clock, transcript } = engine(on, [WORKING])
  await start($, clock)
  await turnEnds($)

  let answer: unknown
  const held = $.tool.call({ tool: HOLD, agentId: 'w1' }).then(done => {
    answer = done
  })
  await clock.advance(3000)
  expect(answer).toBeUndefined()
  transcript.text += ENQUEUED
  await clock.advance(1000)
  await held

  expect(JSON.stringify(answer)).toContain('keep watching')
})

test('run news goes to Claude as a prompt, as before, and ends the hold', async ($, on) => {
  const { clock, prompts } = engine(on, [WORKING, REPORTED, WORKING])
  await start($, clock)
  await turnEnds($)

  const held = $.tool.call({ tool: HOLD, agentId: 'w1' })
  await clock.advance(3000)

  expect(prompts.some(text => text.includes('the worker reported'))).toBe(true)
  expect(JSON.stringify(await held)).toContain('keep watching')
})

test('when Codex stops working the hold says stop, and new work starts a new watcher', async ($, on) => {
  const { clock, spawns } = engine(on, [WORKING, IDLE, IDLE, WORKING])
  await start($, clock)
  await turnEnds($)

  const held = $.tool.call({ tool: HOLD, agentId: 'w1' })
  await clock.advance(3000)
  expect(JSON.stringify(await held)).toContain('stop')
  // Its hand-back is dropped, and the line the person sees says why it stopped.
  const dropped = await $.prompt.submit({
    text: '<agent-message from="w1">\n[Subagent hand-back] done\n</agent-message>',
    wait: false,
    origin: { kind: 'peer' },
  })
  expect(JSON.stringify(dropped)).toContain('Tandem: Codex is no longer working, so this chat shows as idle again.')
  await $.turn.complete({ answer: 'done', durationMs: 9000, isAborted: false, turnId: 'tw1', reason: 'answer', agentId: 'w1' })
  await clock.advance(4000)
  await turnEnds($, 't2')

  expect(spawns).toEqual([WATCHER, WATCHER])
})

test('a watcher stops after an hour of holds, and its line says a new one starts later', async ($, on) => {
  const { clock, transcript } = engine(on, [WORKING])
  await start($, clock)
  await turnEnds($)

  // Sixty holds, each ended at once by a queued prompt; the next one says stop while Codex still works.
  for (let n = 0; n < 60; n += 1) {
    transcript.text += ENQUEUED
    const held = $.tool.call({ tool: HOLD, agentId: 'w1' })
    await clock.advance(1000)
    expect(JSON.stringify(await held)).toContain('keep watching')
  }
  expect(JSON.stringify(await $.tool.call({ tool: HOLD, agentId: 'w1' }))).toContain('stop')
  const dropped = await $.prompt.submit({
    text: '<agent-message from="w1">\n[Subagent hand-back] done\n</agent-message>',
    wait: false,
    origin: { kind: 'peer' },
  })

  expect(JSON.stringify(dropped)).toContain("its watcher stopped after an hour; a new one starts when Claude's next turn ends")
})

test('only the watcher may hold', async ($, on) => {
  const { clock } = engine(on, [WORKING])
  await start($, clock)

  const held = await $.tool.call({ tool: HOLD })

  expect(JSON.stringify(held)).toContain("Only Tandem's watcher holds.")
})

test("a watcher's hand-back never reaches Claude; other agents' messages do", async ($, on) => {
  const { clock, prompts, transcript } = engine(on, [WORKING])
  await start($, clock)
  await turnEnds($)
  const held = $.tool.call({ tool: HOLD, agentId: 'w1' })
  transcript.text += ENQUEUED
  await clock.advance(1000)
  await held
  const before = prompts.length

  const dropped = await $.prompt.submit({
    text: '<agent-message from="w1">\n[Subagent hand-back] done\n</agent-message>',
    wait: false,
    origin: { kind: 'peer' },
  })
  await $.prompt.submit({ text: '<agent-message from="reviewer">\nApprove.\n</agent-message>', wait: false, origin: { kind: 'peer' } })

  expect(JSON.stringify(dropped)).toContain("Tandem: its watcher stopped. There's nothing in its message for Claude.")
  expect(prompts.slice(before)).toEqual(['<agent-message from="reviewer">\nApprove.\n</agent-message>'])
})

test('other agents, and a watcher no Tandem spawn asked for, are left to the permission mode', async ($, on) => {
  const { clock } = engine(on, [WORKING])
  await start($, clock)

  const explore = await $.tool.check({ tool: 'Agent', input: { subagent_type: 'Explore', prompt: 'Look.', description: 'look' } })
  const forged = await $.tool.check({ tool: 'Agent', input: { subagent_type: WATCHER, prompt: 'Watch.', description: 'watch' } })

  expect(explore.decision).toBe('ask')
  expect(forged.decision).toBe('ask')
})

test('a refused start is asked again after five minutes, not at every turn', async ($, on) => {
  const { clock, spawns } = engine(on, [WORKING], [{ deny: 'Background agents are off here.' }])
  await start($, clock)

  await turnEnds($, 't1')
  await turnEnds($, 't2')
  expect(spawns.length).toBe(1)
  await clock.advance(5 * 60_000)
  await turnEnds($, 't3')

  expect(spawns.length).toBe(2)
})
