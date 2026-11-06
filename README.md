# Handoff Guard

A mod for Claude Code. It replaces automatic compaction with a **handoff**:
when the context fills up, the handoff skill writes a handoff, a fresh session
starts, and the handoff is fed back in there. This happens automatically in
every session, without you typing anything.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install handoff-guard --marketplace AlexLetics/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user = all projects).

From a shell:

```
claude plugin install handoff-guard --marketplace AlexLetics/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then
Plugins, Add marketplace with `AlexLetics/claude-mods`, then Add plugin.

**Requirement:** a skill that writes a handoff as a `.md` file, invoked as `/handoff`
by default (set another name with the `skill` setting). The mod does not ship that skill.
It was built and tested with Matt Pocock's `handoff` skill (see [Credits](#credits)).

---

## 1. The problem

When the context window is full, Claude Code summarizes the conversation by
itself ("auto-compact"). Important details get lost, and **you don't decide
what stays**. A custom handoff skill writes better handoffs, but only if you
remember to run it by hand in time.

Why not just use the built-in tools?

| Tool | knows the context usage | can trigger a command | can prevent auto-compact |
|---|---|---|---|
| Hook in `settings.json` | no | no | only block it, with no replacement |
| Status line | yes | no | no |
| External process (e.g. *cozempic*) | yes, via the transcript file | only by killing and restarting Claude | no |
| **Mod** | **yes** (`$.session.usage`, `session.measure`) | **yes** (`$.command.run`, `$.prompt.submit`) | **yes** (`session.compact` → `skip`) |

A mod runs **inside** Claude Code. That's why it can do all three.

---

## 2. The flow in one picture

```
                usage ≥ 65 %
  watching ─────────────────────▶ handoff-running
      ▲        (or auto-compact      │  /handoff runs, Claude writes
      │         was intercepted)     │  the handoff (Write *.md)
      │                              ▼
      │                         handoff-done
      │                              │  /clear
      │                              ▼
      └──── first prompt ──── awaiting-handoff
          receives the handoff
