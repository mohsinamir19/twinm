"""Tools for the PUBLIC AI Twin (website visitors, clients, recruiters).

Safety rules baked into code (the prompt is only a second layer):
- Calendar: visitors only ever see free slots. Event titles and details never leave this file.
- Email: the model cannot write the subject or body. It is a fixed template, sent only to the
  address the visitor typed, with per-address and per-day caps.
- Timezones and slot maths are done here in Python, never by the model.
- One booking per session. Nothing is held on the calendar until book_meeting succeeds.
"""
import os
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import google_api
import notion
import pushover
import storage

OWNER_TZ = os.getenv("TWIN_TZ", "Asia/Karachi")
OWNER_NAME = os.getenv("OWNER_NAME", "Mohsin")
WORK_START = int(os.getenv("PUBLIC_WORK_START", "10"))        # owner-local hour
WORK_END = int(os.getenv("PUBLIC_WORK_END", "18"))
WORK_DAYS = {int(d) for d in os.getenv("PUBLIC_WORK_DAYS", "0,1,2,3,4").split(",") if d.strip()}  # Mon=0
SLOT_MINUTES = 30
MIN_NOTICE_HOURS = int(os.getenv("PUBLIC_MIN_NOTICE_HOURS", "4"))
MAX_DAYS_AHEAD = 21
MAX_EMAILS_PER_DAY = int(os.getenv("PUBLIC_MAX_EMAILS_PER_DAY", "30"))
MAX_EMAILS_PER_ADDRESS = 2
MAX_LEADS_PER_SESSION = 2

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,190}\.[A-Za-z]{2,}$")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


def _now() -> datetime:
    return datetime.now(ZoneInfo(OWNER_TZ))


def _clean(value: Any, limit: int) -> str:
    return _CTRL.sub(" ", str(value or "")).strip()[:limit]


def _clean_name(value: Any) -> str:
    """Names go into an email we send, so keep only plain name characters."""
    return re.sub(r"[^A-Za-zÀ-ɏ؀-ۿ .'\-]", "", _clean(value, 60)).strip()


def _tz(name: Optional[str], fallback: str = OWNER_TZ) -> ZoneInfo:
    try:
        return ZoneInfo(name) if name else ZoneInfo(fallback)
    except Exception:
        return ZoneInfo(fallback)


def _visitor_tz(ws: Dict, override: Optional[str]) -> ZoneInfo:
    return _tz(override or (ws.get("ctx") or {}).get("tz"))


def _fmt(dt: datetime) -> str:
    return dt.strftime("%a %d %b, %I:%M %p").replace(" 0", " ")


def _parse_dt(value: str, tz: ZoneInfo) -> datetime:
    dt = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    return dt.replace(tzinfo=tz) if dt.tzinfo is None else dt


def _busy_ranges(start: datetime, end: datetime) -> List[tuple]:
    """(start, end) of busy events. Titles are dropped immediately."""
    out = []
    for e in google_api.events_between(start, end):
        if not e.get("busy"):
            continue
        if e.get("all_day"):
            s = datetime.fromisoformat(e["start"]).replace(tzinfo=ZoneInfo(OWNER_TZ))
            en = datetime.fromisoformat(e["end"]).replace(tzinfo=ZoneInfo(OWNER_TZ))
        else:
            s, en = _parse_dt(e["start"], ZoneInfo(OWNER_TZ)), _parse_dt(e["end"], ZoneInfo(OWNER_TZ))
        out.append((s, en))
    return out


def _free(start: datetime, end: datetime, busy: List[tuple]) -> bool:
    return not any(start < b_end and end > b_start for b_start, b_end in busy)


def _in_working_hours(start: datetime, end: datetime) -> bool:
    s, e = start.astimezone(ZoneInfo(OWNER_TZ)), end.astimezone(ZoneInfo(OWNER_TZ))
    return (s.weekday() in WORK_DAYS and s.date() == e.date()
            and s.hour >= WORK_START and (e.hour, e.minute) <= (WORK_END, 0))


