# Wispr Flow-style MVP

## Product target

The first milestone is not a generic voice assistant. It is a dictation product with a very opinionated loop:

1. User triggers dictation.
2. We record a short utterance.
3. We transcribe it.
4. We clean it up into sendable text.
5. We paste it back into the focused text field.

## Experience we want to match

- low-friction capture
- polished text instead of raw transcript
- support for self-corrections like "5pm, actually 6pm"
- light formatting for messages, paragraphs, and lists
- app-aware behavior

## Architecture

### Desktop

- Electron shell for fast iteration
- renderer handles microphone capture with `MediaRecorder`
- main process handles hotkey registration, API calls, and paste-back
- macOS helpers use AppleScript for frontmost app lookup and paste simulation

### API

- provider abstraction so we can swap `mock`, OpenAI, Deepgram, or local engines
- separate transcription and polish steps
- runtime request validation
- prompt builder that encodes the "Flow" editing behavior

### Data model

- `context`: frontmost app, selected text if available, user dictionary terms
- `audioBase64`: recorded clip
- `userIntent`: free-form mode hints like "message", "email", or "notes"

## Recommended feature order

1. Record and submit audio.
2. Paste polished text back into the active app.
3. Add silence stop and partial transcript UI.
4. Add per-user dictionary and snippet expansion.
5. Add selected-text context and rewrite mode.

## Model strategy

- keep the provider pluggable
- use cloud transcription first for latency and quality
- use a separate polish step so we can tune the editing behavior independently from ASR
- treat personal dictionary and app context as first-class inputs, not an afterthought

