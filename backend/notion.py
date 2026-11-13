"""Save sticky notes to Notion (a database or a plain page).

Needs NOTION_TOKEN and NOTION_DATABASE_ID in .env, and the page/database must be
shared with your integration (••• menu -> Connections).
"""
import os
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"
TIMEOUT_SECONDS = 8

_mode: Dict[str, Any] = {}  # cached after the first lookup


def _creds():
    return os.getenv("NOTION_TOKEN", ""), os.getenv("NOTION_DATABASE_ID", "")


def enabled() -> bool:
    token, target = _creds()
    return bool(token and target)


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json"}


def _target_mode(token: str, target: str) -> Dict[str, Any]:
    """Is the ID a database (find its title column) or a plain page?"""
    if _mode.get("target") == target:
        return _mode
    r = httpx.get(f"{API}/databases/{target}", headers=_headers(token), timeout=TIMEOUT_SECONDS)
    if r.status_code == 200:
        props = r.json().get("properties", {})
        title_prop = next((n for n, p in props.items() if p.get("type") == "title"), "Name")
        _mode.clear(); _mode.update(target=target, kind="database", title_prop=title_prop)
    else:
        _mode.clear(); _mode.update(target=target, kind="page", title_prop="title")
    return _mode


def _text_block(kind: str, text: str) -> Dict[str, Any]:
    return {"object": "block", "type": kind,
            kind: {"rich_text": [{"type": "text", "text": {"content": text[:1900]}}]}}


def create_note(text: str, project: str, status: str,
                open_questions: Optional[List[str]] = None) -> Optional[str]:
    """Create a Notion page for the note. Returns its URL. Raises on failure."""
    token, target = _creds()
    mode = _target_mode(token, target)
    title = text.strip().split("\n")[0][:80] or "Note"
    parent = {"database_id": target} if mode["kind"] == "database" else {"page_id": target}
    children = [_text_block("paragraph", text),
                _text_block("paragraph", f"Project: {project}   |   Status: {status}")]
    if open_questions:
        children.append(_text_block("paragraph", "Still open:"))
        children += [_text_block("bulleted_list_item", q) for q in open_questions]
    r = httpx.post(
        f"{API}/pages", headers=_headers(token), timeout=TIMEOUT_SECONDS,
        json={"parent": parent,
              "properties": {mode["title_prop"]: {"title": [{"type": "text", "text": {"content": title}}]}},
              "children": children},
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Notion {r.status_code}: {r.text[:160]}")
    return r.json().get("url")


# ------------------------------------------------------------------ leads (public twin)
# A SEPARATE database from the private notes: NOTION_LEADS_DB_ID. Only its title column is required.
# Extra columns are filled only if they exist with these names/types: Email (email), Status (select
# or status), Budget (rich_text), Interest (rich_text), Meeting (rich_text), Session (rich_text).

def leads_enabled() -> bool:
    return bool(os.getenv("NOTION_TOKEN") and os.getenv("NOTION_LEADS_DB_ID"))


def create_lead(name: str, summary: str, email: str = "", status: str = "New", budget: str = "",
                interest: str = "", meeting: str = "", session: str = "",
                open_questions: Optional[List[str]] = None) -> Optional[str]:
    token, db = os.getenv("NOTION_TOKEN", ""), os.getenv("NOTION_LEADS_DB_ID", "")
    r = httpx.get(f"{API}/databases/{db}", headers=_headers(token), timeout=TIMEOUT_SECONDS)
    if r.status_code != 200:
        raise RuntimeError(f"Notion leads DB {r.status_code}")
    schema = r.json().get("properties", {})
    title_prop = next((n for n, p in schema.items() if p.get("type") == "title"), "Name")

    def text(v: str) -> Dict[str, Any]:
        return {"rich_text": [{"type": "text", "text": {"content": v[:1900]}}]}

    props: Dict[str, Any] = {title_prop: {"title": [{"type": "text", "text": {"content": name[:100]}}]}}
    for key, val in (("Email", email), ("Budget", budget), ("Interest", interest),
                     ("Meeting", meeting), ("Session", session)):
        t = schema.get(key, {}).get("type")
        if not val or not t:
            continue
        if key == "Email" and t == "email":
            props[key] = {"email": val}
        elif t == "rich_text":
            props[key] = text(val)
    st = schema.get("Status", {}).get("type")
    if st in ("select", "status"):
        props["Status"] = {st: {"name": status}}
    children = [_text_block("paragraph", summary)]
    if open_questions:
        children.append(_text_block("paragraph", "Open questions:"))
        children += [_text_block("bulleted_list_item", q) for q in open_questions]
    r = httpx.post(f"{API}/pages", headers=_headers(token), timeout=TIMEOUT_SECONDS,
                   json={"parent": {"database_id": db}, "properties": props, "children": children})
    if r.status_code >= 400:
        raise RuntimeError(f"Notion {r.status_code}: {r.text[:160]}")
    return r.json().get("url")
