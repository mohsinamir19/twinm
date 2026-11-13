"""Offline tests: mode isolation, owner auth, public tool safety (no network, Google/LLM mocked)."""
import os
import sys
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("GROQ_API_KEY", "test")
os.environ["MEMORY_DIR"] = os.path.join(os.path.dirname(__file__), ".tmp_memory")

from fastapi.testclient import TestClient  # noqa: E402

import public_tools as pt  # noqa: E402
import server  # noqa: E402

client = TestClient(server.app)
TZ = ZoneInfo(pt.OWNER_TZ)


def _next_weekday_at(hour, minute=0, days=2):
    d = datetime.now(TZ) + timedelta(days=days)
    while d.weekday() not in pt.WORK_DAYS:
        d += timedelta(days=1)
    return d.replace(hour=hour, minute=minute, second=0, microsecond=0)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    server._hits.clear()
    server._daily.update(date="", n=0)
    monkeypatch.setattr(server, "OWNER_TOKEN", "secret-token")


def _fake_llm(monkeypatch, cap):
    def create(model, messages, **kw):
        cap["tools"] = [t["function"]["name"] for t in kw.get("tools", [])]
        cap["system"] = messages[0]["content"]
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="hi", tool_calls=None))])
    monkeypatch.setattr(server.client.chat.completions, "create", create)


# ---------------------------------------------------------------- mode isolation

def test_public_chat_ignores_mode_field_and_only_gets_public_tools(monkeypatch):
    cap = {}
    _fake_llm(monkeypatch, cap)
    r = client.post("/chat", json={"message": "hello", "mode": "owner", "owner_token": "secret-token"})
    assert r.status_code == 200 and r.json()["mode"] == "public"
    assert cap["tools"] == ["check_availability", "book_meeting", "save_lead"]
    assert "Chief of Staff" not in cap["system"]


def test_public_prompt_has_no_private_memory(monkeypatch):
    import memory_agent
    monkeypatch.setattr(memory_agent, "format_for_prompt", lambda: "## What I've learned about you:\n- SECRET-PRIVATE-FACT")
    cap = {}
    _fake_llm(monkeypatch, cap)
    client.post("/chat", json={"message": "hello"})
    assert "SECRET-PRIVATE-FACT" not in cap["system"]


def test_owner_route_is_open_when_no_token_configured(monkeypatch):
    monkeypatch.setattr(server, "OWNER_TOKEN", "")
    cap = {}
    _fake_llm(monkeypatch, cap)
    r = client.post("/owner/chat", json={"message": "x"})
    assert r.status_code == 200 and r.json()["mode"] == "owner" and "add_event" in cap["tools"]


def test_owner_endpoint_rejects_wrong_token_and_accepts_right_one(monkeypatch):
    cap = {}
    _fake_llm(monkeypatch, cap)
    assert client.post("/owner/chat", json={"message": "x"}).status_code == 401
    assert client.post("/owner/chat", json={"message": "x"}, headers={"x-owner-token": "nope"}).status_code == 401
    ok = client.post("/owner/chat", json={"message": "x"}, headers={"x-owner-token": "secret-token"})
    assert ok.status_code == 200 and ok.json()["mode"] == "owner"
    assert "add_event" in cap["tools"] and "book_meeting" not in cap["tools"]


def test_workspace_and_conversation_need_owner_token():
    assert client.get("/workspace/abc").status_code == 401
    assert client.get("/conversation/abc").status_code == 401
    assert client.get("/workspace/abc", headers={"x-owner-token": "secret-token"}).status_code == 200


def test_public_cannot_resume_an_owner_session(monkeypatch):
    cap = {}
    _fake_llm(monkeypatch, cap)
    server.save_conversation("ownersess1", [{"role": "user", "content": "OWNER-PRIVATE", "timestamp": "t"},
                                            {"role": "assistant", "content": "ok", "timestamp": "t"}])
    seen = {}
    def create(model, messages, **kw):
        seen["all"] = " ".join(m.get("content") or "" for m in messages)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="hi", tool_calls=None))])
    monkeypatch.setattr(server.client.chat.completions, "create", create)
    client.post("/chat", json={"message": "hello", "session_id": "ownersess1"})
    assert "OWNER-PRIVATE" not in seen["all"]


def test_public_turn_limit_and_rate_limit(monkeypatch):
    cap = {}
    _fake_llm(monkeypatch, cap)
    monkeypatch.setattr(server, "PUBLIC_MAX_TURNS", 2)
    sid = "turn" + uuid.uuid4().hex  # fresh per run: chats are saved to disk
    for _ in range(2):
        assert client.post("/chat", json={"message": "hi", "session_id": sid}).json()["blocked"] is False
    assert client.post("/chat", json={"message": "hi", "session_id": sid}).json()["blocked"] is True
    server._hits.clear()
    monkeypatch.setattr(server, "PUBLIC_CHAT_PER_MIN", 3)
    codes = [client.post("/chat", json={"message": "hi", "session_id": f"rl{uuid.uuid4().hex}"}).status_code for i in range(5)]
    assert codes[:3] == [200, 200, 200] and 429 in codes[3:]


