"""Cheap, deterministic guardrails that run BEFORE the LLM is called.

These are heuristics for the demo, not a complete defence. The prompt rules in
context.py and the tool whitelist in tools.py are the other two layers.
"""
import re
from typing import Optional

INJECTION_PATTERNS = [
    r"ignore (all |any |the |your )?(previous|prior|above|earlier) (instructions|prompts?|rules)",
    r"disregard .{0,30}(instructions|rules|prompt)",
    r"(reveal|show|print|repeat|leak).{0,30}(system prompt|your instructions|hidden instructions)",
    r"\byou are now\b",
    r"developer mode",
    r"\bjailbreak\b",
]

# Only enforced for anonymous visitors. The owner may of course write "password" in a note.
PRIVATE_PATTERNS = [
    r"\b(salary|how much (do|does|did) (you|he|she) (earn|make))\b",
    r"\b(password|passcode|api[ _-]?key|secret key|access token)\b",
    r"\b(home address|cnic|passport number|bank account|credit card|card number)\b",
    r"\b(cgpa|gpa|his grades|your grades|marks)\b",
    r"\b(girlfriend|boyfriend|wife|husband|married|dating|love life|relationship status)\b",
    r"\b(net worth|how much money|how rich|your income|his income|your savings)\b",
]

INJECTION_REPLY = (
    "I can't follow that request. I keep to my instructions, but I'm happy to "
    "answer questions about my work, skills and projects."
)
PRIVATE_REPLY = (
    "That one is private, so I don't share it. I can talk about my work, skills "
    "and projects instead."
)


def check_message(text: str, mode: str) -> Optional[dict]:
    """Return a block verdict dict, or None if the message is fine."""
    t = text.lower()
    for p in INJECTION_PATTERNS:
        if re.search(p, t):
            return {"rule": "R1-prompt-injection", "reply": INJECTION_REPLY}
    if mode in ("public", "visitor"):
        for p in PRIVATE_PATTERNS:
            if re.search(p, t):
                return {"rule": "R2-private-data", "reply": PRIVATE_REPLY}
    return None
