"""Adaptive learning loop for the digital twin.

After every owner session, this runs a secondary Groq call that:
1. Reads the last conversation
2. Extracts facts / decisions / skills / preferences
3. Checks for contradictions with existing memory → deletes old, saves new
4. Archives entries not reinforced in 30 days (decay)
5. Saves top entries into learned_memory.json

The learned memory is injected into the system prompt by context.py.
"""

import json
import os
import uuid
from datetime import datetime, timedelta
from typing import List, Dict, Optional

from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

MEMORY_DIR = os.getenv("MEMORY_DIR", "../memory")
LEARNED_MEMORY_FILE = os.path.join(MEMORY_DIR, "learned_memory.json")
TOP_N = 20
DECAY_DAYS = 30
MAX_ENTRIES = 200


def _client() -> OpenAI:
    key = os.getenv("GROQ_API_KEY") or os.getenv("groq_api_key")
    return OpenAI(base_url="https://api.groq.com/openai/v1", api_key=key)


def _model() -> str:
    return os.getenv("MEMORY_MODEL_ID", os.getenv("MODEL_ID", "openai/gpt-oss-20b"))


def _load() -> Dict:
    os.makedirs(MEMORY_DIR, exist_ok=True)
    if not os.path.exists(LEARNED_MEMORY_FILE):
        return {"entries": [], "archived": []}
    try:
        with open(LEARNED_MEMORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if "entries" not in data:
            data["entries"] = []
        if "archived" not in data:
            data["archived"] = []
        return data
    except Exception:
        return {"entries": [], "archived": []}


def _save(data: Dict):
    os.makedirs(MEMORY_DIR, exist_ok=True)
    with open(LEARNED_MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _score(entry: Dict) -> float:
    return entry.get("confidence", 0.5) * max(entry.get("reinforcement_count", 1), 1)


def get_top_entries(n: int = TOP_N) -> List[Dict]:
    data = _load()
    active = [e for e in data["entries"] if not e.get("archived")]
    active.sort(key=_score, reverse=True)
    return active[:n]


def _apply_decay(data: Dict) -> Dict:
    cutoff = (datetime.utcnow() - timedelta(days=DECAY_DAYS)).isoformat()
    for entry in data["entries"]:
        if not entry.get("archived") and entry.get("last_reinforced", entry.get("created", "")) < cutoff:
            entry["archived"] = True
            entry["archived_reason"] = "decay"
            data["archived"].append(entry)
    data["entries"] = [e for e in data["entries"] if not e.get("archived")]
    return data


def _resolve_contradictions(data: Dict, new_entries: List[Dict]) -> List[Dict]:
    if not data["entries"] or not new_entries:
        return new_entries
    existing_summary = "\n".join(
        f"[{e['id']}] ({e['category']}) {e['content']}"
        for e in data["entries"][:50]
    )
    new_summary = "\n".join(f"({e['category']}) {e['content']}" for e in new_entries)
    prompt = f"""You are checking for contradictions between memory entries.

EXISTING MEMORY (id | category | content):
{existing_summary}

NEW ENTRIES to add:
{new_summary}

For each new entry that DIRECTLY CONTRADICTS an existing one (same topic, different conclusion),
return a JSON list of existing entry IDs to REMOVE.
If no contradictions, return an empty list [].

Respond with ONLY valid JSON: a list of strings (IDs), nothing else.
Example: ["abc123", "def456"]"""
    try:
        client = _client()
        resp = client.chat.completions.create(
            model=_model(),
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        ids_to_remove = json.loads(raw)
        if isinstance(ids_to_remove, list):
            for entry in data["entries"]:
                if entry["id"] in ids_to_remove:
                    entry["archived"] = True
                    entry["archived_reason"] = "contradicted"
                    data["archived"].append(entry)
            data["entries"] = [e for e in data["entries"] if not e.get("archived")]
    except Exception as e:
        print(f"[memory_agent] contradiction check failed (non-fatal): {e}")
    return new_entries


def _reinforce_existing(data: Dict, new_entries: List[Dict]) -> List[Dict]:
    truly_new = []
    for new_e in new_entries:
        new_words = set(new_e["content"].lower().split())
        reinforced = False
        for existing in data["entries"]:
            existing_words = set(existing["content"].lower().split())
            overlap = len(new_words & existing_words) / max(len(new_words), 1)
            if overlap > 0.6:
                existing["reinforcement_count"] = existing.get("reinforcement_count", 1) + 1
                existing["last_reinforced"] = datetime.utcnow().isoformat()
                existing["confidence"] = min(existing.get("confidence", 0.5) + 0.05, 1.0)
                reinforced = True
                break
        if not reinforced:
            truly_new.append(new_e)
    return truly_new


def extract_and_save(conversation: List[Dict], session_id: str = "") -> int:
    if not conversation:
        return 0
    recent = conversation[-20:]
    transcript = "\n".join(
        f"{m['role'].upper()}: {m['content'][:500]}"
        for m in recent
        if m.get("role") in ("user", "assistant") and m.get("content")
    )
    if not transcript.strip():
        return 0
    prompt = f"""You are a memory extraction agent for a personal AI digital twin.

Read this conversation between the owner (user) and their digital twin (assistant).
Extract ALL durable facts worth remembering about the owner.

Categories:
- "fact": stable personal info (name of a contact, location, project name)
- "skill": something they can do or are learning
- "decision": a choice they made ("decided to use Groq", "going with approach X")
- "preference": how they like things done ("prefers short replies", "wants PKT timezone")

Rules:
- Only extract things the OWNER said or revealed about themselves
- Each entry must be a single, specific, concrete statement
- Skip greetings, filler, task confirmations (those are transient)
- Confidence: 0.9 if stated clearly, 0.7 if implied

Return ONLY valid JSON — a list of objects, nothing else:
[
  {{"category": "skill", "content": "...", "confidence": 0.9}},
  ...
]
If nothing worth remembering, return [].

CONVERSATION:
{transcript}"""
    try:
        client = _client()
        resp = client.chat.completions.create(
            model=_model(),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        extracted = json.loads(raw)
        if not isinstance(extracted, list):
            return 0
    except Exception as e:
        print(f"[memory_agent] extraction failed (non-fatal): {e}")
        return 0
    if not extracted:
        return 0
    data = _load()
    data = _apply_decay(data)
    now = datetime.utcnow().isoformat()
    for entry in extracted:
        entry["id"] = uuid.uuid4().hex[:8]
        entry["created"] = now
        entry["last_reinforced"] = now
        entry["reinforcement_count"] = 1
        entry["source_session"] = session_id
    extracted = _resolve_contradictions(data, extracted)
    truly_new = _reinforce_existing(data, extracted)
    data["entries"].extend(truly_new)
    if len(data["entries"]) > MAX_ENTRIES:
        data["entries"].sort(key=_score, reverse=True)
        excess = data["entries"][MAX_ENTRIES:]
        for e in excess:
            e["archived"] = True
            e["archived_reason"] = "cap"
        data["archived"].extend(excess)
        data["entries"] = data["entries"][:MAX_ENTRIES]
    _save(data)
    print(f"[memory_agent] +{len(truly_new)} new entries, {len(data['entries'])} total active")
    return len(truly_new)


def format_for_prompt() -> str:
    entries = get_top_entries()
    if not entries:
        return ""
    lines = [f"- ({e['category']}) {e['content']}" for e in entries]
    return "## What I've learned about you:\n" + "\n".join(lines)
