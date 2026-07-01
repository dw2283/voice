# VoiceKit

> Speak naturally. Write everywhere.

VoiceKit is an open-source AI communication layer for macOS.

Hold a key, speak naturally, and VoiceKit turns your speech into clean, paste-ready text for the app you are already using. Instead of stopping at raw transcription, it can refine your words, preserve your intent, and fit the moment faster than manual typing.

```text
Speak -> Understand -> Rewrite -> Paste Anywhere
```

VoiceKit works best anywhere you already write:

- Cursor
- ChatGPT
- Slack
- Mail
- Notion
- Chrome
- Terminal

## Why VoiceKit?

Most dictation tools stop here:

```text
Speech -> Text
```

VoiceKit keeps going:

```text
Speech -> Understanding -> Rewrite -> Paste Anywhere
```

- `Anywhere`: hold a key, talk, and paste polished text back into the active macOS app.
- `Open`: use a hosted API, local development, OpenAI-compatible backends, or local Whisper fallback.
- `Extensible`: providers, prompts, context handling, triggers, and desktop behaviors are all editable.
- `Developer-friendly`: readable source, fast local loop, packaged Mac beta flow, and no black-box client lock-in.

## Quick Start

```sh
npm install
npm run voice:setup
npm run voice:restart
```

Then:

1. Launch the desktop app.
2. Hold your configured key. The default is `control`.
3. Speak naturally.
4. Release the key and let VoiceKit paste the result back.

Right-click the small overlay to open the dashboard and connect a hosted API if needed.

## What You Get

- Hold-to-talk dictation with a tiny floating macOS overlay
- Raw-first, polish-later streaming feedback for faster perceived response time
- AI rewrite pass that can clean up speech without acting like a chat assistant
- Paste-back into the previously active app
- OpenAI-compatible cloud transcription by default
- Optional local Whisper fallback for self-hosted setups
- Packaged Mac beta builds with auto-update hooks

## Cloud Beta

The simplest way to share VoiceKit is to host `apps/api` on a public URL and use the Mac app as the client.

1. Deploy `apps/api` to Render or another public Node host.
2. Set `OPENAI_API_KEY` and one or more `FLOW_API_TOKENS` values on the hosted API.
3. Send testers the packaged Mac app, the hosted `API Base URL`, and their VoiceKit token.
4. Testers open Settings on first launch and save those two values.

See [docs/beta-distribution.md](/Users/dingwang/Documents/voice/docs/beta-distribution.md) for the exact deployment and tester handoff steps.

## Architecture

- `apps/desktop`: Electron shell for trigger handling, overlay UI, settings, and paste-back
- `apps/api`: dictation API and provider layer
- `packages/shared`: contracts, prompts, and shared runtime helpers
- `scripts`: local setup, restart, smoke checks, and packaging helpers

## Builder Notes

VoiceKit is product-first on the surface, but still easy to inspect and extend underneath.

- Desktop auth stores `API Base URL` in local app data and encrypts the API token with macOS secure storage when available.
- Hosted API auth uses `Authorization: Bearer ...` when `FLOW_API_TOKENS` is configured.
- `FLOW_POLISH_ENABLED=false` skips the AI rewrite pass and returns raw transcription as the final result.
- Clearing `FLOW_TRANSCRIBE_MODEL` switches cloud transcription off and enables the local Whisper path instead.

<details>
<summary>Command reference</summary>

### Main commands

- `npm run voice:setup`: verify local setup, build the hold-key helper, and create missing config files.
- `npm run voice:doctor`: inspect config, dependencies, API health, and recent logs.
- `npm run voice:start`: start backend and desktop as background processes.
- `npm run voice:stop`: stop backend, desktop, and local transcription workers.
- `npm run voice:restart`: clean restart the full app.
- `npm run dev:api`: run only the API in the foreground.
- `npm run dev:desktop`: run only Electron in the foreground.

### Validation commands

- `npm run voice:smoke`: generate a short test audio file and verify transcription plus rewrite end to end.
- `npm run voice:paste-smoke`: verify paste automation through the Electron paste helper.
- `npm run voice:manual-check`: walk through a real trigger plus microphone check in TextEdit.
- `npm run voice:focus-smoke`: best-effort focus probe for hotkey mode.
- `npm run voice:hotkey-smoke`: best-effort automated trigger proxy for fallback hotkey mode.

### Build commands

- `npm run build:fn-listener`: compile the macOS helper used for modifier-hold detection.
- `npm run release:mac`: build Mac beta payloads when release secrets are configured.
- `npm run release:mac:dir`: build an unpacked Apple Silicon app directory for local packaging checks.

</details>