# ------------------------------------------------------------------ tools

def check_availability(ws, date: Optional[str] = None, days: int = 3, duration_minutes: int = 30,
                       timezone: Optional[str] = None) -> Dict:
    if not google_api.enabled():
        return {"status": "error", "message": "The calendar is not connected right now."}
    vtz = _visitor_tz(ws, timezone)
    duration = max(SLOT_MINUTES, min(int(duration_minutes), 120))
    days = max(1, min(int(days), 7))
    earliest = _now() + timedelta(hours=MIN_NOTICE_HOURS)
    try:
        first_day = _parse_dt(date, vtz).astimezone(vtz).date() if date else earliest.astimezone(vtz).date()
    except Exception:
        return {"status": "error", "message": "Use a date like 2026-11-14."}
    win_start = max(earliest, datetime.combine(first_day, datetime.min.time(), vtz))
    win_end = min(win_start + timedelta(days=days), _now() + timedelta(days=MAX_DAYS_AHEAD))
    if win_start >= win_end:
        return {"status": "ok", "timezone": str(vtz), "slots": [],
                "note": "No bookable days in that range."}
    try:
        busy = _busy_ranges(win_start - timedelta(days=1), win_end + timedelta(days=1))
    except Exception as e:
        return {"status": "error", "message": f"Could not read the calendar: {type(e).__name__}"}
    slots = []
    day = (win_start.astimezone(ZoneInfo(OWNER_TZ)) - timedelta(days=1)).date()
    last = (win_end.astimezone(ZoneInfo(OWNER_TZ)) + timedelta(days=1)).date()
    while day <= last and len(slots) < 40:
        t = datetime.combine(day, datetime.min.time(), ZoneInfo(OWNER_TZ)).replace(hour=WORK_START)
        while t.hour < WORK_END and day.weekday() in WORK_DAYS and t.date() == day:
            end = t + timedelta(minutes=duration)
            if win_start <= t and end <= win_end and _in_working_hours(t, end) and _free(t, end, busy):
                slots.append({"start": t.astimezone(vtz).isoformat(timespec="minutes"),
                              "label": _fmt(t.astimezone(vtz))})
            t += timedelta(minutes=SLOT_MINUTES)
        day += timedelta(days=1)
    # spread the choices: at most 4 per visitor-local day
    picked, per_day = [], {}
    for s in slots:
        d = s["start"][:10]
        if per_day.get(d, 0) < 4:
            picked.append(s); per_day[d] = per_day.get(d, 0) + 1
    return {"status": "ok", "timezone": str(vtz), "duration_minutes": duration, "slots": picked[:12],
            "note": "Times are in the visitor's timezone. Offer only these slots." if picked
            else "Nothing free in that range. Try other days."}


def _email_budget(address: str) -> bool:
    log = storage.load_json("public_email_log", {})
    today = _now().date().isoformat()
    if log.get("date") != today:
        log = {"date": today, "total": 0, "per": {}}
    return log["total"] < MAX_EMAILS_PER_DAY and log["per"].get(address.lower(), 0) < MAX_EMAILS_PER_ADDRESS


def _email_spent(address: str) -> None:
    log = storage.load_json("public_email_log", {})
    today = _now().date().isoformat()
    if log.get("date") != today:
        log = {"date": today, "total": 0, "per": {}}
    log["total"] += 1
    log["per"][address.lower()] = log["per"].get(address.lower(), 0) + 1
    storage.save_json("public_email_log", log)


