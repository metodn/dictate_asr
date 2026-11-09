import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Phase } from '../types'

// bin/claude-dictate-ws records the mic and transcribes through llama-swap (needs `uv`).
function helper($: EngineInterface, subcommand: 'record' | 'stop' | 'info') {
  return ['uv', 'run', '--script', `${$.plugin.root}/bin/claude-dictate-ws`, subcommand]
}
// Terminals send no key-release. Holding Space auto-repeats (~25-40 ms apart after a
// ~500 ms delay): spaces closer than REPEAT_MS mean "held", RELEASE_TICKS quiet polls
// mean "released".
const REPEAT_MS = 120
const POLL_MS = 60
const RELEASE_TICKS = 2

const phase = atom({ plugin: 'dictate', key: 'phase' } as const, 'idle' as Phase)
// Local dictation mode (/dictate): built-in /voice off, hold Space dictates locally.
const mode = atom({ plugin: 'dictate', key: 'mode' } as const, false)

let isMode = false // mirrors the `mode` atom; gates the Space hold
let isRecording = false
let isHeld = false
let lastSpaceAt = 0
let spaceRun = 0 // consecutive spaces typed so far
let poll: Timer | undefined
let repeats = 0 // repeat spaces seen since the last poll
let quietTicks = 0

// The draft around the caret when recording began; the transcript lives between them.
type Anchor = { before: string; after: string }

function anchorOf(text: string, cursor: number): Anchor {
  return { before: text.slice(0, cursor), after: text.slice(cursor) }
}

// Put `words` between the anchor halves, like /voice: interim text dimmed in the draft,
// the final text plain, the caret at the end of what was inserted. If the person edited
// the draft meanwhile (it no longer holds what we last wrote), leave their edit alone
// and only insert the final text at the caret.
type Written = { text: string; isLost: boolean }

async function show($: EngineInterface, anchor: Anchor, w: Written, words: string, isFinal: boolean) {
  const box = await $.prompt.read()
  if (!w.isLost && box.text !== w.text) w.isLost = true
  if (w.isLost) {
    if (isFinal && words) await $.prompt.fill({ text: words, mode: 'insert' })
    return
  }
  const gap = words && anchor.before && !/\s$/.test(anchor.before) ? ' ' : ''
  const from = anchor.before.length
  const to = from + gap.length + words.length
  const text = anchor.before + gap + words + anchor.after
  const filled = await $.prompt.fill({
    text,
    mode: 'replace',
    cursor: to,
    decorations: isFinal || !words ? undefined : [{ start: from, end: to, dimColor: true }],
  })
  if (filled.isFilled) w.text = text
}

function start($: EngineInterface, anchor: Anchor) {
  isRecording = true
  void update($, phase, () => 'recording')
  // Warm the ASR model (llama-swap may have unloaded it) while the person speaks.
  void $.process.run(['curl', '-s', '-m', '30', '-o', '/dev/null', 'http://localhost:8181/upstream/lfm3-audio-2b/health'])
  void (async () => {
    const w: Written = { text: anchor.before + anchor.after, isLost: false }
    let buffer = ''
    let final: string | undefined
    let problem = ''
    try {
      for await (const { stream, text } of $.process.spawn({ argv: helper($, 'record') })) {
        if (stream !== 'stdout') continue
        buffer += text
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          let msg: { t: string; text: string }
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg.t === 'p') await show($, anchor, w, msg.text, false)
          else if (msg.t === 'f') final = msg.text
          else if (msg.t === 'e') problem = msg.text
        }
      }
    } catch (error) {
      problem = String(error)
    }
    isRecording = false
    await show($, anchor, w, final ?? '', true)
    await update($, phase, () => 'idle')
    if (!final) $.ui.toast(`dictate: ${problem || 'no speech heard'}`.slice(0, 140))
  })()
}

