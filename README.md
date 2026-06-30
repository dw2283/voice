# Voice Flow

Mac-first clone of the core Wispr Flow experience:

- `fn` hold-to-talk trigger plus an on-screen fallback
- short dictation session
- cloud speech transcription with optional AI polish
- optional AI polish pass
- paste output text back into the active app
- packaged Mac beta release pipeline with signing, notarization, and auto-update hooks

The main experience is a tiny AI voice overlay. Hold `fn`, speak, then release it, and the output text is pasted back into the app you were using. The overlay is an audio-reactive orb rather than a cartoon pet, so it behaves more like a focused voice input tool.

## Run It

```sh
npm run voice:setup
npm run voice:restart
```

`voice:setup` verifies local dependencies, builds the native `fn` listener helper, and creates `.env` from `.env.example` if it is missing. On a fresh machine, run `npm run voice:setup -- --install` to install Node dependencies. Python is only required when you intentionally clear `FLOW_TRANSCRIBE_MODEL` and fall back to local Whisper.

`voice:restart` stops stale Voice Flow API, Electron, and local transcription worker processes, then starts one clean backend and one clean desktop app. Logs go to `.cache/logs`.

Use `fn` on macOS as the default trigger: hold it to dictate, then release it to stop and paste. If `fn` is unavailable on the current keyboard, you can still fall back to the dashboard trigger button or switch to `FLOW_TRIGGER_MODE=hotkey` and set `FLOW_HOTKEY`. Right-click the tiny overlay to open the dashboard.

The default auto-stop timing is tuned for speed: `FLOW_AUTO_STOP_SILENCE_MS=650`, `FLOW_MIN_RECORDING_MS=700`, and `FLOW_AUTO_STOP_MAX_INITIAL_SILENCE_MS=8000`.

## Runtime Setup

The local `.env` file is gitignored and stores the OpenAI-compatible endpoint, model names, bearer tokens, trigger mode, fallback hotkey, polish toggle, and OpenAI key. The current default flow is:

- desktop capture: Electron + native microphone permission
- transcription: OpenAI-compatible model, default `gpt-4o-mini-transcribe`
- polish: OpenAI-compatible `gpt-4.1-mini` when `FLOW_POLISH_ENABLED=true`
- paste-back: macOS clipboard + Command-V into the previously active app
- desktop auth: first-run API base URL + Voice Flow service token, stored in the app's local config and macOS secure storage
- API auth: `/v1/dictate` requires `Authorization: Bearer ...` when `FLOW_API_TOKENS` is configured

Set `FLOW_POLISH_ENABLED=false` to skip the AI polish pass entirely. In that mode, the API still transcribes audio, returns `polishedText` equal to `rawTranscript`, and reports `modelInfo.polish` as `disabled`.

If you want local Whisper instead of cloud transcription, clear `FLOW_TRANSCRIBE_MODEL` and keep the local Whisper settings. `voice:setup` and `voice:doctor` will then expect the workspace `.venv` and `faster-whisper`.

## Cloud Beta

The fastest way to share Voice Flow with other people is to host `apps/api` on a public URL and treat the Mac app as a client.

1. Deploy `apps/api` to Render or another public Node host.
2. Set `OPENAI_API_KEY` plus one or more `FLOW_API_TOKENS` values on that hosted API.
3. Send testers the packaged Mac app, the hosted `API Base URL`, and their Voice Flow token.
4. On first launch, they open Settings and save those two values.

`render.yaml` already includes the reference Render service with cloud defaults:

- `FLOW_TRANSCRIBE_PROVIDER=openai`
- `FLOW_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`
- `FLOW_POLISH_ENABLED=true`
- `FLOW_POLISH_MODEL=gpt-4.1-mini`

Do not ship your raw OpenAI key inside the desktop app. Testers should only enter the hosted API route and the Voice Flow service token.

See [docs/beta-distribution.md](/Users/dingwang/Documents/voice/docs/beta-distribution.md) for the exact deployment and tester handoff steps.

## Commands

- `npm run voice:setup`: verify local setup and create missing config files.
- `npm run voice:doctor`: check local config, dependencies, processes, API health, and recent logs.
- `npm run voice:focus-smoke`: best-effort focus probe for `FLOW_TRIGGER_MODE=hotkey`; if you stay on the default `fn` mode, use `voice:manual-check` instead.
- `npm run voice:focus-smoke -- --preflight-only`: verify focus-smoke prerequisites without opening TextEdit or pressing the trigger.
- `npm run voice:flow-smoke`: generate test audio, transcribe and polish it, paste the polished text into TextEdit, then read it back.
- `npm run voice:hotkey-smoke`: best-effort automated trigger proxy for `FLOW_TRIGGER_MODE=hotkey`; still requires manual confirmation when speaker-to-microphone capture fails.
- `npm run voice:hotkey-smoke -- --preflight-only`: verify trigger-smoke prerequisites without pressing the trigger or playing audio.
- `npm run voice:manual-check`: open TextEdit, guide a real trigger + live microphone check, auto-detect the pasted result, then record pass or fail.
- `npm run voice:manual-check -- --preflight-only`: verify the manual-check prerequisites without opening TextEdit.
- `npm run voice:manual-check -- --wait-for-enter`: use the older manual confirmation flow if auto-detection is not desired.
- `npm run voice:smoke`: generate a short test audio file and verify transcription plus polish end to end.
- `npm run voice:paste-smoke`: paste a timestamp into a temporary TextEdit document through the same Electron paste helper.
- `npm run voice:start`: start backend and desktop as background processes.
- `npm run voice:stop`: stop backend, desktop, and lingering local transcription workers.
- `npm run voice:restart`: clean restart the full app.
- `npm run dev:api`: run only the API in the foreground.
- `npm run dev:desktop`: run only Electron in the foreground.
- `npm run build:fn-listener`: compile the current-machine macOS helper used for `fn` hold detection.
- `npm run release:mac`: build the signed/notarized Mac beta payloads when release secrets are configured.
- `npm run release:mac:dir`: build an unpacked Apple Silicon Mac app directory for local packaging verification.

`voice:manual-check` writes its latest result to `.cache/manual-check-result.json` so the final human check can be recorded without relying on chat history.
`voice:focus-smoke` writes its latest result to `.cache/focus-smoke-result.json`; it only automates the fallback hotkey path, so `fn` mode still needs `voice:manual-check`.
`voice:hotkey-smoke` writes its latest result to `.cache/hotkey-smoke-result.json`; it only automates the fallback hotkey path and may fail if macOS speaker audio is not captured by the microphone.

## Repo layout

- `apps/desktop`: Electron shell for capture, status UI, and paste-back
- `apps/api`: dictation API and model-provider adapter layer
- `packages/shared`: runtime validation and prompt-building helpers
- `scripts`: clean start/stop launchers for the local desktop stack
- `docs`: product notes and architecture decisions

## Current state

- `apps/api` serves the playground and health check on `http://127.0.0.1:8000/` by default, or any host you set with `FLOW_API_HOST`.
- `apps/desktop` defaults to a hidden AI voice overlay and wakes near the active window, falling back to the mouse cursor when needed.
- Browser `SpeechRecognition` is disabled for the desktop path; audio goes through the backend.
- Desktop release builds currently target Apple Silicon first and resolve the `fn` listener from a bundled binary instead of compiling Objective-C at runtime.
- `render.yaml` defines a reference Render deployment for the API, and `.github/workflows/release.yml` defines the Mac beta release pipeline.
