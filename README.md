# dictate

Local, private speech-to-text for Claude Code. Hold Space, or run `/dictate rec` for
hands-free recording, speak, and your words stream into the prompt box as you talk. Transcription runs on a speech model served
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
| `/dictate` | Switch Space-hold dictation on or off. On: the built-in `/voice` is turned off so Space is free for this mod. Off: `/voice hold` is turned back on. It never starts a recording by itself. |
| `/dictate rec` | Hands-free recording: the first run starts it, **Enter** or a second `/dictate rec` finishes it. Enter does not send the prompt while a recording runs. Works without `/dictate` being on. |
| `/dictate help` | Show the commands. |
| `/dictate info` | Show the servers (`*` marks the active one, with `[ready]`, `[down]`, `[needs an API key]`, `[API key rejected]`), the mode and the placement. Changes nothing. |
| `/dictate use <name>` | Make a server the active one. |
| `/dictate add <name> <host[:port]\|url> [model] [key=<API key>]` | Add or update a server. Model defaults to `lfm3-audio-2b`. Re-adding without `key=` keeps the saved key. |
| `/dictate remove <name>` | Remove a server (the last one cannot be removed). |
| `/dictate where start\|caret\|end` | Where the words go in the draft. Saved across sessions. Default `caret`. |
| Hold **Space** | While the mode is on: recording starts after the key-repeat warm-up (about half a second), words appear dimmed in the prompt as you speak, and releasing Space finalizes the text. |

A shortcut such as Ctrl+R is not possible: a Claude Code mod only sees keys that edit the
prompt text, so Ctrl and Alt combinations never reach it. That is why hands-free recording
is a command.

A red `REC` line shows above the prompt while recording and a yellow one while the
final transcript is produced. If you edit the prompt while it finishes, your edit is
left alone and the transcript is inserted at the caret.

The mode lasts for the current session only. Switching `/voice` needs a Claude Code
session signed in with a claude.ai account (that is where `/voice` exists); without it
the mod says so and leaves `/voice` alone, and Space-hold dictation still works.

## Configuration

Servers are kept in `~/.config/claude-dictate/servers.json` (mode 600), managed with
`/dictate add|use|remove`, or edited by hand:

```json
{
  "active": "local",
  "servers": [
    { "name": "local", "url": "http://localhost:8181", "model": "lfm3-audio-2b", "apiKey": "<token>" },
    { "name": "desk", "url": "http://desk.local:8181", "model": "lfm3-audio-2b" }
  ]
}
```

- The `active` server is tried first. If it fails (connection error or HTTP error), the others
  are tried in order; the red REC line then shows `asr: desk (fallback, local failed)`.
- `apiKey` (optional, per server) is sent as `Authorization: Bearer <apiKey>`. Keys are stored in
  plain text in that file: do not commit or share it.
- Without a file there is one server, `local`, at `http://localhost:8181`.

Environment variables, set in the shell that starts `claude`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SWAP`, `ASR_MODEL`, `ASR_API_KEY` | unset | If `SWAP` is set, it defines one server (`env`) that replaces the file. |
| `ASR_LANG` | unset (auto-detect) | pin a language, e.g. `German` |
| `STEP_SEC` | `1.0` | seconds of new audio between live updates |
| `MAX_SECS` | `120` | longest recording |

## Privacy

Audio is recorded locally with `parecord` and sent only to the servers you configured, in
the order active first, then the others if it fails. `/dictate info` lists them. Nothing is
written to disk except a small pid file in `$XDG_RUNTIME_DIR/claude-dictate/` and the
server file above, which can hold API keys.

## Limitations

- While Space is held, Claude Code's editor moves the cursor one column and back on
  each key repeat. A mod cannot change that, so the cursor block flickers during a hold.
- Recording starts about 0.5 s after Space goes down (the OS key-repeat delay).
- Short or quiet speech can be misheard. Leading silence is trimmed to avoid invented text.
- Tested on Linux with PipeWire only.

## License

MIT
