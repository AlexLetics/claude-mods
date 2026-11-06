// =============================================================================
// Handoff Guard — a Claude Code mod
//
// Idea: instead of Claude Code compacting automatically when the context is
// full (a lossy summary), the handoff skill writes a handoff in time. Then a
// fresh session starts (/clear) and the handoff is fed back in there.
//
// Flow as a state machine (variable `phase`):
//
//   watching ──(usage ≥ threshold)──▶ handoff-running
//   handoff-running ──(handoff written, turn finished)──▶ handoff-done
//   handoff-done ──(/clear)──▶ awaiting-handoff
//   awaiting-handoff ──(next prompt receives the handoff)──▶ watching
// =============================================================================

// Only types are imported; at runtime Claude Code provides everything via `$`.
import type { Register, EngineInterface } from 'claude-code'

// The guard's four states (see diagram above).
type Phase = 'watching' | 'handoff-running' | 'handoff-done' | 'awaiting-handoff'

// -----------------------------------------------------------------------------
// 1. Settings — filled in `register` from plugin.json → userConfig
// -----------------------------------------------------------------------------
let THRESHOLD = 65 // start the handoff from here (percent)
let FALLBACK_AT = 90 // allow normal compaction again from here (percent)
let SKILL = 'handoff' // which slash command writes the handoff
let AUTO_CLEAR = true // run /clear by itself after the handoff?
let IMMEDIATELY = true // continue right away after /clear?
const MAX_WAIT_TURNS = 3 // wait this many turns for the handoff, then give up

// -----------------------------------------------------------------------------
// 2. The mod's memory — plain variables. They survive /clear because the
//    Claude process keeps running.
// -----------------------------------------------------------------------------
let phase: Phase = 'watching'
let usage = 0 // last measured context usage in percent
let handoffText: string | undefined // content of the handoff file
let handoffPath: string | undefined // where the skill saved it
let waitTurns = 0 // finished turns since the handoff started

// -----------------------------------------------------------------------------
// 3. Helper functions
// -----------------------------------------------------------------------------

// Do work shortly *after* the current hook. Commands like /clear must not run
// inside a hook the turn is currently waiting on — a timer detaches them.
// Errors show up as a short notification (toast).
function later($: EngineInterface, work: () => Promise<unknown>): void {
  $.clock.after(300, () => {
    void work().catch(error => {
      $.ui.toast(`Handoff Guard: ${String(error?.message ?? error)}`)
    })
  })
}

// Run the handoff skill as if you had typed `/handoff`.
// Because it counts as typed, `disable-model-invocation` in the skill doesn't block it.
async function runHandoff($: EngineInterface): Promise<void> {
  try {
    await $.command.run({
      command: SKILL,
      args: 'Continue the current work seamlessly in a fresh session.',
    })
  } catch (error) {
    phase = 'watching' // back to start; retry on the next measurement
    $.ui.status(undefined)
    throw error
  }
}

// Kick off the handoff: set state, show a notice, start the skill delayed.
function startHandoff($: EngineInterface, reason: string): void {
  phase = 'handoff-running'
  waitTurns = 0
  handoffText = undefined
  $.ui.status(`Handoff running (${reason})`)
  $.ui.toast(`Handoff Guard: ${reason} – writing handoff`)
  later($, () => runHandoff($))
}

// Run /clear: ends the old conversation, the process keeps running.
function freshSession($: EngineInterface): Promise<unknown> {
  return $.command.run({ command: 'clear' })
}

// The handoff as text for Claude, with heading and origin.
function handoffAsText(): string {
  return `# Handoff from the previous session
(File: ${handoffPath})

${handoffText}`
}

// Send the first prompt in the fresh session ourselves, with the handoff in it.
// A mod's own prompt does not pass through that mod's prompt.submit hooks,
// so the handoff goes straight into the text here.
function continueWork($: EngineInterface): Promise<unknown> {
  const text = `${handoffAsText()}

---
Read this handoff and continue the work.`
  phase = 'watching' // circle closed
  handoffText = undefined
  return $.prompt.submit({ text })
}

