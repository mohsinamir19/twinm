# Voice setup

Voice runs entirely on the existing API (Lambda or local uvicorn). No extra server, no LiveKit.

How it works: the browser streams the mic to Deepgram (nova-3) using a ~60s token from `POST /voice/stt-token`,
sends each finished utterance through the normal `POST /chat` (with `voice: true`, so tools, memory and guard all
apply), then plays the reply sentence by sentence from `POST /voice/speak` (Deepgram Aura-2). Talking over the twin
interrupts it. Use headphones for best results.

## Env vars (`backend/.env`)

| Var | Purpose |
| --- | --- |
| `DEEPGRAM_API_KEY` | Required. STT token minting and TTS. |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Optional, only with `VOICE_TTS=gemini`. |
| `VOICE_TTS` | `deepgram` (default) or `gemini`. |
| `VOICE_TTS_MODEL` | Aura-2 voice, default `aura-2-thalia-en`. |

`GET /voice/health` reports which of these are present (booleans only).

## Run locally (two terminals)

```
cd backend && uv sync && uv run uvicorn server:app --reload
cd frontend && npm install && npm run dev
```

Open the app, go to Run My Day or My Twin, and tap the mic. `?voicemock=1` runs a fake voice loop with no mic or backend.
