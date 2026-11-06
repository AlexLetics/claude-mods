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
