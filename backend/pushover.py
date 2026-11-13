"""Pushover push notifications to the owner's phone.

Needs PUSHOVER_TOKEN (your app token) and PUSHOVER_USER (your user key) in .env.
If either is missing, everything here quietly does nothing.
"""
import os
from typing import Tuple

import httpx
from dotenv import load_dotenv

load_dotenv()

API_URL = "https://api.pushover.net/1/messages.json"
TIMEOUT_SECONDS = 3  # never let a slow notification hold up the chat


def _creds() -> Tuple[str, str]:
    return os.getenv("PUSHOVER_TOKEN", ""), os.getenv("PUSHOVER_USER", "")


def enabled() -> bool:
    token, user = _creds()
    return bool(token and user)


def send(message: str, title: str = "Digital Twin", priority: int = 0, url: str = None) -> bool:
    """Send a push. Returns True if Pushover accepted it. Never raises."""
    token, user = _creds()
    if not (token and user):
        return False
    data = {
        "token": token,
        "user": user,
        "title": title[:250],
        "message": message[:1024],
        "priority": max(-1, min(int(priority), 1)),  # no emergency (2) priority
    }
    if url:
        data["url"] = url[:512]  # tap the notification to open it (e.g. the Meet link)
    try:
        r = httpx.post(API_URL, data=data, timeout=TIMEOUT_SECONDS)
        return r.status_code == 200
    except Exception as e:
        print(f"Pushover error: {type(e).__name__}: {e}")
        return False
