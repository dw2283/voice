# VoiceKit Beta Distribution

This is the smallest reliable way to let other people try VoiceKit without asking them to install Python, Whisper, or a local backend.

## Architecture

- Desktop app: records audio, shows the overlay, and pastes text back into the current Mac app.
- Hosted API: receives audio, validates the VoiceKit token, calls OpenAI transcription, optionally runs polish, and returns the final text.

The desktop app is not enough by itself. Testers need a reachable API route.

## Recommended Beta Setup

Use the repo's Render blueprint in [render.yaml](/Users/dingwang/Documents/voice/render.yaml).

Minimum hosted environment variables:

- `OPENAI_API_KEY`: required
- `FLOW_API_TOKENS`: required for private beta access
- `FLOW_TRANSCRIBE_PROVIDER=openai`
- `FLOW_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`
- `FLOW_POLISH_ENABLED=true`
- `FLOW_POLISH_MODEL=gpt-4.1-mini`

The blueprint already sets the model defaults for you. In practice, you mainly need to add `OPENAI_API_KEY` and at least one `FLOW_API_TOKENS` value.

## Render Steps

1. Create a new Render Web Service from this GitHub repo.
2. Let Render apply `render.yaml`.
3. Add `OPENAI_API_KEY`.
4. Add `FLOW_API_TOKENS` with one shared beta token or one token per tester.
5. Deploy and wait for the health check at `/health` to pass.
6. Copy the production URL, for example `https://voice-flow-api.onrender.com`.

## What To Send Testers

Send each tester:

- the Mac app download link
- the hosted `API Base URL`
- their `VoiceKit API Token`
- a 30-second setup note

Suggested tester note:

1. Open `VoiceKit.app`.
2. Open `Settings`.
3. Paste the `API Base URL`.
4. Paste the `VoiceKit API Token`.
5. Allow microphone access.
6. Allow Accessibility access if you want `fn` hold and automatic paste-back.

## Support Checklist

If a tester says VoiceKit is red or does nothing:

- confirm they saved the right `API Base URL`
- confirm their token matches `FLOW_API_TOKENS`
- open `<API Base URL>/health` in a browser
- check whether the desktop app says microphone access is granted
- check whether Accessibility is granted if `fn` hold is expected

## Cost and Safety Notes

- Do not put your raw OpenAI key into the desktop app.
- Use `FLOW_API_TOKENS` as service tokens instead.
- If you want to pause the beta, remove or rotate the service tokens on the hosted API.