```

What you see:

1. You work as usual.
2. The context reaches 65 %. A notification appears: *"Context at 65 % – writing handoff"*.
3. As soon as Claude is idle, `/handoff` runs as if you had typed it, and the handoff is written.
4. The mod runs `/clear`. The old conversation is closed, the context is empty.
5. The mod sends the handoff as the first message, and Claude continues the work.

---

## 3. The files

```
handoff-guard/
├── .claude-plugin/plugin.json   name, description, settings (userConfig)
├── .claude-plugin/marketplace.json  makes this repository installable
├── hooks/hooks.json             points to the code: { "modules": ["./register.ts"] }
├── hooks/register.ts            the actual mod (≈200 lines, commented)
├── tests/flow.test.ts           automated test of the whole cycle
└── README.md                    this file
```

---

## 4. The code step by step (`hooks/register.ts`)

### Lines 1–21: header and states
- **1–15:** Comment with the idea and the state diagram.
- **18:** `import type …`: only types are imported. At runtime there is no Node and no `fs`. Everything goes through the `$` object that Claude Code hands to every hook.
- **21:** `type Phase`: the four states. A state machine makes the mod easy to explain and prevents it from firing "twice".

### Lines 23–31: settings
- **26–30:** Default values. The real values come from `plugin.json → userConfig` and can be changed via `/config`.
- **31:** `MAX_WAIT_TURNS`: if the skill hasn't written a handoff after 3 turns, the mod gives up. Normal compaction then acts as the safety net.

### Lines 33–41: memory
- Plain variables. They **survive `/clear`**, because `/clear` only ends the conversation, not the Claude process. The whole trick relies on this: the mod carries the handoff across the boundary.

### Lines 43–107: helper functions
- **50–56 `later`:** Runs work 300 ms later via a timer. Commands like `/clear` must not run *inside* a hook Claude is currently waiting on. The timer detaches them. Errors are shown as a notification instead of being swallowed.
- **60–71 `runHandoff`:** `$.command.run({ command: 'handoff', args })` runs the skill **as if you had typed `/handoff`**. Because it counts as typed, the skill can keep `disable-model-invocation: true`. If it fails, the state goes back to `watching`, and the next measurement tries again.
- **74–81 `startHandoff`:** Sets the state, shows status line and notification, and starts the skill via `later`.
- **84–86 `freshSession`:** `$.command.run({ command: 'clear' })` runs the built-in `/clear` command.
- **89–94 `handoffAsText`:** Builds the handoff text with a heading and the file path.
- **99–107 `continueWork`:** Sends the first message with the handoff in the fresh session itself (`$.prompt.submit`). The call waits on its own until the session is idle.

### Lines 113–118: `register`
Claude Code calls `register(on, options)` once on load. `options` are the settings, `on(event, hook)` registers the hooks. Every hook has the shape `($, e, next)`:
- `$`: the interface to Claude Code (clock, commands, notifications …)
- `e`: what is happening right now, e.g. the context usage or the Write call
- `next(e)`: "carry on as normal". A hook that doesn't call `next` decides for itself.

### Hook A, lines 121–129: `session.measure`, measuring the usage
Runs **after every response** from Claude. `e.context.percent` is the usage from 0 to 100. If it's above the threshold and the mod is currently watching, the handoff starts. `return next(e)`: the hook only observes and changes nothing.

### Hook B, lines 134–142: `tool.call` for `Write`, capturing the handoff
Runs on every Write call from Claude. **First** the file is written (`await next(e)`). If that succeeded, a handoff is in progress and the file is a `.md`, the mod remembers content and path. So it doesn't matter where the skill saves it. The mod doesn't read the file from disk, it "listens in".
`.catch(… next(e))`: if the mod crashes here, the Write call carries on normally. The mod never blocks.

### Hook C, lines 145–166: `turn.complete`, a turn is finished
- Subagents are ignored (`e.agentId`).
- If the handoff is there, the state becomes `handoff-done`. Then the mod runs `/clear`, or asks you to with `autoClear: false`.
- If it's missing after 3 turns, the mod gives up. It sets the usage to the fallback value so auto-compact is allowed again.

### Hook D, lines 169–177: `session.end`, `/clear` has happened
`e.reason === 'clear'` means: the old conversation is closed, the process keeps running. Usage goes to 0. In `immediately` mode the mod sends the handoff right away (`continueWork`). In `next-prompt` mode it waits for your next message.

### Hook E, lines 181–189: `prompt.submit`, silently attaching the handoff
Only in `next-prompt` mode: your next message gets the handoff as `context`. Only Claude reads it; in the chat you see only your own text. Slash commands (`e.command`) stay untouched.

### Hook F, lines 192–200: `session.compact`, replacing compaction
This is where auto-compact is actually replaced:
- Subagents and your own `/compact` (`trigger === 'manual'`) run normally.
- **Fallback:** from 90 % usage the mod allows compaction so nothing crashes.
- Otherwise: if no handoff is running yet, the mod starts it now. `return { skip }` then leaves the conversation uncompacted.
- `.catch(… next(e))`: on an error in the mod, compact normally instead.

---

## 5. Safety nets

| Case | What happens |
|---|---|
| The skill writes no `.md` | give up after 3 turns, auto-compact is allowed again |
| Usage ≥ 90 % | fallback: normal compaction |
| Error in the mod code | `.catch` lets Claude Code carry on normally |
| You press Esc during the handoff | Claude Code drops queued commands, and the mod retries on the next measurement |
| You type `/compact` yourself | never prevented |

---

## 6. Settings (`/config` or `plugin.json`)

| Field | Default | Meaning |
|---|---|---|
| `threshold` | 65 | start the handoff from this usage |
| `fallbackAt` | 90 | allow normal compaction from here |
| `skill` | `handoff` | name of the skill that writes the handoff |
| `autoClear` | `true` | run `/clear` by itself |
| `resume` | `immediately` | `immediately` = continue right away · `next-prompt` = handoff silently attached to your next message |

Change a setting in the local terminal session (not over Remote Control):

```
/config handoff-guard.threshold=5
```

---

## 7. Checking and testing

```bash
claude plugin validate ./handoff-guard   # what does the mod hook into, what does it call?
claude plugin test ./handoff-guard       # 3 automated tests, no real session needed
```

The tests in `tests/flow.test.ts` play through the whole cycle with a simulated
clock: 40 % → nothing; 70 % → `/handoff`; Write + turn finished → `/clear`;
session end → handoff in the first prompt. They also cover `next-prompt` mode
and check that auto-compact is skipped but a manual `/compact` is not.

Try it live without waiting for 65 %: temporarily set `threshold` to e.g. `5`.

---

## Credits

The handoff itself is written by the **`handoff` skill by Matt Pocock**, from his
collection [mattpocock/skills](https://github.com/mattpocock/skills) (MIT License):
[skills/productivity/handoff/SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md).
Install that skill first; this mod only decides *when* it runs and carries its result
into the fresh session.

---

## License

MIT, see [LICENSE](LICENSE).
