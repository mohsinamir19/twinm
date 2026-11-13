"""Proactive agent — the twin messages the owner without being asked.

Runs two scheduled jobs inside FastAPI (APScheduler):
1. Morning briefing  — daily at the owner's configured time (default 08:00 PKT)
2. Nudge checker     — every 2 hours: overdue tasks, upcoming meetings

Install dependency: uv add apscheduler
"""

import json
import os
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

load_dotenv()

MEMORY_DIR   = os.getenv("MEMORY_DIR", "../memory")
LOG_FILE     = os.path.join(MEMORY_DIR, "proactive_log.json")
TZ_NAME      = os.getenv("TWIN_TZ", "Asia/Karachi")
BRIEFING_HOUR = int(os.getenv("BRIEFING_HOUR", "8"))
NUDGE_HOURS   = int(os.getenv("NUDGE_HOURS", "2"))
NUDGE_COOLDOWN_MINUTES = int(os.getenv("NUDGE_COOLDOWN_MINUTES", "240"))


def _load_log() -> dict:
    os.makedirs(MEMORY_DIR, exist_ok=True)
    if not os.path.exists(LOG_FILE):
        return {}
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_log(log: dict):
    os.makedirs(MEMORY_DIR, exist_ok=True)
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2)


def _already_ran_today(job_name: str) -> bool:
    log = _load_log()
    today = datetime.now(ZoneInfo(TZ_NAME)).date().isoformat()
    return log.get(job_name) == today


def _mark_ran_today(job_name: str):
    log = _load_log()
    today = datetime.now(ZoneInfo(TZ_NAME)).date().isoformat()
    log[job_name] = today
    _save_log(log)


def _last_pushed(item_key: str) -> Optional[str]:
    return _load_log().get(f"push_{item_key}")


def _mark_pushed(item_key: str):
    log = _load_log()
    log[f"push_{item_key}"] = datetime.utcnow().isoformat()
    _save_log(log)


def _cooldown_ok(item_key: str) -> bool:
    last = _last_pushed(item_key)
    if not last:
        return True
    try:
        elapsed = (datetime.utcnow() - datetime.fromisoformat(last)).total_seconds() / 60
        return elapsed > NUDGE_COOLDOWN_MINUTES
    except Exception:
        return True


def morning_briefing():
    if _already_ran_today("morning_briefing"):
        return
    try:
        import pushover
        import tools
        if not pushover.enabled():
            return
        ws = tools.empty_workspace()
        summary = tools.get_day_summary(ws)
        lines = ["☀️ Good morning! Here's your day:\n"]
        schedule = summary.get("schedule", [])
        if schedule:
            lines.append("📅 Schedule:")
            for ev in schedule[:5]:
                start = ev.get("start", "")[:16].replace("T", " ")
                lines.append(f"  • {start} — {ev.get('title','')}")
        else:
            lines.append("📅 No events today.")
        tasks = summary.get("tasks", [])
        open_tasks = [t for t in tasks if not t.get("done")]
        if open_tasks:
            lines.append(f"\n✅ {len(open_tasks)} open task(s):")
            for t in open_tasks[:3]:
                lines.append(f"  • {t.get('text','')}")
            if len(open_tasks) > 3:
                lines.append(f"  … +{len(open_tasks)-3} more")
        else:
            lines.append("\n✅ No open tasks.")
        today = datetime.now(ZoneInfo(TZ_NAME)).date().isoformat()
        overdue = [t for t in open_tasks if t.get("due") and t["due"][:10] < today]
        if overdue:
            lines.append(f"\n⚠️ {len(overdue)} overdue task(s)!")
            for t in overdue[:2]:
                lines.append(f"  • {t.get('text','')} (due {t.get('due','')[:10]})")
        pushover.send("\n".join(lines), title="🌅 Morning Briefing", priority=0)
        _mark_ran_today("morning_briefing")
        print("[proactive] morning briefing sent")
    except Exception as e:
        print(f"[proactive] morning_briefing error (non-fatal): {e}")


def nudge_check():
    try:
        import pushover
        import tools
        if not pushover.enabled():
            return
        ws = tools.empty_workspace()
        now_local = datetime.now(ZoneInfo(TZ_NAME))
        today = now_local.date().isoformat()
        summary = tools.get_day_summary(ws)
        for ev in summary.get("schedule", []):
            start_str = ev.get("start", "")
            if not start_str:
                continue
            try:
                start_dt = datetime.fromisoformat(start_str)
                if start_dt.tzinfo is None:
                    start_dt = start_dt.replace(tzinfo=ZoneInfo(TZ_NAME))
                mins_away = (start_dt - now_local).total_seconds() / 60
                if 0 < mins_away <= 30:
                    key = f"upcoming_{ev.get('id','')}"
                    if _cooldown_ok(key):
                        meet_link = ev.get("meet_link", "")
                        msg = f"⏰ Meeting in {int(mins_away)} min: {ev.get('title','')}"
                        if meet_link:
                            msg += "\nTap to open Meet"
                        pushover.send(msg, title="Upcoming Meeting",
                                      url=meet_link if meet_link else None)
                        _mark_pushed(key)
            except Exception:
                continue
        for t in summary.get("tasks", []):
            if t.get("done"):
                continue
            due = t.get("due", "")
            if due and due[:10] < today:
                key = f"overdue_{t.get('id','')}"
                if _cooldown_ok(key):
                    days_late = (now_local.date() - datetime.fromisoformat(due[:10]).date()).days
                    pushover.send(
                        f"📋 Overdue by {days_late}d: {t.get('text','')}",
                        title="⚠️ Overdue Task",
                    )
                    _mark_pushed(key)
    except Exception as e:
        print(f"[proactive] nudge_check error (non-fatal): {e}")


def start_scheduler(app=None):
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        scheduler = AsyncIOScheduler(timezone=TZ_NAME)
        scheduler.add_job(morning_briefing, "cron", hour=BRIEFING_HOUR, minute=0,
                          id="morning_briefing", replace_existing=True)
        scheduler.add_job(nudge_check, "interval", hours=NUDGE_HOURS,
                          id="nudge_check", replace_existing=True)
        scheduler.start()
        print(f"[proactive] scheduler started — briefing at {BRIEFING_HOUR}:00 {TZ_NAME}, nudge every {NUDGE_HOURS}h")
        return scheduler
    except ImportError:
        print("[proactive] APScheduler not installed — run: uv add apscheduler")
        return None
    except Exception as e:
        print(f"[proactive] scheduler failed to start (non-fatal): {e}")
        return None
