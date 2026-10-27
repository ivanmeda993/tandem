// Disconnect holds: what a real session showed, and the races behind it.
// The fake core keeps rooms like the real one: `open --join` takes an open room already bound to the thread, otherwise the
// requested name; `open` always clears `closed`; `close` sets it.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROW1 = '01a173c4-e425-7720-90d8-7a2d15cff563' // no name: a test thread whose first words are "Reply with exactly ..."
const ROW2 = '01a173c4-e43b-7581-84e4-bde112b7351b'
const ROW3 = '01a17239-9c12-7862-9a35-4ae4c6377805' // Review the settings screen
const NAMES: Record<string, string | null> = { [ROW1]: null, [ROW2]: null, [ROW3]: 'Review the settings screen' }
const PREVIEW1 = 'Reply with exactly the words BG-OK and nothing else.'

function ok(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

function failed(stderr: string) {
  return { value: { exitCode: 2, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

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

// The person types /tandem <args>.
async function typed($: Engine, args: string): Promise<string> {
  return (await $.command.run({ command: 'tandem', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text ?? ''
}

async function notConnected($: Engine): Promise<boolean> {
  return JSON.stringify(await $.tool.call({ tool: 'mcp__tandem__send', message: 'Are you there?' })).includes('No Codex thread is connected')
}

type Room = { thread: string; closed: boolean }
type Hold = { verb: string; gate: Promise<void>; armed: boolean; started: number }

// `hold`: the verb it names waits on `gate` before it answers (a core call that is still on its way); `refuseClose`: close fails.
// `throwClose`: the core cannot even start for close (the session's folder is gone); `reorder`: the thread list comes
// back newest-first in another order after its first load.
function fakeCore(on: On, options: { hold?: Hold; refuseClose?: boolean; throwClose?: boolean; reorder?: boolean } = {}) {
  const rooms: Record<string, Room> = {}
  const calls: string[][] = []
  const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const verb = argv[1] ?? ''
    const hold = options.hold
    if (hold && hold.armed && verb === hold.verb) {
      hold.started += 1
      await hold.gate
    }
    if (verb === 'orch') return ok('[]')
    if (verb === 'threads') {
      const listed = calls.filter(call => call[1] === 'threads').length
      const row = (id: string, name: string | null, preview: string | null, ts: number) =>
        ({ id, name, preview, branch: 'main', updated: '', updated_ts: ts, open_in: null, worker: false })
      const rows = [
        row(ROW1, null, PREVIEW1, 1000), row(ROW2, null, 'Working on the mobile app', 990),
        row(ROW3, 'Review the settings screen', null, 980),
      ]
      return ok(JSON.stringify(options.reorder && listed > 1 ? rows.reverse() : rows))
    }
    if (verb === 'open') {
      const thread = arg(argv, '--codex-thread')
      let name = arg(argv, '--room')
      if (argv.includes('--join') && thread) {
        const joinable = Object.entries(rooms).find(([, room]) => room.thread === thread && !room.closed)
        if (joinable) name = joinable[0]
      }
      rooms[name] = { thread: thread ?? rooms[name]?.thread, closed: false }
      return ok(JSON.stringify({ room: name, root: '/repo', thread: thread ?? null, thread_name: NAMES[thread] ?? null, limit: 20, used: 0 }))
    }
    if (verb === 'close') {
      if (options.throwClose) return { deny: 'ENOENT: no such file or directory' }
      if (options.refuseClose) return failed('tandem: could not write room.json')
      const name = arg(argv, '--room')
      if (rooms[name]) rooms[name].closed = true
      return ok(`room "${name}" closed`)
    }
    if (verb === 'new-codex') {
      const name = arg(argv, '--room')
      rooms[name] = { thread: ROW2, closed: false }
      return ok(JSON.stringify({ room: name, root: '/repo', thread: ROW2, thread_name: null, limit: 20, used: 1, sent: 1 }))
    }
    if (verb === 'poll') {
      const name = arg(argv, '--room')
      const events = rooms[name]?.closed ? [{ type: 'answer', numbers: [1], text: `An answer from ${name}` }] : []
      return ok(JSON.stringify({ closed: !!rooms[name]?.closed, turn_running: false, pending: [], limit: 20, used: 0, events }))
    }
    return ok('')
  })
  return { rooms, calls }
}

async function settle(clock: MockClock, times = 4) {
  for (let i = 0; i < times; i++) await clock.advance(0)
}

function gate() {
  let release: () => void = () => undefined
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release: () => release() }
}

test('row 1, row 3, Disconnect, row 1 again: one conversation at a time, and the nameless thread by its words', async ($, on) => {
  const clock = engine(on)
  const core = fakeCore(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW1 })
  await settle(clock)
  expect(core.rooms['thread-15cff563']).toEqual({ thread: ROW1, closed: false })

  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW3 })
  await settle(clock)
  expect(core.rooms['review-the-settings-screen-c6377805']).toEqual({ thread: ROW3, closed: false })
  expect(core.rooms['thread-15cff563'].closed).toBe(true) // the room left behind is not left open on disk

  expect(await typed($, 'close')).toContain('Disconnected from Review the settings screen')
  await settle(clock)
  expect(core.rooms['review-the-settings-screen-c6377805'].closed).toBe(true)
  expect(await notConnected($)).toBe(true)

  // A thread Codex has not named is called by its first words, not "a Codex thread".
  const again = JSON.stringify(await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' }))
  expect(again).toContain('Reply with exactly the words BG-OK')
})

test('a poll still in flight when Disconnect runs does not bring the room back', async ($, on) => {
  const clock = engine(on)
  const release = gate()
  const hold: Hold = { verb: 'poll', gate: release.promise, armed: false, started: 0 }
  fakeCore(on, { hold })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW3 })
  await settle(clock)
  hold.armed = true
  await clock.advance(2000)
  await settle(clock)
  expect(hold.started).toBeGreaterThan(0)
  await typed($, 'close')
  await settle(clock)
  release.release()
  await settle(clock, 8)
  expect(await notConnected($)).toBe(true)
})

