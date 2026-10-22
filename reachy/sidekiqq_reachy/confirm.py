"""Strict voice confirmation for sending drafts.

A line-for-line mirror of the phone/glasses/medallion rule in
android/phone/.../assistant/DraftConfirmation.kt (ARCHITECTURE.md safety rules):

- Only one draft can be pending at a time, and only for ``window_s`` (30 s) after it was offered.
- Only an exact "send it" (after normalising case, punctuation and whitespace) confirms.
  "don't send it", "send it later", "yes" and "sure" do NOT confirm.
- Any other utterance, silence, or the window running out cancels. The draft stays unsent
  on the server. Every answer is one-shot: evaluating consumes the pending draft.

Approval itself happens only through ``POST /api/drafts/:id/approve``.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Callable, Union

ACCEPTED = frozenset({"send it"})


@dataclass(frozen=True)
class Pending:
    draft_id: str
    summary: str
    offered_at: float


@dataclass(frozen=True)
class Confirmed:
    draft_id: str


@dataclass(frozen=True)
class Declined:
    pass


@dataclass(frozen=True)
class Expired:
    pass


@dataclass(frozen=True)
class NothingPending:
    pass


Decision = Union[Confirmed, Declined, Expired, NothingPending]


def normalize(s: str) -> str:
    s = re.sub(r"[^a-z0-9' ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def is_send_it(transcript: str) -> bool:
    return normalize(transcript) in ACCEPTED


def prompt_for(summary: str) -> str:
    s = summary.strip().rstrip(".?!")
    return f"Send this: {s}? Say 'send it' to confirm, or anything else to cancel."


class DraftConfirmation:
    def __init__(self, window_s: float = 30.0, now: Callable[[], float] = time.monotonic) -> None:
        self.window_s = window_s
        self._now = now
        self.pending: Pending | None = None

    def offer(self, draft_id: str, summary: str) -> str:
        """Register a draft and return the sentence to speak."""
        self.pending = Pending(draft_id, summary, self._now())
        return prompt_for(summary)

    def evaluate(self, transcript: str) -> Decision:
        p = self.pending
        if p is None:
            return NothingPending()
        self.pending = None  # one shot: any answer consumes the pending draft
        if self._now() - p.offered_at > self.window_s:
            return Expired()
        return Confirmed(p.draft_id) if is_send_it(transcript) else Declined()

    def remaining_s(self) -> float:
        p = self.pending
        if p is None:
            return 0.0
        return max(0.0, self.window_s - (self._now() - p.offered_at))

    def clear(self) -> None:
        self.pending = None


# --------------------------------------------------------------------------- draft read-back

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_GREETING = re.compile(r"^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^,\n]*,?\s*$", re.I)


def one_sentence(body: str, max_chars: int = 160) -> str:
    """First meaningful sentence of an email body, skipping a greeting line."""
    lines = [ln.strip() for ln in (body or "").replace("\r", "").split("\n") if ln.strip()]
    while lines and _GREETING.match(lines[0]):
        lines = lines[1:]
    text = " ".join(lines)
    if not text:
        return ""
    first = _SENTENCE_END.split(text, maxsplit=1)[0].strip()
    if len(first) > max_chars:
        cut = first[: max_chars - 1].rsplit(" ", 1)[0].rstrip(",;:")
        first = cut + "…"
    return first


def _people(addresses: list[str]) -> str:
    names = []
    for a in addresses:
        m = re.match(r'^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$', a)
        names.append((m.group(1) if m else a).strip())
    if len(names) <= 2:
        return " and ".join(names)
    return f"{names[0]}, {names[1]} and {len(names) - 2} more"


def draft_summary(to: list[str], subject: str, body: str) -> str:
    """Recipient + subject + a one-sentence body summary, for the spoken read-back."""
    s = f"email to {_people(to) or 'unknown recipient'}, subject {subject.strip() or '(no subject)'}"
    gist = one_sentence(body)
    if gist:
        s += f". It says: {gist.rstrip('.?!')}"
    return s
