# dictate

Local, private speech-to-text for Claude Code. Hold Space, speak, and your words
stream into the prompt box as you talk. Transcription runs on a speech model served
by [llama-swap](https://github.com/mostlygeek/llama-swap) on your own machine, so
audio never goes to a cloud service. It is a "mod" (a Claude Code plugin with a hooks
module) and does not change Claude Code itself.

## Requirements

- Claude Code with plugin hooks modules (developed on 2.1.319, Linux).
- [`uv`](https://docs.astral.sh/uv/), which runs the bundled helper script and installs
  its one dependency (`httpx`) on first use.
- PulseAudio or PipeWire with `parecord` on the PATH, and a working microphone.
- A llama-swap server (default `http://localhost:8181`) exposing an audio-input chat
  model named `lfm3-audio-2b` on `/v1/chat/completions` (OpenAI-style `input_audio`
  content). Any model that transcribes `input_audio` can be used via `ASR_MODEL`.

## Install

In a Claude Code terminal session:

```
/plugin install dictate --marketplace metodn/dictate_asr
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install dictate --marketplace metodn/dictate_asr
```

To try it without installing, clone the repository and load it for one session:

```
git clone https://github.com/metodn/dictate_asr
claude --plugin-dir ./dictate_asr
```

## Use

| Command | What it does |
| --- | --- |
| `/dictate` | Switch local dictation on or off. On: the built-in `/voice` is turned off so Space is free for this mod. Off: `/voice hold` is turned back on. It never starts a recording by itself. |
| `/dictate info` (any argument) | Show which server the audio goes to, the model, whether the server is reachable, and whether the mode is on. Changes nothing. |
| Hold **Space** | While the mode is on: recording starts after the key-repeat warm-up (about half a second), words appear dimmed in the prompt as you speak, and releasing Space finalizes the text at your caret. |

A red `REC` line shows above the prompt while recording and a yellow one while the
final transcript is produced. If you edit the prompt while it finishes, your edit is
left alone and the transcript is inserted at the caret.

The mode lasts for the current session only. Switching `/voice` needs a Claude Code
session signed in with a claude.ai account (that is where `/voice` exists); without it
the mod says so and leaves `/voice` alone, and Space-hold dictation still works.

## Configuration

Set these environment variables in the shell that starts `claude`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SWAP` | `http://localhost:8181` | llama-swap base URL |
| `ASR_MODEL` | `lfm3-audio-2b` | model name sent to the server |
| `ASR_LANG` | unset (auto-detect) | pin a language, e.g. `German` |
| `STEP_SEC` | `1.0` | seconds of new audio between live updates |
| `MAX_SECS` | `120` | longest recording |

## Privacy

Audio is recorded locally with `parecord` and sent only to the server in `SWAP`.
`/dictate info` prints that address and labels it as this machine or a remote host.
Nothing is written to disk by the helper except a small pid file in
`$XDG_RUNTIME_DIR/claude-dictate/`.

## Limitations

- While Space is held, Claude Code's editor moves the cursor one column and back on
  each key repeat. A mod cannot change that, so the cursor block flickers during a hold.
- Recording starts about 0.5 s after Space goes down (the OS key-repeat delay).
- Short or quiet speech can be misheard. Leading silence is trimmed to avoid invented text.
- Tested on Linux with PipeWire only.

## License

MIT