// -----------------------------------------------------------------------------
// 4. The hooks. Claude Code calls `register` once when the mod loads:
//    `on` registers hooks, `options` are the settings from plugin.json.
// -----------------------------------------------------------------------------
export const register: Register = (on, options) => {
  THRESHOLD = Number(options.threshold ?? 65)
  FALLBACK_AT = Number(options.fallbackAt ?? 90)
  SKILL = String(options.skill ?? 'handoff')
  AUTO_CLEAR = options.autoClear !== false
  IMMEDIATELY = options.resume !== 'next-prompt'

  // --- Hook A: measure usage — runs after every response from Claude ---------
  on('session.measure', ($, e, next) => {
    const percent = e.context.percent // 0–100, or undefined before the first response
    if (percent !== undefined) usage = percent

    if (phase === 'watching' && percent !== undefined && percent >= THRESHOLD) {
      startHandoff($, `Context at ${percent} %`)
    }
    return next(e) // pure observer: change nothing
  })

  // --- Hook B: capture the handoff file — every Write call from Claude -------
  // While the handoff runs, we remember the .md file that gets written.
  // That way it doesn't matter where the skill saves it.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const result = await next(e) // let the write actually happen first
    const succeeded = result.deny === undefined && result.isError !== true
    if (phase === 'handoff-running' && succeeded && e.file_path.toLowerCase().endsWith('.md')) {
      handoffText = e.content
      handoffPath = e.file_path
    }
    return result // hand the result back to Claude unchanged
  }).catch(($, e, next) => next(e)) // error in the mod? carry on normally, never block

  // --- Hook C: a turn is finished — is the handoff there? --------------------
  on('turn.complete', ($, e, next) => {
    // Subagents and other phases don't matter here.
    if (e.agentId !== undefined || phase !== 'handoff-running') return next(e)

    if (handoffText !== undefined) {
      phase = 'handoff-done'
      $.ui.status(undefined)
      if (AUTO_CLEAR) {
        $.ui.toast('Handoff Guard: handoff saved – starting fresh session')
        later($, () => freshSession($))
      } else {
        $.ui.toast(`Handoff Guard: handoff at ${handoffPath} – type /clear`)
      }
    } else if (++waitTurns >= MAX_WAIT_TURNS) {
      // No handoff found: give up so auto-compact acts as a safety net.
      phase = 'watching'
      usage = Math.max(usage, FALLBACK_AT)
      $.ui.status(undefined)
      $.ui.toast('Handoff Guard: no handoff found – normal compaction stays active')
    }
    return next(e)
  })

  // --- Hook D: session ends — on /clear, queue the handoff for the new one ---
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear' && phase === 'handoff-done' && handoffText !== undefined) {
      phase = 'awaiting-handoff'
      usage = 0 // new session, empty context
      if (IMMEDIATELY) later($, () => continueWork($))
      else $.ui.toast('Handoff Guard: handoff will be attached to your next message')
    }
    return next(e)
  })

  // --- Hook E: prompt is submitted — attach the handoff invisibly ------------
  // `context` is read only by Claude; in the chat you see only your own text.
  on('prompt.submit', ($, e, next) => {
    if (phase !== 'awaiting-handoff' || handoffText === undefined || e.command !== undefined) {
      return next(e) // slash commands and normal prompts stay unchanged
    }
    const attachment = handoffAsText()
    phase = 'watching' // circle closed
    handoffText = undefined
    return next({ ...e, context: [...(e.context ?? []), attachment] })
  }).catch(($, e, next) => next(e)) // error in the mod? send the prompt anyway

  // --- Hook F: compaction is due — replace it with the handoff ---------------
  on('session.compact', ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // subagents compact normally
    if (e.trigger === 'manual') return next(e) // respect your own /compact
    if (usage >= FALLBACK_AT) return next(e) // fallback: better compact than crash

    // Automatic compaction with no handoff running → start the handoff now.
    if (phase === 'watching') startHandoff($, 'Auto-compact intercepted')
    return { skip: 'Handoff Guard replaces compaction with a handoff' }
  }).catch(($, e, next) => next(e)) // error in the mod? then compact normally
}
