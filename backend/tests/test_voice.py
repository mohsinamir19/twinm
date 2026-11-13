"""Offline tests for the voice endpoints (httpx and the LLM client are mocked; no network)."""
import os
import sys
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("GROQ_API_KEY", "test")
os.environ["MEMORY_DIR"] = os.path.join(os.path.dirname(__file__), ".tmp_memory")

from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402

client = TestClient(server.app)
_RealAsyncClient = httpx.AsyncClient


def mock_deepgram(monkeypatch, handler):
    """Route every httpx.AsyncClient used by server.py through a MockTransport."""
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **kw: _RealAsyncClient(transport=transport, **kw))


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg-test")
    monkeypatch.delenv("VOICE_TTS", raising=False)


def test_health_booleans(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    assert client.get("/voice/health").json() == {"deepgram": True, "gemini": False, "tts": "deepgram"}


def test_stt_token_ok(monkeypatch):
    seen = {}

    def handler(req):
        seen["auth"] = req.headers["authorization"]
        seen["url"] = str(req.url)
        return httpx.Response(200, json={"access_token": "tok123", "expires_in": 60})

    mock_deepgram(monkeypatch, handler)
    r = client.post("/voice/stt-token")
    assert r.status_code == 200
    assert r.json() == {"token": "tok123", "expires_in": 60}
    assert seen["auth"] == "Token dg-test"
    assert seen["url"].endswith("/v1/auth/grant")


def test_stt_token_upstream_failure(monkeypatch):
    mock_deepgram(monkeypatch, lambda req: httpx.Response(403, json={"err": "no"}))
    assert client.post("/voice/stt-token").status_code == 502


def test_stt_token_missing_key(monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY")
    assert client.post("/voice/stt-token").status_code == 503


def test_speak_streams_audio(monkeypatch):
    seen = {}

    def handler(req):
        seen["url"] = str(req.url)
        seen["body"] = req.content
        return httpx.Response(200, content=b"ID3fakemp3bytes")

    mock_deepgram(monkeypatch, handler)
    r = client.post("/voice/speak", json={"text": "Hello there."})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/mpeg")
    assert r.content == b"ID3fakemp3bytes"
    assert "model=aura-2-thalia-en" in seen["url"] and "encoding=mp3" in seen["url"]
    assert b"Hello there." in seen["body"]


def test_speak_rejects_bad_text():
    assert client.post("/voice/speak", json={"text": "   "}).status_code == 400
    assert client.post("/voice/speak", json={"text": "x" * 601}).status_code == 400


def test_speak_missing_key(monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY")
    assert client.post("/voice/speak", json={"text": "hi"}).status_code == 503


def test_speak_upstream_error(monkeypatch):
    mock_deepgram(monkeypatch, lambda req: httpx.Response(500))
    assert client.post("/voice/speak", json={"text": "hi"}).status_code == 502


def test_speak_gemini_wraps_wav(monkeypatch):
    import base64
    monkeypatch.setenv("VOICE_TTS", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "g-test")
    pcm = b"\x00\x01" * 10
    payload = {"candidates": [{"content": {"parts": [{"inlineData": {"data": base64.b64encode(pcm).decode()}}]}}]}
    mock_deepgram(monkeypatch, lambda req: httpx.Response(200, json=payload))
    r = client.post("/voice/speak", json={"text": "hi"})
    assert r.status_code == 200 and r.content.startswith(b"RIFF") and r.content.endswith(pcm)


def _fake_llm(monkeypatch, captured):
    def create(model, messages, **kw):
        captured["system"] = messages[0]["content"]
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="ok", tool_calls=None))])

    monkeypatch.setattr(server.client.chat.completions, "create", create)
    monkeypatch.setattr(server, "load_conversation", lambda sid: [])
    monkeypatch.setattr(server, "save_conversation", lambda sid, m: None)


def test_chat_voice_adds_hint_only_when_true(monkeypatch):
    cap = {}
    _fake_llm(monkeypatch, cap)
    assert client.post("/chat", json={"message": "what do you do", "voice": True}).status_code == 200
    voiced = cap["system"]
    assert voiced.endswith(server.VOICE_HINT)
    assert client.post("/chat", json={"message": "what do you do"}).status_code == 200
    assert cap["system"] == voiced[: -len(server.VOICE_HINT)]
    assert "VOICE MODE" not in cap["system"]
