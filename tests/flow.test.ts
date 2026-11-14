// Automated test of the whole cycle, without a real session.
// The `on(...)` hooks here play "Claude Code" underneath the mod; `$` fires
// events as if a session were running.
import { expect, mock, test } from 'claude-code/testing'

const CONTEXT = (percent: number) => ({ context: { tokens: percent * 2000, window: 200000, percent }, rateLimits: [], changed: ['context' as const] })
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never

test('threshold → handoff → /clear → handoff in the new session', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[] = []
  const prompts: { text: string; context?: readonly string[] }[] = []

  // "Claude Code" answers the commands and prompts the mod sends.
  on('command.run', (_, e) => (commands.push(e.command), { text: '' }))
  on('prompt.submit', (_, e) => (prompts.push({ text: e.text, context: e.context }), { text: e.text }) as never)
  on('tool.call', () => ({ result: {} }) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'ok' }) as never)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)

  // 1. Below the threshold nothing happens.
  await $.session.measure(CONTEXT(40))
  await clock.advance(1000)
  expect(commands).toEqual([])

  // 2. Above the threshold (65 %) the mod starts /handoff.
  await $.session.measure(CONTEXT(70))
  await clock.advance(1000)
  expect(commands).toEqual(['handoff'])

  // 3. The skill writes the handoff, the turn ends → the mod types /clear.
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'HANDOFF-CONTENT' })
  await $.turn.complete(TURN)
  await clock.advance(1000)
  expect(commands).toEqual(['handoff', 'clear'])

  // 4. /clear ends the session → the mod sends the first prompt with the handoff.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.advance(1000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]?.text).toContain('HANDOFF-CONTENT')
})

test('"next-prompt" mode: handoff is silently attached to your message', { options: { resume: 'next-prompt' } }, async ($, on) => {
  const clock = mock.clock(on)
  const prompts: { text: string; context?: readonly string[] }[] = []
  on('command.run', () => ({ text: '' }))
  on('prompt.submit', (_, e) => (prompts.push({ text: e.text, context: e.context }), { text: e.text }) as never)
  on('tool.call', () => ({ result: {} }) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'ok' }) as never)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)

  await $.session.measure(CONTEXT(80))
  await clock.advance(1000)
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'HANDOFF-CONTENT' })
  await $.turn.complete(TURN)
  await clock.advance(1000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.advance(1000)
  expect(prompts).toEqual([]) // nothing sent on its own

  await $.prompt.submit({ text: 'Keep going' }) // you type
  expect(prompts[0]?.text).toBe('Keep going')
  expect(prompts[0]?.context?.[0]).toContain('HANDOFF-CONTENT')
})

test('auto-compact is skipped, manual /compact is not', async ($, on) => {
  mock.clock(on)
  on('command.run', () => ({ text: '' }))
  const MESSAGE = [{ role: 'user', text: 'hello', toolUses: [] }] as never
  on('session.compact', () => ({ messages: MESSAGE }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)

  const auto = await $.session.compact({ trigger: 'auto', messages: MESSAGE })
  expect(auto).toEqual({ skip: expect.any(String) })

  const manual = await $.session.compact({ trigger: 'manual', messages: MESSAGE })
  expect(manual).toEqual({ messages: MESSAGE })
})

// Shared stand-in for "Claude Code" in the /goal tests. `goalStatus` is what `/goal`
// (no arguments) prints before the guard runs /clear.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function engine(on: any, goalStatus: string) {
  const commands: { command: string; args?: string }[] = []
  const prompts: { text: string; context?: readonly string[] }[] = []
  on('command.run', (_: unknown, e: { command: string; args: string }) => (commands.push({ command: e.command, args: e.args }), { text: e.command === 'goal' && e.args === '' ? goalStatus : '' }))
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[] }) => (prompts.push({ text: e.text, context: e.context }), { text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('session.measure', (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  return { commands, prompts }
}

test('an active /goal is set again after the handoff', async ($, on) => {
  const clock = mock.clock(on)
  const { commands, prompts } = engine(on, 'Goal: all tests pass\nRunning for 12m · 7 turns\nLast reason: 2 tests still failed')

  await $.command.run({ command: 'goal', args: 'all tests pass' } as never) // you type /goal …
  await $.session.measure(CONTEXT(70))
  await clock.advance(1000)
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'HANDOFF-CONTENT' })
  await $.turn.complete(TURN)
  await clock.advance(1000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.advance(1000)

  // The handoff prompt names the goal; the goal is not set before Claude has read it.
  expect(prompts[0]?.text).toContain('HANDOFF-CONTENT')
  expect(prompts[0]?.text).toContain('all tests pass')
  expect(commands.filter(c => c.command === 'goal' && c.args === 'all tests pass').length).toBe(1)

  // The handoff turn ends → `/goal all tests pass` runs again.
  await $.turn.complete(TURN)
  await clock.advance(1000)
  expect(commands.at(-1)).toEqual({ command: 'goal', args: 'all tests pass' })
})

test('a goal that was already achieved is not set again', async ($, on) => {
  const clock = mock.clock(on)
  const { commands, prompts } = engine(on, 'Goal achieved: all tests pass (12m · 7 turns)')

  await $.command.run({ command: 'goal', args: 'all tests pass' } as never)
  await $.session.measure(CONTEXT(70))
  await clock.advance(1000)
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'HANDOFF-CONTENT' })
  await $.turn.complete(TURN)
  await clock.advance(1000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.advance(1000)
  await $.turn.complete(TURN)
  await clock.advance(1000)

  expect(prompts[0]?.text).not.toContain('/goal')
  expect(commands.filter(c => c.command === 'goal' && c.args !== '').length).toBe(1) // only yours
})

test('/goal clear means nothing is restored', async ($, on) => {
  const clock = mock.clock(on)
  const { commands } = engine(on, 'No goal set')

  await $.command.run({ command: 'goal', args: 'all tests pass' } as never)
  await $.command.run({ command: 'goal', args: 'clear' } as never)
  await $.session.measure(CONTEXT(70))
  await clock.advance(1000)
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'HANDOFF-CONTENT' })
  await $.turn.complete(TURN)
  await clock.advance(1000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.advance(1000)
  await $.turn.complete(TURN)
  await clock.advance(1000)

  expect(commands.map(c => c.command)).toEqual(['goal', 'goal', 'handoff', 'clear'])
})
