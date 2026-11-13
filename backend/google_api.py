"""Google Calendar (+ Meet links) and Google Tasks over plain REST.

Uses the token created once by google_auth.py (secrets/google_token.json).
If that file doesn't exist, enabled() is False and the twin works locally only.
No Google client library needed at runtime, just httpx.
"""
import json
import os
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_PATH = os.getenv("GOOGLE_TOKEN_PATH", os.path.join(BASE_DIR, "secrets", "google_token.json"))
CALENDAR_ID = os.getenv("GOOGLE_CALENDAR_ID", "primary")
TIMEOUT_SECONDS = 8

CAL_URL = "https://www.googleapis.com/calendar/v3"
TASKS_URL = "https://tasks.googleapis.com/tasks/v1"

_cache: Dict[str, Any] = {"token": None, "expires": 0.0}


class GoogleError(Exception):
    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


def enabled() -> bool:
    return os.path.exists(TOKEN_PATH)


def _access_token() -> str:
    if _cache["token"] and time.time() < _cache["expires"] - 60:
        return _cache["token"]
    with open(TOKEN_PATH, "r", encoding="utf-8") as f:
        t = json.load(f)
    r = httpx.post(
        t.get("token_uri", "https://oauth2.googleapis.com/token"),
        data={
            "client_id": t["client_id"],
            "client_secret": t["client_secret"],
            "refresh_token": t["refresh_token"],
            "grant_type": "refresh_token",
        },
        timeout=TIMEOUT_SECONDS,
    )
    if r.status_code != 200:
        raise GoogleError(f"token refresh failed ({r.status_code}). Run google_auth.py again.", r.status_code)
    data = r.json()
    _cache["token"] = data["access_token"]
    _cache["expires"] = time.time() + int(data.get("expires_in", 3600))
    return _cache["token"]


def _request(method: str, url: str, **kwargs) -> Dict[str, Any]:
    headers = {"Authorization": f"Bearer {_access_token()}"}
    r = httpx.request(method, url, headers=headers, timeout=TIMEOUT_SECONDS, **kwargs)
    if r.status_code >= 400:
        raise GoogleError(f"Google API {r.status_code}: {r.text[:160]}", r.status_code)
    return r.json() if r.content else {}


def _events_url() -> str:
    return f"{CAL_URL}/calendars/{quote(CALENDAR_ID, safe='')}/events"


# ------------------------------------------------------------------ calendar

def create_event(title: str, start: datetime, end: datetime, notes: str = "",
                 meet: bool = False, reminder_minutes: int = 15) -> Dict[str, Optional[str]]:
    tz = str(start.tzinfo) if start.tzinfo and hasattr(start.tzinfo, "key") else None
    body: Dict[str, Any] = {
        "summary": title,
        "description": notes,
        "start": {"dateTime": start.isoformat(), **({"timeZone": tz} if tz else {})},
        "end": {"dateTime": end.isoformat(), **({"timeZone": tz} if tz else {})},
        "reminders": {
            "useDefault": False,
            "overrides": [{"method": "popup", "minutes": max(0, int(reminder_minutes))}],
        },
    }
    params: Dict[str, Any] = {}
    if meet:
        body["conferenceData"] = {
            "createRequest": {
                "requestId": uuid.uuid4().hex,
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }
        }
        params["conferenceDataVersion"] = 1
    d = _request("POST", _events_url(), params=params, json=body)
    return {"id": d.get("id"), "link": d.get("htmlLink"), "meet_link": d.get("hangoutLink")}


def delete_event(event_id: str) -> None:
    try:
        _request("DELETE", f"{_events_url()}/{quote(event_id, safe='')}")
    except GoogleError as e:
        if e.status not in (404, 410):  # already gone is fine
            raise


def events_between(start: datetime, end: datetime) -> List[Dict[str, Any]]:
    d = _request("GET", _events_url(), params={
        "timeMin": start.isoformat(), "timeMax": end.isoformat(),
        "singleEvents": "true", "orderBy": "startTime", "maxResults": 50,
    })
    out = []
    for e in d.get("items", []):
        if e.get("status") == "cancelled":
            continue
        s, en = e.get("start", {}), e.get("end", {})
        out.append({
            "id": e.get("id"),
            "title": e.get("summary", "(no title)"),
            "start": s.get("dateTime") or s.get("date"),
            "end": en.get("dateTime") or en.get("date"),
            "all_day": "date" in s and "dateTime" not in s,
            "busy": e.get("transparency") != "transparent",
            "meet_link": e.get("hangoutLink"),
        })
    return out