def _confirmation_email(name: str, start_v: datetime, start_o: datetime, meet_link: Optional[str]) -> tuple:
    first = name.split()[0] if name.split() else "there"
    subject = f"Confirmed: meeting with {OWNER_NAME} on {start_v.strftime('%d %b')}"
    lines = [
        f"Hi {first},", "",
        f"Your meeting with {OWNER_NAME} is confirmed.", "",
        f"When: {_fmt(start_v)} ({start_v.tzname()} / {start_v.tzinfo})",
        f"      {_fmt(start_o)} on {OWNER_NAME}'s side ({OWNER_TZ})",
    ]
    if meet_link:
        lines.append(f"Join: {meet_link}")
    lines += ["", "If you need to change the time, just reply to this email.", "",
              f"{OWNER_NAME}'s AI Twin, on behalf of {OWNER_NAME}"]
    return subject, "\n".join(lines)


def book_meeting(ws, name: str, email: str, start: str, purpose: str,
                 timezone: Optional[str] = None) -> Dict:
    if not google_api.enabled():
        return {"status": "error", "message": "The calendar is not connected right now."}
    pub = ws.setdefault("public", {})
    if pub.get("booked"):
        return {"status": "error", "message": "A meeting is already booked in this chat. "
                "To change it, the visitor can reply to the confirmation email."}
    name, email, purpose = _clean_name(name), _clean(email, 254).lower(), _clean(purpose, 300)
    if len(name) < 2:
        return {"status": "error", "message": "I need the visitor's name."}
    if not EMAIL_RE.match(email):
        return {"status": "error", "message": "That email address does not look valid. Ask the visitor to check it."}
    vtz = _visitor_tz(ws, timezone)
    try:
        start_v = _parse_dt(start, vtz)
    except Exception:
        return {"status": "error", "message": "Use an ISO start time from check_availability."}
    start_o = start_v.astimezone(ZoneInfo(OWNER_TZ))
    end_o = start_o + timedelta(minutes=SLOT_MINUTES)
    if start_o < _now() + timedelta(hours=MIN_NOTICE_HOURS) or start_o > _now() + timedelta(days=MAX_DAYS_AHEAD):
        return {"status": "error", "message": "That time is too soon or too far ahead. Offer slots from check_availability."}
    if start_o.minute % SLOT_MINUTES or not _in_working_hours(start_o, end_o):
        return {"status": "error", "message": "That time is outside bookable hours. Use check_availability."}
    if not _email_budget(email):
        return {"status": "error", "message": "I can't send more confirmations to that address right now. "
                "Please contact the owner directly."}
    try:
        if not _free(start_o, end_o, _busy_ranges(start_o - timedelta(hours=1), end_o + timedelta(hours=1))):
            return {"status": "conflict", "message": "That slot was just taken. Call check_availability again."}
        g = google_api.create_event(
            f"Meeting with {name} (AI Twin booking)", start_o, end_o,
            notes=f"Visitor: {name} <{email}>\nTopic: {purpose}\nBooked through the public AI Twin.",
            meet=True, reminder_minutes=15)
    except Exception as e:
        return {"status": "error", "message": f"Could not create the booking: {type(e).__name__}"}
    pub["booked"] = True
    warnings, email_sent = [], False
    try:
        subject, body = _confirmation_email(name, start_v.astimezone(vtz), start_o, g.get("meet_link"))
        google_api.send_email(email, subject, body)
        _email_spent(email)
        email_sent = True
    except Exception as e:
        warnings.append(f"Confirmation email failed ({type(e).__name__}). The booking itself is done.")
    try:
        if notion.leads_enabled():
            notion.create_lead(name=name, email=email, summary=purpose, status="Meeting",
                               meeting=_fmt(start_o) + f" ({OWNER_TZ})", session=(ws.get("ctx") or {}).get("session", ""))
            pub["lead_saved"] = True
    except Exception as e:
        warnings.append(f"Lead was not saved to Notion ({type(e).__name__}).")
    pushover.send(f"New booking: {name}\n{_fmt(start_o)} ({OWNER_TZ})\nTopic: {purpose[:200]}",
                  title="AI Twin: meeting booked", url=g.get("meet_link"))
    result = {"status": "ok",
              "booking": {"when_visitor": _fmt(start_v.astimezone(vtz)), "visitor_timezone": str(vtz),
                          "meet_link": g.get("meet_link"), "confirmation_email_sent": email_sent}}
    if warnings:
        result["warning"] = " ".join(warnings)
    return result