# ---------------------------------------------------------------- public tools

class FakeGoogle:
    def __init__(self, busy=None):
        self.busy, self.sent, self.created = busy or [], [], []
    def install(self, monkeypatch):
        monkeypatch.setattr(pt.google_api, "enabled", lambda: True)
        monkeypatch.setattr(pt.google_api, "events_between", lambda s, e: self.busy)
        monkeypatch.setattr(pt.google_api, "create_event",
                            lambda *a, **k: self.created.append((a, k)) or {"id": "e1", "meet_link": "https://meet.google.com/abc"})
        monkeypatch.setattr(pt.google_api, "send_email", lambda to, subj, body: self.sent.append((to, subj, body)) or "m1")
        monkeypatch.setattr(pt.notion, "leads_enabled", lambda: False)
        monkeypatch.setattr(pt.pushover, "send", lambda *a, **k: True)
        monkeypatch.setattr(pt.storage, "load_json", lambda k, d: {})
        monkeypatch.setattr(pt.storage, "save_json", lambda k, v: None)


def test_availability_never_leaks_event_titles(monkeypatch):
    slot = _next_weekday_at(11)
    g = FakeGoogle(busy=[{"id": "x", "title": "Dentist with Sana", "busy": True, "all_day": False,
                          "start": slot.isoformat(), "end": (slot + timedelta(hours=1)).isoformat()}])
    g.install(monkeypatch)
    r = pt.check_availability({"ctx": {"tz": "Europe/London"}}, date=slot.date().isoformat(), days=1)
    assert r["status"] == "ok" and r["slots"]
    assert "Dentist" not in str(r) and "Sana" not in str(r)
    busy_starts = {slot.astimezone(ZoneInfo("Europe/London")).isoformat(timespec="minutes")}
    assert not busy_starts & {s["start"] for s in r["slots"]}


def test_booking_happy_path_uses_fixed_template_and_blocks_second_booking(monkeypatch):
    g = FakeGoogle(); g.install(monkeypatch)
    ws = {"audit": [], "ctx": {"tz": "Europe/London", "session": "s1"}}
    start = _next_weekday_at(12).astimezone(ZoneInfo("Europe/London")).isoformat(timespec="minutes")
    r = pt.book_meeting(ws, "Ali Khan", "ali@example.com", start, "AI receptionist idea")
    assert r["status"] == "ok" and r["booking"]["confirmation_email_sent"] is True
    to, subject, body = g.sent[0]
    assert to == "ali@example.com" and "Confirmed" in subject and "AI receptionist idea" not in body
    again = pt.book_meeting(ws, "Ali Khan", "ali@example.com", start, "again")
    assert again["status"] == "error" and len(g.sent) == 1


@pytest.mark.parametrize("email", ["not-an-email", "a@b", "x@y.com\nBcc: evil@z.com", ""])
def test_booking_rejects_bad_email(monkeypatch, email):
    FakeGoogle().install(monkeypatch)
    ws = {"audit": [], "ctx": {}}
    start = _next_weekday_at(12).isoformat(timespec="minutes")
    assert pt.book_meeting(ws, "Ali", email, start, "x")["status"] == "error"


def test_booking_rejects_outside_hours_past_and_conflict(monkeypatch):
    g = FakeGoogle(); g.install(monkeypatch)
    ws = lambda: {"audit": [], "ctx": {}}
    assert pt.book_meeting(ws(), "Ali", "a@b.com", _next_weekday_at(3).isoformat(timespec="minutes"), "x")["status"] == "error"
    past = (datetime.now(TZ) - timedelta(days=1)).isoformat(timespec="minutes")
    assert pt.book_meeting(ws(), "Ali", "a@b.com", past, "x")["status"] == "error"
    slot = _next_weekday_at(14)
    g.busy = [{"id": "x", "title": "t", "busy": True, "all_day": False, "start": slot.isoformat(),
               "end": (slot + timedelta(minutes=30)).isoformat()}]
    assert pt.book_meeting(ws(), "Ali", "a@b.com", slot.isoformat(timespec="minutes"), "x")["status"] == "conflict"
    assert not g.sent and not g.created


def test_public_registry_has_no_owner_tools():
    import tools
    r = tools.run_tool({"audit": []}, "list_emails", "{}", mode="public")
    assert r["status"] == "error" and "unknown tool" in r["message"]
    assert tools.run_tool({"audit": []}, "book_meeting", "{}", mode="owner")["status"] == "error"
