from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from openai import OpenAI
import os
from dotenv import load_dotenv
from typing import Optional, List, Dict, Literal
import base64
import collections
import hmac
import json
import time
import uuid
import httpx
from datetime import datetime

import storage
import tools
import guard
import pushover
import memory_agent
import style_agent
import proactive
from context import public_prompt, owner_prompt

# Load environment variables
load_dotenv()

app = FastAPI()

@app.on_event("startup")
async def startup_event():
    proactive.start_scheduler(app)
    if not OWNER_TOKEN:
        print("[server] WARNING: OWNER_TOKEN is empty, so /owner/* is open to anyone who can reach this server. "
              "Fine for local demos; set OWNER_TOKEN before deploying.")


# Configure CORS
origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Initialize OpenAI SDK client, pointed at Groq's OpenAI-compatible endpoint
groq_key = os.getenv("GROQ_API_KEY") or os.getenv("groq_api_key")
if not groq_key:
    raise RuntimeError("GROQ_API_KEY is not set. Add GROQ_API_KEY=... to backend/.env")
client = OpenAI(
    base_url="https://api.groq.com/openai/v1",
    api_key=groq_key,
)
# Previous setup (OpenRouter), kept for reference:
# client = OpenAI(
#     base_url="https://openrouter.ai/api/v1",
#     api_key=os.getenv("OPENAI_API_KEY"),
# )
# model_id = "arcee-ai/trinity-large-preview:free"

# "Run my day" needs a model with tool calling. Both Groq models below support it.
#   openai/gpt-oss-120b  -> better at multi-step tool use (default)
#   openai/gpt-oss-20b   -> faster and cheaper
model_id = os.getenv("MODEL_ID", "openai/gpt-oss-120b")

MAX_TOOL_STEPS = 5  # hard stop so the agent loop can never run away
# Optional: if set, "owner" mode (the one that can change the schedule) needs this token.
OWNER_TOKEN = os.getenv("OWNER_TOKEN", "")

USE_S3 = storage.USE_S3


# Request/Response models
class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    session_id: Optional[str] = None
    # Ignored on purpose: the ENDPOINT decides the mode (/chat = public, /owner/chat = owner).
    mode: Optional[str] = None
    owner_token: Optional[str] = None  # ignored; owners authenticate with the x-owner-token header
    # Visitor's IANA timezone (e.g. "Europe/London"), sent by the browser. All time maths happens in Python.
    timezone: Optional[str] = Field(default=None, max_length=64)
    # True when the reply will be spoken aloud (adds a short spoken-style hint to the system prompt)
    voice: bool = False

    @field_validator("session_id")
    @classmethod
    def _check_session_id(cls, v):
        if v is not None:
            storage.safe_key(v)
        return v


class ChatResponse(BaseModel):
    response: str
    session_id: str
    mode: str = "public"
    blocked: bool = False
    # Audit trail for the UI: what the twin did and why (tool calls or guardrail hits)
    actions: List[Dict] = []


class Message(BaseModel):
    role: str
    content: str
    timestamp: str


def require_owner(token: Optional[str]):
    """Routing decides the mode: the Chief of Staff page calls /owner/*, the public page calls /chat.
    OWNER_TOKEN is OPTIONAL. Leave it empty for local demos; set it before putting the backend on the internet."""
    if not OWNER_TOKEN:
        return
    if not token or not hmac.compare_digest(token.encode(), OWNER_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="Wrong or missing owner token")


# ---- abuse protection for public endpoints (in-memory: per server process) ----
PUBLIC_CHAT_PER_MIN = int(os.getenv("PUBLIC_CHAT_PER_MIN", "15"))
PUBLIC_MAX_TURNS = int(os.getenv("PUBLIC_MAX_TURNS", "20"))          # visitor messages per chat
PUBLIC_DAILY_CHAT_CAP = int(os.getenv("PUBLIC_DAILY_CHAT_CAP", "500"))  # all visitors, per day
_hits: Dict[tuple, collections.deque] = {}
_daily = {"date": "", "n": 0}


def client_ip(http: Request) -> str:
    if os.getenv("TRUST_PROXY", "").lower() == "true":  # only behind a proxy you control
        fwd = http.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return http.client.host if http.client else "unknown"


def rate_limit(http: Request, bucket: str, limit: int, window: int = 60):
    now = time.time()
    q = _hits.setdefault((bucket, client_ip(http)), collections.deque())
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(status_code=429, detail="Too many requests. Please slow down a little.")
    q.append(now)
    if len(_hits) > 5000:
        for k in [k for k, v in _hits.items() if not v or now - v[-1] > window]:
            _hits.pop(k, None)