def save_lead(ws, name: str, idea_summary: str, email: Optional[str] = None,
              open_questions: Optional[List[str]] = None, budget: Optional[str] = None,
              interest: Optional[str] = None) -> Dict:
    pub = ws.setdefault("public", {})
    if pub.get("leads", 0) >= MAX_LEADS_PER_SESSION:
        return {"status": "ok", "message": "Already saved for this chat."}
    name, summary = _clean_name(name), _clean(idea_summary, 900)
    email = _clean(email, 254).lower() if email else ""
    if len(name) < 2 or len(summary) < 10:
        return {"status": "error", "message": "I need the visitor's name and a short summary of their idea."}
    if email and not EMAIL_RE.match(email):
        return {"status": "error", "message": "That email address does not look valid."}
    qs = [_clean(q, 200) for q in (open_questions or [])[:6]]
    warning = None
    try:
        if notion.leads_enabled():
            notion.create_lead(name=name, email=email, summary=summary, status="New", budget=_clean(budget, 80),
                               interest=_clean(interest, 100), open_questions=qs,
                               session=(ws.get("ctx") or {}).get("session", ""))
        else:
            warning = "Notion leads database is not configured, so the lead was only sent as a push."
    except Exception as e:
        warning = f"Lead was not saved to Notion ({type(e).__name__})."
    pub["leads"] = pub.get("leads", 0) + 1
    pushover.send(f"{name}: {summary[:300]}" + (f"\nBudget: {budget}" if budget else ""), title="AI Twin: new lead")
    out: Dict[str, Any] = {"status": "ok", "message": "Saved. The owner has been notified."}
    if warning:
        out["warning"] = warning
    return out


PUBLIC_TOOL_FUNCS = {
    "check_availability": check_availability,
    "book_meeting": book_meeting,
    "save_lead": save_lead,
}

PUBLIC_TOOL_SCHEMAS = [
    {"type": "function", "function": {
        "name": "check_availability",
        "description": "List free meeting slots (never event details). Call before offering any time. Times come back in the visitor's timezone.",
        "parameters": {"type": "object", "properties": {
            "date": {"type": "string", "description": "First day to look at, YYYY-MM-DD, in the visitor's timezone. Default: soonest possible."},
            "days": {"type": "integer", "description": "How many days to scan, 1-7. Default 3."},
            "duration_minutes": {"type": "integer", "description": "30 (default) or 60."},
            "timezone": {"type": "string", "description": "IANA name such as Europe/London. Only set if the visitor states a different timezone."},
        }}}},
    {"type": "function", "function": {
        "name": "book_meeting",
        "description": "Book the meeting, send the visitor a confirmation email, save the lead and notify the owner, all in one step. Only call after the visitor has confirmed name, email, and one slot returned by check_availability.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"}, "email": {"type": "string"},
            "start": {"type": "string", "description": "Exact 'start' value of the chosen slot from check_availability"},
            "purpose": {"type": "string", "description": "One or two sentences on what they want to discuss"},
            "timezone": {"type": "string"},
        }, "required": ["name", "email", "start", "purpose"]}}},
    {"type": "function", "function": {
        "name": "save_lead",
        "description": "Save a visitor's idea or inquiry for the owner (and push-notify them) when there is real interest but no meeting yet, or a follow-up is wanted. Do not use for spam or vendors.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"},
            "idea_summary": {"type": "string", "description": "What they want, in 2-4 sentences"},
            "email": {"type": "string"}, "budget": {"type": "string"}, "interest": {"type": "string"},
            "open_questions": {"type": "array", "items": {"type": "string"}, "description": "Things the owner should clarify"},
        }, "required": ["name", "idea_summary"]}}},
]