test('a start_codex still running when Disconnect ran does not connect, and Claude is told', async ($, on) => {
  const clock = engine(on)
  const release = gate()
  const core = fakeCore(on, { hold: { verb: 'new-codex', gate: release.promise, armed: true, started: 0 } })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW3 })
  await settle(clock)
  const starting = $.tool.call({ tool: 'mcp__tandem__start_codex', message: 'Review the plan' })
  await settle(clock)
  await typed($, 'close')
  await settle(clock)
  release.release()
  const result = JSON.stringify(await starting)
  await settle(clock)

  expect(result).toContain('The user disconnected')
  expect(result).toContain('Do not connect again on your own')
  expect(await notConnected($)).toBe(true)
  const call = core.calls.find(c => c[1] === 'new-codex') ?? []
  expect(core.rooms[call[call.indexOf('--room') + 1] ?? '']?.closed).toBe(true) // the room it opened is closed again
})

test('a connect still opening when Disconnect ran does not connect either', async ($, on) => {
  const clock = engine(on)
  const release = gate()
  const hold: Hold = { verb: 'open', gate: release.promise, armed: false, started: 0 }
  fakeCore(on, { hold })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW3 })
  await settle(clock)
  hold.armed = true // the next open waits
  const connecting = $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW1 })
  await settle(clock)
  expect(hold.started).toBe(1)
  await typed($, 'close')
  await settle(clock)
  release.release()
  const result = JSON.stringify(await connecting)
  await settle(clock)
  expect(result).toContain('The user disconnected')
  expect(await notConnected($)).toBe(true)
})

test('Disconnect lets go of the conversation even when the core cannot close its room, and says so', async ($, on) => {
  const clock = engine(on)
  fakeCore(on, { refuseClose: true })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW3 })
  await settle(clock)
  expect(await typed($, 'close')).toContain('could not mark its room closed')
  expect(await notConnected($)).toBe(true)
})

test('after the user disconnected, send tells Claude not to connect again on its own', async ($, on) => {
  const clock = engine(on)
  fakeCore(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW3 })
  await settle(clock)
  await typed($, 'close')
  const sent = JSON.stringify(await $.tool.call({ tool: 'mcp__tandem__send', message: 'Are you there?' }))
  expect(sent).toContain('Do not connect again on your own')
  expect(sent).not.toContain('Connect one first')
})

test('a poll of the room left behind never lands in the room opened next', async ($, on) => {
  const clock = engine(on)
  const release = gate()
  const hold: Hold = { verb: 'poll', gate: release.promise, armed: false, started: 0 }
  const delivered: string[] = []
  on('prompt.submit', (_, e) => {
    delivered.push(e.text)
    return { value: undefined }
  })
  fakeCore(on, { hold })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW3 })
  await settle(clock)
  hold.armed = true
  await clock.advance(2000)
  await settle(clock)
  expect(hold.started).toBe(1)
  hold.armed = false
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW1 }) // closes ROW3's room, whose poll then says closed
  await settle(clock)
  release.release()
  await settle(clock, 8)
  expect(delivered.some(text => text.includes('An answer from'))).toBe(false)
  expect(await notConnected($)).toBe(false) // ROW1's conversation is still open
})

test('two nameless threads started close together get rooms of their own', async ($, on) => {
  const clock = engine(on)
  const core = fakeCore(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW1 })
  await settle(clock)
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW2 }) // its id starts like ROW1's
  await settle(clock)
  const rooms = core.calls.filter(call => call[1] === 'open').map(call => call[call.indexOf('--room') + 1])
  expect(new Set(rooms).size).toBe(2)
})

test('a number names the thread in the list Claude was shown', async ($, on) => {
  engine(on)
  const core = fakeCore(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const listed = JSON.stringify(await $.tool.call({ tool: 'mcp__tandem__threads' }))
  expect(listed).toContain('1. “Reply with exactly')
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: '1' })
  const open = core.calls.filter(call => call[1] === 'open').pop() ?? []
  expect(open[open.indexOf('--codex-thread') + 1]).toBe(ROW1)
})

test('Disconnect lets go even when the core cannot start at all', async ($, on) => {
  const clock = engine(on)
  fakeCore(on, { throwClose: true })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__tandem__connect', thread: ROW3 })
  await settle(clock)
  await typed($, 'close')
  expect(await notConnected($)).toBe(true)
})
