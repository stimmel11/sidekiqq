"""Text shaping for speech: splitting long text for /api/speak, and the spoken daily brief."""

from __future__ import annotations

import re
from typing import Any

_SENTENCES = re.compile(r"(?<=[.!?])\s+")


def split_for_speech(text: str, max_chars: int = 900) -> list[str]:
    """Split text into chunks of at most ``max_chars``, preferring sentence boundaries,
    then word boundaries. /api/speak rejects anything over SPEAK_MAX_CHARS (default 1000)."""
    text = re.sub(r"\s+", " ", (text or "")).strip()
    if not text:
        return []
    chunks: list[str] = []
    cur = ""
    for sentence in _SENTENCES.split(text):
        while len(sentence) > max_chars:
            cut = sentence[:max_chars].rsplit(" ", 1)[0] or sentence[:max_chars]
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(cut)
            sentence = sentence[len(cut) :].strip()
        if not sentence:
            continue
        candidate = f"{cur} {sentence}".strip()
        if len(candidate) <= max_chars:
            cur = candidate
        else:
            chunks.append(cur)
            cur = sentence
    if cur:
        chunks.append(cur)
    return chunks


def brief_to_speech(brief: dict[str, Any], max_items_per_section: int = 3, max_chars: int = 1800) -> str:
    """Turn a Brief ({kind, sections: [{title, items}], top5: [{title, why, importance}]})
    into a short spoken script. Top priorities first; empty sections are skipped."""
    kind = str(brief.get("kind", "daily"))
    label = {"daily": "daily briefing", "eod": "end-of-day review", "weekly": "weekly review"}.get(kind, "briefing")
    parts = [f"Here's your {label}."]
    top = [t for t in (brief.get("top5") or []) if isinstance(t, dict) and t.get("title")]
    if top:
        ordinals = ["First", "Second", "Third", "Fourth", "Fifth"]
        items = [f"{ordinals[i]}, {str(t['title']).rstrip('.')}." for i, t in enumerate(top[:5])]
        parts.append("Your top priorities. " + " ".join(items))
    for section in brief.get("sections") or []:
        if not isinstance(section, dict):
            continue
        items = [str(i).strip().rstrip(".") for i in (section.get("items") or []) if str(i).strip()]
        if not items:
            continue
        title = str(section.get("title", "")).strip().rstrip(".:")
        if title.upper().startswith("TOP"):
            continue  # already covered by top5
        shown = items[:max_items_per_section]
        extra = len(items) - len(shown)
        line = f"{title.capitalize()}: " + "; ".join(shown) + "."
        if extra > 0:
            line += f" Plus {extra} more in the app."
        parts.append(line)
    out = " ".join(parts)
    if len(out) > max_chars:
        out = out[: max_chars - 30].rsplit(". ", 1)[0] + ". The rest is in the app."
    return out
