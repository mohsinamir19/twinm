"""Behavioral mirror — learns the owner's communication style from conversations.

Every SESSION_THRESHOLD owner sessions, re-analyzes the last N conversations
and updates style.json with an extracted style profile.
"""

import json
import os
import glob
from datetime import datetime
from typing import Dict, List, Optional

from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

MEMORY_DIR        = os.getenv("MEMORY_DIR", "../memory")
STYLE_FILE        = os.path.join(MEMORY_DIR, "style.json")
COUNTER_FILE      = os.path.join(MEMORY_DIR, "style_counter.json")
SESSION_THRESHOLD = int(os.getenv("STYLE_SESSION_THRESHOLD", "10"))
CONVERSATIONS_DIR = MEMORY_DIR


def _client() -> OpenAI:
    key = os.getenv("GROQ_API_KEY") or os.getenv("groq_api_key")
    return OpenAI(base_url="https://api.groq.com/openai/v1", api_key=key)


def _model() -> str:
    return os.getenv("MEMORY_MODEL_ID", os.getenv("MODEL_ID", "openai/gpt-oss-20b"))


def load_style() -> Dict:
    if not os.path.exists(STYLE_FILE):
        return {}
    try:
        with open(STYLE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_style(style: Dict):
    os.makedirs(MEMORY_DIR, exist_ok=True)
    with open(STYLE_FILE, "w", encoding="utf-8") as f:
        json.dump(style, f, indent=2, ensure_ascii=False)


def _load_counter() -> Dict:
    if not os.path.exists(COUNTER_FILE):
        return {"owner_sessions": 0, "last_extraction": None}
    try:
        with open(COUNTER_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"owner_sessions": 0, "last_extraction": None}


def _save_counter(counter: Dict):
    os.makedirs(MEMORY_DIR, exist_ok=True)
    with open(COUNTER_FILE, "w", encoding="utf-8") as f:
        json.dump(counter, f, indent=2)


def increment_and_maybe_extract(session_id: str = "") -> bool:
    counter = _load_counter()
    counter["owner_sessions"] = counter.get("owner_sessions", 0) + 1
    _save_counter(counter)
    if counter["owner_sessions"] % SESSION_THRESHOLD == 0:
        print(f"[style_agent] threshold reached ({counter['owner_sessions']} sessions) — extracting style")
        extract_style()
        return True
    return False


def _collect_owner_messages(limit_sessions: int = 20) -> List[str]:
    os.makedirs(MEMORY_DIR, exist_ok=True)
    files = sorted(
        glob.glob(os.path.join(CONVERSATIONS_DIR, "*.json")),
        key=os.path.getmtime, reverse=True,
    )
    conv_files = [
        f for f in files
        if not os.path.basename(f).startswith(("workspace-", "pub-", "public_"))
        and os.path.basename(f) not in ("learned_memory.json", "style.json",
                                         "style_counter.json", "proactive_log.json")
    ][:limit_sessions]
    messages = []
    for filepath in conv_files:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                conversation = json.load(f)
            if not isinstance(conversation, list):
                continue
            for msg in conversation:
                if msg.get("role") == "user" and msg.get("content"):
                    messages.append(msg["content"][:300])
        except Exception:
            continue
    return messages


def extract_style(force: bool = False) -> Optional[Dict]:
    messages = _collect_owner_messages(limit_sessions=20)
    if len(messages) < 5 and not force:
        print(f"[style_agent] not enough messages ({len(messages)}) — skipping")
        return None
    sample = "\n---\n".join(messages[:60])
    prompt = f"""You are a communication style analyst for a personal AI digital twin.

Analyze these messages written by the owner to their digital twin.
Extract their communication style as a JSON profile.

MESSAGES (each separated by ---):
{sample}

Return ONLY valid JSON with these fields:
{{
  "tone": "one line describing overall tone",
  "avg_message_length": "short|medium|long",
  "formality": "casual|semi-formal|formal",
  "signature_phrases": ["list", "of", "phrases", "they", "reuse"],
  "decision_style": "one line",
  "communication_pattern": "one line",
  "language_mix": "one line",
  "impatience_signals": ["phrases that show they want speed"],
  "trust_signals": ["phrases that show confidence"],
  "updated": "{datetime.utcnow().isoformat()}"
}}"""
    try:
        client = _client()
        resp = client.chat.completions.create(
            model=_model(),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        style = json.loads(raw)
        if not isinstance(style, dict):
            return None
        _save_style(style)
        counter = _load_counter()
        counter["last_extraction"] = datetime.utcnow().isoformat()
        _save_counter(counter)
        print(f"[style_agent] style profile updated: {style.get('tone','?')}")
        return style
    except Exception as e:
        print(f"[style_agent] extraction failed (non-fatal): {e}")
        return None


def format_for_prompt() -> str:
    style = load_style()
    if not style:
        return ""
    lines = []
    if style.get("tone"):
        lines.append(f"Tone: {style['tone']}")
    if style.get("decision_style"):
        lines.append(f"Decisions: {style['decision_style']}")
    if style.get("communication_pattern"):
        lines.append(f"Pattern: {style['communication_pattern']}")
    if style.get("signature_phrases"):
        lines.append(f"Phrases: {', '.join(style['signature_phrases'][:5])}")
    if not lines:
        return ""
    return "## Learned style:\n" + "\n".join(f"- {l}" for l in lines)


def mirror_response(question: str, context: str = "") -> Optional[str]:
    style = load_style()
    if not style:
        return None
    try:
        from memory_agent import format_for_prompt as memory_block
        mem = memory_block()
    except Exception:
        mem = ""
    system = f"""You are simulating how the owner would respond to something.
Use their exact communication style — not generic AI style.

Style profile:
{json.dumps(style, indent=2)}

{mem}

Rules:
- Write AS the owner, in first person
- Match their tone, length and vocabulary
- Don't be polite in an AI way — be real
{f'Context: {context}' if context else ''}"""
    try:
        client = _client()
        resp = client.chat.completions.create(
            model=_model(),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": question},
            ],
            temperature=0.7,
        )
        return resp.choices[0].message.content
    except Exception as e:
        print(f"[style_agent] mirror_response failed: {e}")
        return None
