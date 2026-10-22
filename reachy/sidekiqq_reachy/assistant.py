"""One voice turn, independent of the robot hardware (so it is unit-tested with fakes).

Flow (mirrors android/phone/.../assistant/VoiceAssistant.kt):
    PCM -> WAV -> /api/transcribe -> (pending draft confirmation?) -> /api/ask -> speak `spoken`
    -> if the reply created a draft: read it back and wait for an exact "send it".

Nothing is ever sent without the strict confirmation in confirm.DraftConfirmation, and the
only send path is POST /api/drafts/:id/approve.
"""

from __future__ import annotations

import enum
import logging
import time
from typing import Any, Callable, Protocol

import numpy as np

from .api import AskResult, BrainClient, BrainError, BrainUnavailable
from .audio import TARGET_RATE, encode_wav
from .confirm import Confirmed, Declined, DraftConfirmation, draft_summary, prompt_for
from .speech import brief_to_speech, split_for_speech

log = logging.getLogger("sidekiqq_reachy.assistant")

MIN_UTTERANCE_S = 0.3
CONVERSATION_IDLE_S = 5 * 60

NOT_PAIRED = "I'm not paired with SideKiqq yet. Open my settings page to pair me."
TROUBLE = "Sorry, I'm having trouble reaching SideKiqq."
NOT_SENT = "Okay, not sent. The draft is saved."
DIDNT_CATCH = "Sorry, I didn't catch that."


class Body(Protocol):
    def listening(self) -> None: ...
    def thinking_start(self) -> None: ...
    def thinking_stop(self) -> None: ...
    def nod(self) -> None: ...
    def confused(self) -> None: ...
    def attention(self) -> None: ...
    def play_wav(self, wav: bytes) -> None: ...


class Outcome(enum.Enum):
    ANSWERED = "answered"
    AWAITING_CONFIRM = "awaiting_confirm"
    DRAFT_SENT = "draft_sent"
    DRAFT_NOT_SENT = "draft_not_sent"
    NOTHING_HEARD = "nothing_heard"
    NOT_PAIRED = "not_paired"
    FAILED = "failed"