def daily_cap():
    today = datetime.now().date().isoformat()
    if _daily["date"] != today:
        _daily.update(date=today, n=0)
    if _daily["n"] >= PUBLIC_DAILY_CHAT_CAP:
        raise HTTPException(status_code=429, detail="The twin has reached its daily limit. Please try again tomorrow.")
    _daily["n"] += 1


def _valid_tz(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(name)
        return name
    except Exception:
        return None


# Memory management functions
def load_conversation(session_id: str) -> List[Dict]:
    """Load conversation history from storage"""
    return storage.load_json(session_id, [])


def save_conversation(session_id: str, messages: List[Dict]):
    """Save conversation history to storage"""
    storage.save_json(session_id, messages)


@app.get("/")
async def root():
    return {
        "message": "AI Digital Twin API",
        "memory_enabled": True,
        "storage": "S3" if USE_S3 else "local",
        "modes": ["public", "owner"],
        "pushover": pushover.enabled(),
    }


@app.get("/health")
async def health_check():
    return {"status": "healthy", "use_s3": USE_S3}


# ---------------------------------------------------------------- voice (Deepgram STT/TTS over plain HTTPS)
# No extra server: the browser streams the mic straight to Deepgram with a short-lived token minted
# here, sends the transcript through the normal /chat pipeline (voice=True) and plays /voice/speak audio.
DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant"
DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak"
STT_TOKEN_TTL_SECONDS = 60
SPEAK_MAX_CHARS = 600
VOICE_HINT = (
    "\n\nVOICE MODE: your reply will be spoken aloud. Answer in 1 to 3 short sentences of plain spoken "
    "English with natural contractions. No markdown, lists, headings, emoji, or URLs; never read symbols "
    "or links out loud."
)


def _gemini_key() -> str:
    return os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""


def _tts_provider() -> str:
    return "gemini" if os.getenv("VOICE_TTS", "deepgram").lower() == "gemini" else "deepgram"


class SpeakRequest(BaseModel):
    text: str
    voice: Optional[str] = None


@app.get("/voice/health")
async def voice_health():
    """Which voice settings are present. Booleans/names only, never key values."""
    return {
        "deepgram": bool(os.getenv("DEEPGRAM_API_KEY")),
        "gemini": bool(_gemini_key()),
        "tts": _tts_provider(),
    }


@app.post("/voice/stt-token")
async def voice_stt_token(http: Request):
    """Mint a ~60s Deepgram access token so the browser can open the STT WebSocket without the API key."""
    rate_limit(http, "stt", 10)
    key = os.getenv("DEEPGRAM_API_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="Voice is not configured: set DEEPGRAM_API_KEY.")
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            hdrs = {"Authorization": f"Token {key}", "Content-Type": "application/json"}
            r = await http.post(DEEPGRAM_GRANT_URL, headers=hdrs,
                                json={"ttl_seconds": STT_TOKEN_TTL_SECONDS})
            if r.status_code == 400:
                print(f"[voice] grant 400 body: {r.text[:300]} -- retrying without ttl")
                r = await http.post(DEEPGRAM_GRANT_URL, headers=hdrs, content=b"{}")
            if r.status_code >= 400:
                print(f"[voice] grant {r.status_code} body: {r.text[:300]}")
        r.raise_for_status()
        data = r.json()
        token = data["access_token"]
    except Exception as e:
        print(f"[voice] deepgram grant failed: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail="Could not get a speech-to-text token from Deepgram.")
    return {"token": token, "expires_in": int(data.get("expires_in") or STT_TOKEN_TTL_SECONDS)}


def _pcm_to_wav(pcm: bytes, rate: int = 24000) -> bytes:
    import struct
    hdr = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
    return hdr + pcm


@app.post("/voice/speak")
async def voice_speak(request: SpeakRequest, http: Request):
    """Text to speech. Streams audio/mpeg (Deepgram Aura-2) or audio/wav (Gemini, VOICE_TTS=gemini)."""
    rate_limit(http, "speak", 40)
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if len(text) > SPEAK_MAX_CHARS:
        raise HTTPException(status_code=400, detail=f"text is too long (max {SPEAK_MAX_CHARS} characters)")

    if _tts_provider() == "gemini":
        gkey = _gemini_key()
        if not gkey:
            raise HTTPException(status_code=503, detail="Voice is not configured: set GEMINI_API_KEY.")
        model = os.getenv("VOICE_GEMINI_MODEL", "gemini-2.5-flash-preview-tts")
        voice = request.voice or os.getenv("VOICE_GEMINI_VOICE", "Kore")
        try:
            async with httpx.AsyncClient(timeout=30) as http:
                r = await http.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                    headers={"x-goog-api-key": gkey},
                    json={
                        "contents": [{"parts": [{"text": text}]}],
                        "generationConfig": {
                            "responseModalities": ["AUDIO"],
                            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
                        },
                    },
                )
            r.raise_for_status()
            b64 = r.json()["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
            wav = _pcm_to_wav(base64.b64decode(b64))
        except Exception as e:
            print(f"[voice] gemini tts failed: {type(e).__name__}: {e}")
            raise HTTPException(status_code=502, detail="Text-to-speech failed.")
        return Response(content=wav, media_type="audio/wav")

    key = os.getenv("DEEPGRAM_API_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="Voice is not configured: set DEEPGRAM_API_KEY.")
    model = request.voice or os.getenv("VOICE_TTS_MODEL", "aura-2-thalia-en")
    http = httpx.AsyncClient(timeout=30)
    try:
        upstream = await http.send(
            http.build_request(
                "POST", DEEPGRAM_SPEAK_URL,
                params={"model": model, "encoding": "mp3"},
                headers={"Authorization": f"Token {key}", "Content-Type": "application/json"},
                json={"text": text},
            ),
            stream=True,
        )
        if upstream.status_code >= 400:
            await upstream.aclose()
            raise RuntimeError(f"deepgram returned {upstream.status_code}")
    except Exception as e:
        await http.aclose()
        print(f"[voice] deepgram tts failed: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail="Text-to-speech failed.")

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await http.aclose()

    return StreamingResponse(body(), media_type="audio/mpeg")


def _tool_calls_to_dicts(tool_calls) -> List[Dict]:
    return [
        {
            "id": tc.id,
            "type": "function",
            "function": {"name": tc.function.name, "arguments": tc.function.arguments or "{}"},
        }
        for tc in tool_calls
    ]


async def _handle_chat(request: ChatRequest, mode: str) -> ChatResponse:
    """One pipeline for both modes. `mode` comes from the endpoint, never from the request body."""
    try:
        session_id = request.session_id or str(uuid.uuid4())
        # Public chats live in their own namespace so a visitor can never load an owner session.
        store_id = session_id if mode == "owner" else f"pub-{session_id[:90]}"

        conversation = load_conversation(store_id)
        if mode == "public" and sum(1 for m in conversation if m.get("role") == "user") >= PUBLIC_MAX_TURNS:
            contact = os.getenv("PUBLIC_CONTACT_EMAIL", "")
            reply = ("We've covered a lot in this chat! To keep going, please "
                     + (f"email {contact}" if contact else "send an email") + " and we'll continue there.")
            return ChatResponse(response=reply, session_id=session_id, mode=mode, blocked=True,
                                actions=[{"tool": "guardrail", "rule": "turn-limit", "status": "blocked"}])
        user_entry = {
            "role": "user",
            "content": request.message,
            "timestamp": datetime.now().isoformat(),
        }

        # Layer 1: deterministic guardrail BEFORE the model sees anything
        verdict = guard.check_message(request.message, mode)
        if verdict:
            actions = [{"tool": "guardrail", "rule": verdict["rule"], "status": "blocked"}]
            conversation.append(user_entry)
            conversation.append({
                "role": "assistant",
                "content": verdict["reply"],
                "timestamp": datetime.now().isoformat(),
                "actions": actions,
            })
            save_conversation(store_id, conversation)
            return ChatResponse(
                response=verdict["reply"], session_id=session_id, mode=mode,
                blocked=True, actions=actions,
            )

        # Build messages for the model
        system = owner_prompt() if mode == "owner" else public_prompt(_valid_tz(request.timezone))
        if request.voice:
            system += VOICE_HINT
        messages = [{"role": "system", "content": system}]

        # Add conversation history (keep last 10 messages for context window)
        for msg in conversation[-10:]:
            messages.append({"role": msg["role"], "content": msg["content"]})

        # Add current user message
        messages.append({"role": "user", "content": request.message})

        ws = tools.load_workspace(store_id)
        ws["ctx"] = {"tz": _valid_tz(request.timezone), "session": session_id}
        kwargs = {"tools": tools.schemas_for(mode)}  # Layer 3: each mode only sees its own whitelisted tools

        actions: List[Dict] = []
        assistant_response = ""
        tools_on = bool(kwargs)
        # Up to MAX_TOOL_STEPS rounds of tool calls, then one final call with tools
        # switched off so the model has to answer in plain text.
        for round_no in range(MAX_TOOL_STEPS + 1):
            call_kwargs = kwargs if (tools_on and round_no < MAX_TOOL_STEPS) else {}
            response = client.chat.completions.create(model=model_id, messages=messages, **call_kwargs)
            msg = response.choices[0].message

            if not (call_kwargs and msg.tool_calls):
                assistant_response = msg.content or ""
                break

            # The model asked for tools: run them, feed results back, loop
            messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": _tool_calls_to_dicts(msg.tool_calls),
            })
            for tc in msg.tool_calls:
                result = tools.run_tool(ws, tc.function.name, tc.function.arguments, mode)
                actions.append({
                    "tool": tc.function.name,
                    "args": ws["audit"][-1]["args"],
                    "status": result.get("status", "ok"),
                    "result": result,
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(result),
                })
        if not assistant_response.strip():
            assistant_response = (
                "I stopped after too many steps. Please try a simpler request."
                if actions else "Sorry, I didn't get a reply from the model. Please try again."
            )

        if ws is not None and actions:
            tools.save_workspace(store_id, ws)

        # Update conversation history
        conversation.append(user_entry)
        entry = {
            "role": "assistant",
            "content": assistant_response,
            "timestamp": datetime.now().isoformat(),
        }
        if actions:
            entry["actions"] = actions
        conversation.append(entry)

        # Save conversation
        save_conversation(store_id, conversation)

        # Post-session learning (owner mode only, runs in background — never raises)
        if mode == "owner" and len(conversation) >= 2:
            try:
                import asyncio

                def _learn(conv=list(conversation), sid=session_id):
                    try:
                        memory_agent.extract_and_save(conv, sid)
                        style_agent.increment_and_maybe_extract(sid)
                    except Exception as e2:
                        print(f"[server] post-session learning error (non-fatal): {e2}")

                # run off the request path so the reply (and voice) is not delayed
                asyncio.get_running_loop().run_in_executor(None, _learn)
            except Exception as e:
                print(f"[server] post-session learning error (non-fatal): {e}")

        return ChatResponse(
            response=assistant_response, session_id=session_id,
            mode=mode, actions=actions,
        )

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in chat endpoint: {str(e)}")
        detail = str(e)
        if "tool" in detail.lower() and "support" in detail.lower():
            detail = (f"Model '{model_id}' does not support tool calling. "
                      "Set MODEL_ID in .env to a Groq model that does (openai/gpt-oss-120b or openai/gpt-oss-20b).")
        raise HTTPException(status_code=500, detail=detail)


@app.post("/chat", response_model=ChatResponse)
async def chat_public(request: ChatRequest, http: Request):
    """Website visitors. Always public mode with public tools, whatever the body says."""
    rate_limit(http, "chat", PUBLIC_CHAT_PER_MIN)
    daily_cap()
    return await _handle_chat(request, "public")


@app.post("/owner/chat", response_model=ChatResponse)
async def chat_owner(request: ChatRequest, http: Request, x_owner_token: Optional[str] = Header(default=None)):
    """The private Chief of Staff. Needs the owner token."""
    rate_limit(http, "owner", 60)
    require_owner(x_owner_token)
    return await _handle_chat(request, "owner")


@app.get("/conversation/{session_id}")
async def get_conversation(session_id: str, x_owner_token: Optional[str] = Header(default=None)):
    """Retrieve conversation history (owner only)"""
    require_owner(x_owner_token)
    try:
        conversation = load_conversation(session_id)
        return {"session_id": session_id, "messages": conversation}
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid session id")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/workspace/{session_id}")
async def get_workspace(session_id: str, x_owner_token: Optional[str] = Header(default=None)):
    """Live data for the Schedule / Checklist / Sticky notes / Audit panels."""
    require_owner(x_owner_token)
    try:
        return {"session_id": session_id, **tools.load_workspace(session_id)}
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid session id")


@app.get("/workspace/{session_id}/summary")
async def get_workspace_summary(session_id: str, x_owner_token: Optional[str] = Header(default=None)):
    """Same 'day view' the twin gives in chat, for a dashboard card."""
    require_owner(x_owner_token)
    try:
        return tools.get_day_summary(tools.load_workspace(session_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid session id")


@app.delete("/workspace/{session_id}")
async def reset_workspace(session_id: str, x_owner_token: Optional[str] = Header(default=None)):
    """Wipe the demo data (handy right before going on stage)."""
    require_owner(x_owner_token)
    try:
        tools.reset_workspace(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid session id")
    return {"status": "reset", "session_id": session_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
