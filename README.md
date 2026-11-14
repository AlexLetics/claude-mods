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
6. If a `/goal` was running, the mod sets it again with the same condition once
   Claude has read the handoff, and the goal loop carries on (see [`/goal` across the handoff](#goal-across-the-handoff)).

---

## 3. The files

```
handoff-guard/
├── .claude-plugin/plugin.json   name, description, settings (userConfig)
├── .claude-plugin/marketplace.json  makes this repository installable
├── hooks/hooks.json             points to the code: { "modules": ["./register.ts"] }
├── hooks/register.ts            the actual mod (≈280 lines, commented)
├── tests/flow.test.ts           automated test of the whole cycle
└── README.md                    this file
```

---

## 4. The code step by step (`hooks/register.ts`)

### Lines 1–24: header and states
- **1–18:** Comment with the idea, the state diagram and the `/goal` note.
- **21:** `import type …`: only types are imported. At runtime there is no Node and no `fs`. Everything goes through the `$` object that Claude Code hands to every hook.
- **24:** `type Phase`: the four states. A state machine makes the mod easy to explain and prevents it from firing "twice".

### Lines 26–34: settings
- **29–33:** Default values. The real values come from `plugin.json → userConfig` and can be changed via `/config`.
- **34:** `MAX_WAIT_TURNS`: if the skill hasn't written a handoff after 3 turns, the mod gives up. Normal compaction then acts as the safety net.

### Lines 36–50: memory
- Plain variables (including `goal`, `goalToRestore` and `restoreAfterTurn` for `/goal`). They **survive `/clear`**, because `/clear` only ends the conversation, not the Claude process. The whole trick relies on this: the mod carries the handoff across the boundary.

### Lines 52–157: helper functions
- **59–65 `later`:** Runs work 300 ms later via a timer. Commands like `/clear` must not run *inside* a hook Claude is currently waiting on. The timer detaches them. Errors are shown as a notification instead of being swallowed.
- **69–80 `runHandoff`:** `$.command.run({ command: 'handoff', args })` runs the skill **as if you had typed `/handoff`**. Because it counts as typed, the skill can keep `disable-model-invocation: true`. If it fails, the state goes back to `watching`, and the next measurement tries again.
- **83–90 `startHandoff`:** Sets the state, shows status line and notification, and starts the skill via `later`.
- **93–95 `freshSession`:** `$.command.run({ command: 'clear' })` runs the built-in `/clear` command.
- **100–113 `goalStillActive`:** Right before `/clear`, runs `/goal` without arguments (the status) to check that the tracked goal is still active. A goal can end on its own (met, impossible), and a mod sees no event for that.
- **117–127 `restoreGoal`:** Runs `/goal <condition>` as if you had typed it. Setting a goal starts a turn right away.
- **130–143 `handoffAsText`:** Builds the handoff text with a heading and the file path, plus a note on the goal that will be set again.
- **148–157 `continueWork`:** Sends the first message with the handoff in the fresh session itself (`$.prompt.submit`). The call waits on its own until the session is idle.

### Lines 163–169: `register`
Claude Code calls `register(on, options)` once on load. `options` are the settings, `on(event, hook)` registers the hooks. Every hook has the shape `($, e, next)`:
- `$`: the interface to Claude Code (clock, commands, notifications …)
- `e`: what is happening right now, e.g. the context usage or the Write call
- `next(e)`: "carry on as normal". A hook that doesn't call `next` decides for itself.

### Hook A, lines 171–179: `session.measure`, measuring the usage
Runs **after every response** from Claude. `e.context.percent` is the usage from 0 to 100. If it's above the threshold and the mod is currently watching, the handoff starts. `return next(e)`: the hook only observes and changes nothing.

### Hook B, lines 184–192: `tool.call` for `Write`, capturing the handoff
Runs on every Write call from Claude. **First** the file is written (`await next(e)`). If that succeeded, a handoff is in progress and the file is a `.md`, the mod remembers content and path. So it doesn't matter where the skill saves it. The mod doesn't read the file from disk, it "listens in".
`.catch(… next(e))`: if the mod crashes here, the Write call carries on normally. The mod never blocks.

### Hook C, lines 195–224: `turn.complete`, a turn is finished
- Subagents are ignored (`e.agentId`).
- If the handoff was just delivered and a goal is waiting, the goal is set again now (an interrupted turn waits for the next one).
- If the handoff is there, the state becomes `handoff-done`. Then the mod checks the goal and runs `/clear`, or asks you to with `autoClear: false`.
- If it's missing after 3 turns, the mod gives up. It sets the usage to the fallback value so auto-compact is allowed again.

### Hook D, lines 227–239: `session.end`, `/clear` has happened
`e.reason === 'clear'` means: the old conversation is closed, the process keeps running. Usage goes to 0. In `immediately` mode the mod sends the handoff right away (`continueWork`). In `next-prompt` mode it waits for your next message.

### Hook E, lines 243–252: `prompt.submit`, silently attaching the handoff
Only in `next-prompt` mode: your next message gets the handoff as `context`. Only Claude reads it; in the chat you see only your own text. Slash commands (`e.command`) stay untouched.

### Hook F, lines 255–263: `session.compact`, replacing compaction
This is where auto-compact is actually replaced:
- Subagents and your own `/compact` (`trigger === 'manual'`) run normally.
- **Fallback:** from 90 % usage the mod allows compaction so nothing crashes.
- Otherwise: if no handoff is running yet, the mod starts it now. `return { skip }` then leaves the conversation uncompacted.
- `.catch(… next(e))`: on an error in the mod, compact normally instead.

### Hook G, lines 268–276: `command.run` for `goal`, following your `/goal`
`/goal <condition>` remembers the condition, `/goal clear` (and `stop`, `off`, `reset`,
`none`, `cancel`) forgets it, `/goal` alone only shows the status and changes nothing.
A `/goal` you type yourself after the handoff wins over the one the mod would restore.
The mod's own `/goal` runs don't pass through this hook.

### Hook H, lines 279–283: `tool.call` for `ProposeGoal`, goals Claude proposed
When Claude proposes a goal and it is set, the mod remembers that condition too.

### `/goal` across the handoff
`/clear` removes any active goal, so without this the goal loop stopped at every
handoff. Now:

1. Hooks G and H keep the condition of the running goal.
2. Before `/clear`, `goalStillActive` checks with `/goal` (status) that it hasn't been met or cleared meanwhile.
3. The handoff prompt in the fresh session names the goal.
4. When that turn ends, the mod runs `/goal <condition>`, which starts the goal loop again.

The goal is set only *after* the handoff turn on purpose: setting a goal starts a
turn at once, and Claude should know the handoff before it works toward the goal.
In `next-prompt` mode the goal follows the turn of your next message. The turn
count, timer and token spend of the goal start over, as on `--resume`.

---

## 5. Safety nets

| Case | What happens |
|---|---|
| The skill writes no `.md` | give up after 3 turns, auto-compact is allowed again |
| Usage ≥ 90 % | fallback: normal compaction |
| Error in the mod code | `.catch` lets Claude Code carry on normally |
| You press Esc during the handoff | Claude Code drops queued commands, and the mod retries on the next measurement |
| You type `/compact` yourself | never prevented |
| `/goal` was running | set again after the handoff turn; not if it was met or cleared before `/clear` |

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
claude plugin test ./handoff-guard       # 6 automated tests, no real session needed
```

The tests in `tests/flow.test.ts` play through the whole cycle with a simulated
clock: 40 % → nothing; 70 % → `/handoff`; Write + turn finished → `/clear`;
session end → handoff in the first prompt. They also cover `next-prompt` mode
and check that auto-compact is skipped but a manual `/compact` is not. Three
more cover `/goal`: an active goal is set again after the handoff, an achieved
goal is not, and neither is one you cleared.

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