# --------------------------------------------------------------------- tasks

def create_task(title: str, notes: str = "", due_date: Optional[str] = None) -> str:
    body: Dict[str, Any] = {"title": title, "notes": notes}
    if due_date:  # Google Tasks only keeps the date part
        body["due"] = f"{due_date}T00:00:00.000Z"
    return _request("POST", f"{TASKS_URL}/lists/@default/tasks", json=body)["id"]


def complete_task(task_id: str) -> None:
    _request("PATCH", f"{TASKS_URL}/lists/@default/tasks/{quote(task_id, safe='')}",
             json={"status": "completed"})


# --------------------------------------------------------------------- gmail

GMAIL_URL = "https://gmail.googleapis.com/gmail/v1/users/me"
MAX_BODY_CHARS = 3000


def _hdr(msg: Dict[str, Any], name: str) -> str:
    for h in msg.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def list_emails(query: str = "in:inbox", max_results: int = 5) -> List[Dict[str, Any]]:
    max_results = max(1, min(int(max_results), 10))
    ids = _request("GET", f"{GMAIL_URL}/messages", params={"q": query, "maxResults": max_results}).get("messages", [])
    out = []
    for m in ids:
        d = _request("GET", f"{GMAIL_URL}/messages/{m['id']}", params={
            "format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]})
        out.append({
            "id": d["id"], "thread_id": d.get("threadId"),
            "from": _hdr(d, "From"), "subject": _hdr(d, "Subject"), "date": _hdr(d, "Date"),
            "snippet": d.get("snippet", ""), "unread": "UNREAD" in d.get("labelIds", []),
        })
    return out


def _body_text(payload: Dict[str, Any]) -> str:
    import base64, re
    def dec(data: str) -> str:
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
    plain, html = [], []
    def walk(p):
        mt, data = p.get("mimeType", ""), p.get("body", {}).get("data")
        if data and mt == "text/plain":
            plain.append(dec(data))
        elif data and mt == "text/html":
            html.append(dec(data))
        for c in p.get("parts", []) or []:
            walk(c)
    walk(payload)
    if plain:
        return "\n".join(plain)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", "\n".join(html))).strip()


def read_email(message_id: str) -> Dict[str, Any]:
    d = _request("GET", f"{GMAIL_URL}/messages/{quote(message_id, safe='')}", params={"format": "full"})
    return {
        "id": d["id"], "thread_id": d.get("threadId"),
        "from": _hdr(d, "From"), "to": _hdr(d, "To"), "subject": _hdr(d, "Subject"),
        "date": _hdr(d, "Date"), "message_id": _hdr(d, "Message-ID"),
        "reply_to": _hdr(d, "Reply-To"),
        "body": _body_text(d.get("payload", {}))[:MAX_BODY_CHARS],
    }


def reply_email(message_id: str, body: str, send: bool = False) -> Dict[str, Any]:
    """Create a draft reply in the same thread (default) or send it right away."""
    import base64
    from email.message import EmailMessage
    orig = read_email(message_id)
    msg = EmailMessage()
    msg["To"] = orig["reply_to"] or orig["from"]
    subj = orig["subject"]
    msg["Subject"] = subj if subj.lower().startswith("re:") else f"Re: {subj}"
    if orig["message_id"]:
        msg["In-Reply-To"] = orig["message_id"]
        msg["References"] = orig["message_id"]
    msg.set_content(body)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    payload = {"raw": raw, "threadId": orig["thread_id"]}
    if send:
        r = _request("POST", f"{GMAIL_URL}/messages/send", json=payload)
        return {"sent": True, "id": r.get("id"), "to": msg["To"], "subject": msg["Subject"]}
    r = _request("POST", f"{GMAIL_URL}/drafts", json={"message": payload})
    return {"sent": False, "draft_id": r.get("id"), "to": msg["To"], "subject": msg["Subject"]}


def send_email(to: str, subject: str, body: str) -> str:
    """Send a plain-text email from the owner's Gmail. Callers must pass vetted values only."""
    import base64
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return _request("POST", f"{GMAIL_URL}/messages/send", json={"raw": raw}).get("id", "")
