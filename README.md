# AI Digital Twin

One AI agent with two faces:

| | **AI Twin** (public) | **Chief of Staff** (private) |
|---|---|---|
| Who talks to it | Visitors, clients, recruiters | The owner |
| Route | `POST /chat` | `POST /owner/chat` |
| Prompt | Public prompt: polite, friendly, privacy rules, no private memory | Owner prompt: direct, executes, full context |
| Tools | `check_availability`, `book_meeting`, `save_lead` | Calendar, Tasks, Notion notes, Gmail (drafts), push notifications, day summary |
| Guardrails | Input filter, per-mode tool whitelist, rate and turn limits | Not needed (owner only) |

The route (not the browser or the model) decides the mode, the prompt and which tools exist.

## What the public Twin does
Chats about the owner's work, explores a visitor's idea, books a 30 minute Google Meet (free/busy only, the calendar is never exposed), sends a fixed-template confirmation email to the address the visitor typed, saves the lead to a Notion database and pushes a notification to the owner's phone.

## What the Chief of Staff does
Runs the day: schedule, checklist, sticky notes (Notion), inbox triage and reply drafts (Gmail, send only on explicit request), morning briefing and nudges (proactive agent), and learns the owner's preferences and style from chats.

## Stack
FastAPI + OpenAI SDK (Groq endpoint, hand-written tool loop) | Next.js frontend | Google Calendar, Meet, Tasks, Gmail | Notion | Pushover | Deepgram voice

## Run locally
```bash
# backend (Python 3.12, uv)
cd backend
cp .env.example .env        # fill in the keys
uv sync
uv run python google_auth.py   # one-time Google login
uv run uvicorn server:app --reload

# frontend (Node 20+)
cd frontend
npm install
npm run dev                 # http://localhost:3000
```

Tests: `cd backend && uv run pytest -q`

## Make it yours
- `backend/data/facts.json`, `summary.txt`, `style.txt`, `linkedin.pdf`: what the public Twin may say and how it sounds.
- `backend/data/never_share.txt`: topics it must refuse (money, family, personal life, internals).
- `backend/.env`: keys and limits (see `.env.example`). Set `OWNER_TOKEN` before exposing the backend to the internet, otherwise `/owner/*` is open.

## Deploy
Frontend: Vercel (`frontend/`, env `NEXT_PUBLIC_API_URL`). Backend: any host that runs `uvicorn server:app` with a persistent disk for `MEMORY_DIR` (or S3).

## Security notes
Secrets (`.env`, `backend/secrets/`) and conversation memory (`memory/`) are git-ignored and must never be committed.