class Assistant:
    def __init__(
        self,
        client_factory: Callable[[], BrainClient | None],
        body: Body,
        voice: Callable[[], str] = lambda: "alloy",
        confirmation: DraftConfirmation | None = None,
        on_unauthorized: Callable[[], None] = lambda: None,
        on_status: Callable[[str, str | None], None] = lambda state, err: None,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client_factory = client_factory
        self.body = body
        self._voice = voice
        self.confirm = confirmation or DraftConfirmation(now=now)
        self._on_unauthorized = on_unauthorized
        self._status = on_status
        self._now = now
        self._conversation: tuple[str, float] | None = None

    # ------------------------------------------------------------------ speech out

    def say(self, text: str) -> bool:
        """Speak via /api/speak. Returns False if speech couldn't be produced."""
        client = self._client_factory()
        if client is None:
            self.body.confused()
            return False
        try:
            for chunk in split_for_speech(text):
                wav = client.speak(chunk, self._voice() or None)
                self.body.thinking_stop()
                self.body.play_wav(wav)
            return True
        except (BrainError, BrainUnavailable) as e:
            log.warning("speak failed: %s", e)
            self._fail(e)
            return False

    def _fail(self, e: Exception) -> None:
        self.body.thinking_stop()
        if isinstance(e, BrainError) and e.unauthorized:
            self._on_unauthorized()
        self._status("error", str(e))
        self.body.confused()

    def _trouble(self, e: Exception) -> None:
        # If the brain is unreachable, /api/speak is too: just look confused.
        if isinstance(e, BrainUnavailable) or (isinstance(e, BrainError) and e.unauthorized):
            self._fail(e)
        else:
            self.body.thinking_stop()
            self._status("error", str(e))
            if not self.say(TROUBLE):
                self.body.confused()

    # ------------------------------------------------------------------ turns

    @property
    def awaiting_confirm(self) -> bool:
        return self.confirm.pending is not None

    def cancel_pending(self, speak: bool = True) -> bool:
        if self.confirm.pending is None:
            return False
        self.confirm.clear()
        if speak:
            self.say(NOT_SENT)
        return True

    def handle_utterance(self, pcm: np.ndarray | None) -> Outcome:
        """`pcm` is 16 kHz mono int16, or None when the endpointer heard no speech."""
        if pcm is None or pcm.size < MIN_UTTERANCE_S * TARGET_RATE:
            # Silence while a draft is waiting = cancel (the glasses/medallion rule).
            if self.cancel_pending():
                return Outcome.DRAFT_NOT_SENT
            return Outcome.NOTHING_HEARD
        client = self._client_factory()
        if client is None:
            self.confirm.clear()
            self.body.confused()
            self._status("not_paired", NOT_PAIRED)
            return Outcome.NOT_PAIRED
        self._status("thinking", None)
        self.body.thinking_start()
        try:
            text = client.transcribe(encode_wav(pcm, TARGET_RATE)).strip()
        except (BrainError, BrainUnavailable) as e:
            log.warning("transcribe failed: %s", e)
            self.confirm.clear()  # can't hear the answer: the draft stays unsent
            self._trouble(e)
            return Outcome.FAILED
        if not text:
            self.body.thinking_stop()
            if self.cancel_pending():
                return Outcome.DRAFT_NOT_SENT
            self.say(DIDNT_CATCH)
            return Outcome.NOTHING_HEARD
        return self.handle_text(text, client)

    def handle_text(self, text: str, client: BrainClient | None = None) -> Outcome:
        client = client or self._client_factory()
        if client is None:
            self.confirm.clear()
            self.body.confused()
            return Outcome.NOT_PAIRED

        # 1) A draft is waiting for confirmation: this utterance is the answer, nothing else.
        decision = self.confirm.evaluate(text)
        if isinstance(decision, Confirmed):
            try:
                client.approve_draft(decision.draft_id)
            except (BrainError, BrainUnavailable) as e:
                log.warning("approve failed: %s", e)
                self.body.thinking_stop()
                if not self.say("I couldn't send it. The draft is still saved in the app."):
                    self.body.confused()
                return Outcome.FAILED
            self.body.thinking_stop()
            self.say("Sent.")
            self.body.nod()
            return Outcome.DRAFT_SENT
        if isinstance(decision, Declined):
            self.body.thinking_stop()
            self.say(NOT_SENT)
            return Outcome.DRAFT_NOT_SENT
        # Expired / NothingPending: a normal question.

        # 2) Normal question.
        self.body.thinking_start()
        try:
            res = client.ask(text, self._conversation_id())
        except (BrainError, BrainUnavailable) as e:
            log.warning("ask failed: %s", e)
            self._trouble(e)
            return Outcome.FAILED
        self._conversation = (res.conversation_id, self._now())
        spoken = res.spoken.strip() or res.reply.strip()
        if spoken:
            self.say(spoken)
        self.body.thinking_stop()
        self.body.nod()
        self._status("idle", None)

        drafts = res.draft_actions
        if drafts:
            self._offer_draft(client, drafts[0], res)
            if len(drafts) > 1:
                log.info("%d more draft(s) only approvable in the app/watch", len(drafts) - 1)
            return Outcome.AWAITING_CONFIRM
        return Outcome.ANSWERED

    def _offer_draft(self, client: BrainClient, action: dict[str, Any], res: AskResult) -> None:
        draft_id = str(action.get("id", ""))
        summary = str(action.get("summary", "")).strip() or "a draft"
        try:
            for d in client.pending_drafts():
                if d.get("id") == draft_id:
                    summary = draft_summary(list(d.get("to") or []), str(d.get("subject", "")), str(d.get("body", "")))
                    break
        except (BrainError, BrainUnavailable) as e:
            log.info("could not fetch draft body (%s); reading recipient and subject only", e)
        # Speak first, then arm: the 30 s window starts once the question has been asked.
        self.say(prompt_for(summary))
        self.confirm.offer(draft_id, summary)
        self.body.listening()

    def brief(self, kind: str = "daily") -> bool:
        client = self._client_factory()
        if client is None:
            self.body.confused()
            return False
        self.body.thinking_start()
        try:
            b = client.brief(kind)
        except (BrainError, BrainUnavailable) as e:
            self._trouble(e)
            return False
        ok = self.say(brief_to_speech(b))
        self.body.thinking_stop()
        if ok:
            self.body.nod()
        return ok

    def _conversation_id(self) -> str | None:
        if not self._conversation:
            return None
        cid, at = self._conversation
        return cid if self._now() - at < CONVERSATION_IDLE_S else None
