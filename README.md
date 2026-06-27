# Voice Flow

Mac-first clone of the core Wispr Flow experience:

- global hotkey or on-screen trigger
- short dictation session
- local speech transcription with model polish
- AI polish pass
- paste polished text back into the active app

The main experience is a tiny AI voice overlay. Press the hotkey once, speak, pause briefly, and the cleaned text is pasted back into the app you were using. The overlay is an audio-reactive orb rather than a cartoon pet, so it behaves more like a focused voice input tool.

## Run It

```sh
npm run voice:setup
npm run voice:restart
```

`voice:setup` verifies local dependencies and creates `.env` from `.env.example` if it is missing. On a fresh machine, run `npm run voice:setup -- --install` to install Node and Python dependencies.

`voice:restart` stops stale Voice Flow API, Electron, and local transcription worker processes, then starts one clean backend and one clean desktop app. Logs go to `.cache/logs`.

Use `Alt+Space` on macOS, shown as `Option + Space`, to start dictation at the cursor. Voice Flow auto-stops after a short pause and pastes the result; pressing the hotkey again is only a manual stop fallback. This keeps the Wispr Flow-style hands-free rhythm while using an Electron-friendly global shortcut. Right-click the tiny overlay to open the dashboard.

The default auto-stop timing is tuned for speed: `FLOW_AUTO_STOP_SILENCE_MS=650`, `FLOW_MIN_RECORDING_MS=700`, and `FLOW_AUTO_STOP_MAX_INITIAL_SILENCE_MS=8000`. The API also prewarms the local Whisper worker on startup so the first real dictation after `voice:restart` does not pay the full model-load cost.

## Runtime Setup

The local `.env` file is gitignored and stores the OpenAI-compatible endpoint, model names, hotkey, and API key. The current configured flow is:

- desktop capture: Electron + native microphone permission
- transcription: local `faster-whisper` model, default `base`
- polish: OpenAI-compatible `gpt-4.1-mini`
- paste-back: macOS clipboard + Command-V into the previously active app

## Commands

- `npm run voice:setup`: verify local setup and create missing config files.
- `npm run voice:doctor`: check local config, dependencies, processes, API health, and recent logs.
- `npm run voice:focus-smoke`: best-effort global-hotkey focus probe that checks whether TextEdit stays frontmost after `Option+Space`.
- `npm run voice:focus-smoke -- --preflight-only`: verify focus-smoke prerequisites without opening TextEdit or pressing the hotkey.
- `npm run voice:flow-smoke`: generate test audio, transcribe and polish it, paste the polished text into TextEdit, then read it back.
- `npm run voice:hotkey-smoke`: best-effort automated global-hotkey proxy using TextEdit and macOS `say`; still requires manual confirmation when speaker-to-microphone capture fails.
- `npm run voice:hotkey-smoke -- --preflight-only`: verify hotkey-smoke prerequisites without pressing the hotkey or playing audio.
- `npm run voice:manual-check`: open TextEdit, guide a real hotkey + live microphone check, auto-detect the pasted result, then record pass or fail.
- `npm run voice:manual-check -- --preflight-only`: verify the manual-check prerequisites without opening TextEdit.
- `npm run voice:manual-check -- --wait-for-enter`: use the older manual confirmation flow if auto-detection is not desired.
- `npm run voice:smoke`: generate a short test audio file and verify transcription plus polish end to end.
- `npm run voice:paste-smoke`: paste a timestamp into a temporary TextEdit document through the same Electron paste helper.
- `npm run voice:start`: start backend and desktop as background processes.
- `npm run voice:stop`: stop backend, desktop, and lingering local transcription workers.
- `npm run voice:restart`: clean restart the full app.
- `npm run dev:api`: run only the API in the foreground.
- `npm run dev:desktop`: run only Electron in the foreground.

`voice:manual-check` writes its latest result to `.cache/manual-check-result.json` so the final human check can be recorded without relying on chat history.
`voice:focus-smoke` writes its latest result to `.cache/focus-smoke-result.json`; synthetic macOS hotkeys may be ignored, so this is a focus probe, not final acceptance evidence.
`voice:hotkey-smoke` writes its latest result to `.cache/hotkey-smoke-result.json`; it is a best-effort proxy and may fail if macOS speaker audio is not captured by the microphone.

## Repo layout

- `apps/desktop`: Electron shell for capture, status UI, and paste-back
- `apps/api`: dictation API and model-provider adapter layer
- `packages/shared`: runtime validation and prompt-building helpers
- `scripts`: clean start/stop launchers for the local desktop stack
- `docs`: product notes and architecture decisions

## Current state

- `apps/api` serves the playground on `http://127.0.0.1:8000/`.
- `apps/desktop` defaults to a hidden AI voice overlay and wakes near the mouse cursor.
- Browser `SpeechRecognition` is disabled for the desktop path; audio goes through the backend.
- The local transcription model is cached under `.cache/faster-whisper`.
