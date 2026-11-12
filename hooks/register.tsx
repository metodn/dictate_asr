import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Phase } from '../types'

// bin/claude-dictate-ws records the mic and transcribes through llama-swap (needs `uv`).
function helper($: EngineInterface, argv: string[]) {
  return ['uv', 'run', '--script', `${$.plugin.root}/bin/claude-dictate-ws`, ...argv]
}
// Terminals send no key-release. Holding Space auto-repeats (~25-40 ms apart after a
// ~500 ms delay): spaces closer than REPEAT_MS mean "held", RELEASE_TICKS quiet polls
// mean "released".
const REPEAT_MS = 120
const POLL_MS = 60
const RELEASE_TICKS = 2

const phase = atom({ plugin: 'dictate', key: 'phase' } as const, 'idle' as Phase)
// Local dictation mode (/dictate): built-in /voice off, hold Space dictates locally.
// Which ASR server answered (shown in the band while recording): 'asr: desk (fallback, local failed)'.
const server = atom({ plugin: 'dictate', key: 'server' } as const, '')
const mode = atom({ plugin: 'dictate', key: 'mode' } as const, false)

let isMode = false // mirrors the `mode` atom; gates the Space hold
let isRecording = false
let isToggle = false // recording was started by /dictate rec (stops on the next /dictate rec)
let isHeld = false
let lastSpaceAt = 0
let spaceRun = 0 // consecutive spaces typed so far
let poll: Timer | undefined
let repeats = 0 // repeat spaces seen since the last poll
let quietTicks = 0

// The draft around the caret when recording began; the transcript lives between them.
type Anchor = { before: string; after: string }

// Where the transcript goes in the draft (global setting, /dictate where ...).
type Where = 'start' | 'caret' | 'end'
let where: Where = 'caret'

function anchorOf(text: string, cursor: number): Anchor {
  if (where === 'start') return { before: '', after: text }
  if (where === 'end') return { before: text, after: '' }
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
  const to = from + gap.length + words.length // caret right after the words, before any separator
  const tail = words && anchor.after && !/^\s/.test(anchor.after) ? ' ' : ''
  const text = anchor.before + gap + words + tail + anchor.after
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
  void $.process.run(helper($, ['warm']), { timeoutMs: 35000 })
  void (async () => {
    const w: Written = { text: anchor.before + anchor.after, isLost: false }
    let buffer = ''
    let final: string | undefined
    let problem = ''
    try {
      for await (const { stream, text } of $.process.spawn({ argv: helper($, ['record']) })) {
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
          else if (msg.t === 's') { const t = msg.text; $.clock.after(0, () => void update($, server, () => t)) }
        }
      }
    } catch (error) {
      problem = String(error)
    }
    isRecording = false
    isToggle = false
    try {
      await show($, anchor, w, final ?? '', true)
    } catch (error) {
      problem ||= `could not write the prompt: ${String(error)}`
    }
    await update($, phase, () => 'idle')
    if (problem) $.ui.toast(`dictate ERROR: ${problem}`.slice(0, 300), { timeoutMs: 15000 })
    else if (!final) $.ui.toast('dictate: no speech heard')
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
  await $.process.run(helper($, ['stop']))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dictate',
      description: 'Dictation on/off (hold Space). Arguments: rec | help | info | use <name> | add <name> <host[:port]> [model] [key=<token>] | remove <name> | where start|caret|end',
    })
    isMode = await read($, mode)
    await update($, phase, () => 'idle') // a reload loses isRecording; never leave a stale REC line
    const saved = await $.store.get('where')
    if (saved === 'start' || saved === 'caret' || saved === 'end') where = saved
    return next(e)
  })

  on('command.run', { command: 'dictate' }, async ($, e) => {
    const arg = e.args.trim()
    const [verb, ...rest] = arg.split(/\s+/)
    const run = async (argv: string[]) => {
      const { stdout, stderr } = await $.process.run(helper($, argv), { timeoutMs: 20000 })
      return stdout.trim() || stderr.trim() || 'dictate: no output'
    }
    if (verb === 'rec') {
      // Hands-free: first run starts, the next one finishes.
      if (isRecording) {
        if (isHeld) return { text: 'dictate: Space is held; release it to finish.' }
        await stop($)
        return { text: 'dictate: finishing the recording...' }
      }
      isToggle = true
      const box = await $.prompt.read()
      const anchor = anchorOf(box.text, box.cursor)
      isRecording = true // block a second start before the timer fires
      $.clock.after(100, () => start($, anchor)) // outlive this command hook
      return { text: 'dictate: recording. Run /dictate rec again to finish.' }
    }
    if (verb === 'where') {
      const w = rest[0]
      if (w !== 'start' && w !== 'caret' && w !== 'end') return { text: `dictate where: ${where}  (set with /dictate where start|caret|end)` }
      where = w
      await $.store.set('where', w)
      return { text: `dictate: transcript now goes at the ${w} of the draft.` }
    }
    if (verb === 'help') return { text: await run(['help']) }
    if (verb === 'use' || verb === 'add' || verb === 'remove') return { text: await run([verb, ...rest]) }
    // Any other argument (info): servers, state, placement; changes nothing.
    if (arg) {
      return { text: `${await run(['info'])}\nmode:         ${isMode ? 'ON (hold Space dictates locally)' : 'off'}\nplacement:    ${where}` }
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

  // Hands-free recording: Enter finishes it instead of sending the draft.
  on('prompt.submit', async ($, e, next) => {
    if (!(isRecording && isToggle)) return next(e)
    await stop($)
    return { drop: 'dictate: recording finished (Enter does not send while recording)' }
  })

  // Colored state line above the prompt; absent when idle.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, phase)
    const srv = await read($, server)
    const { Box, Text } = $.ui.resolve(e)
    if (p === 'idle') return next(e)
    return (
      <Box>
        {p === 'recording' ? (
          <Text color="red" bold>● REC  {isToggle ? 'press Enter or run /dictate rec to finish' : 'release Space to finish'}{srv ? `   ${srv}` : ''}</Text>
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