// The engine refuses $.command.run from inside a command.run hook (it would wait on itself),
// so ask for the built-in /voice change a moment later, from a timer.
function setVoice($: EngineInterface, args: 'off' | 'hold') {
  $.clock.after(400, () => {
    void (async () => {
      try {
        // /voice only exists in sessions signed in with a claude.ai account.
        if (!(await $.command.list()).some(c => c.name === 'voice')) {
          $.ui.toast('dictate: built-in /voice is not available in this session, nothing to switch', { timeoutMs: 6000 })
          return
        }
        await $.command.run({ command: 'voice', args })
      } catch (error) {
        $.ui.toast(`dictate: could not run /voice ${args}: ${String(error).slice(0, 100)}`, { timeoutMs: 6000 })
      }
    })()
  })
}

async function stop($: EngineInterface) {
  await update($, phase, () => 'transcribing')
  await $.process.run(helper($, 'stop'))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dictate',
      description: 'Switch local dictation on/off (turns built-in /voice off/on). With an argument, e.g. /dictate info: show the server',
    })
    isMode = await read($, mode)
    return next(e)
  })

  on('command.run', { command: 'dictate' }, async ($, e) => {
    // Any argument: report where the voice goes, and change nothing.
    if (e.args.trim()) {
      const { stdout, stderr } = await $.process.run(helper($, 'info'), { timeoutMs: 15000 })
      return { text: `${stdout.trim() || stderr.trim() || 'dictate: no info'}\nmode:         ${isMode ? 'ON (hold Space dictates locally)' : 'off'}` }
    }
    // Plain /dictate: swap who owns the Space hold. It never starts a recording itself.
    if (!isMode) {
      isMode = true
      await update($, mode, () => true)
      setVoice($, 'off')
      return { text: 'Local dictation ON: hold Space to dictate (built-in /voice turned off). Run /dictate again to switch back.' }
    }
    isMode = false
    await update($, mode, () => false)
    if (isRecording) await stop($)
    setVoice($, 'hold')
    return { text: 'Local dictation OFF: built-in /voice turned back on (hold).' }
  })

  // Colored state line above the prompt; absent when idle.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, phase)
    const { Box, Text } = $.ui.resolve(e)
    if (p === 'idle') return next(e)
    return (
      <Box>
        {p === 'recording' ? (
          <Text color="red" bold>● REC  release Space to finish</Text>
        ) : (
          <Text color="yellow" bold>◌ transcribing…</Text>
        )}
      </Box>
    )
  })

  // Hold Space = push to talk.
  on('prompt.edit', async ($, e, next) => {
    const isSpace = e.key
      ? (e.key.key === 'space' || e.key.key === ' ') && !e.key.ctrl && !e.key.meta
      : e.inputText.length >= 3 && /^ +$/.test(e.inputText) // burst of repeats folded into one edit
    if (!isMode || !isSpace || e.start !== e.end) {
      spaceRun = 0
      return next(e)
    }
    if (isHeld) {
      repeats++ // hot path while held: no awaits, no timers, no engine edit
      return { text: e.text, cursor: e.cursor }
    }
    const now = await $.clock.now()
    const gap = now - lastSpaceAt
    lastSpaceAt = now
    const added = e.inputText.length || 1
    // Press, then (after the OS repeat delay) the first repeat, then fast repeats:
    // a third space close behind the second means a held key, not typing.
    if (added < 3 && !(spaceRun >= 2 && gap < REPEAT_MS)) {
      spaceRun += added
      return next(e)
    }

    isHeld = true
    quietTicks = 0
    repeats = 0
    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => {
      quietTicks = repeats === 0 ? quietTicks + 1 : 0
      repeats = 0
      if (quietTicks < RELEASE_TICKS) return
      poll?.cancel()
      isHeld = false
      if (isRecording) void stop($)
    })
    // Drop the spaces this press already typed, then record.
    const strip = Math.min(spaceRun, e.start, (e.text.slice(0, e.start).match(/ *$/) ?? [''])[0].length)
    spaceRun = 0
    const text = e.text.slice(0, e.start - strip) + e.text.slice(e.start)
    if (!isRecording) start($, anchorOf(text, e.cursor - strip))
    return next({
      ...e,
      text,
      cursor: e.cursor - strip,
      start: e.start - strip,
      end: e.end - strip,
      inputText: '',
    })
  })
}
