"""Device commands for this robot: GET /api/commands + POST /api/commands/:id/ack (ARCHITECTURE.md
"Device commands"). Reachy runs one kind, ``reachy_wake`` (activity chat / brief / dance / game),
started by the owner on another paired device ("wake Reachy to dance" on the phone or watch).

Rules (kept in step with the phone's CommandInbox in android/phone/.../handoff/HandoffPlan.kt):
- The brain's list is the source of truth for liveness. A wake runs only while the most recent
  successful GET still lists it, never by this robot's own clock against ``expiresAt``.
- Never act twice. An id is claimed (and persisted) before the robot acts, so a re-delivered
  command, a lost ack or an app restart can't repeat it. Handled ids the brain still lists get
  their ack re-sent (the same result again is a no-op on the brain).
- Unknown kinds are ignored: not acted on and not acked (the contract says clients must ignore
  kinds they don't know). An unknown ``activity`` on a reachy_wake is acked "failed" and does
  nothing.
- Busy robot: a wake that arrives mid-turn, while listening, while speaking or while a draft waits
  for "send it" is queued, and runs once the robot is idle. If it has waited more than
  ``QUEUE_MAX_S`` it is dropped and acked "dismissed" instead, so a "chat" never opens the mic
  minutes after the owner asked.
- Nothing here sends a message. A chat is an ordinary voice turn; drafts still need "send it".
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .api import BrainClient, BrainError, BrainUnavailable

log = logging.getLogger("sidekiqq_reachy.commands")

ACTIVITIES = ("chat", "brief", "dance", "game")
#: How long a wake may wait for a busy robot before it is dropped (acked "dismissed").
QUEUE_MAX_S = 120.0
#: Handled ids remembered (commands expire after 15 min and at most 20 are pending per device).
MAX_REMEMBERED = 100
#: The phone polls every 30 s; the robot polls commands at least that often.
MAX_INTERVAL_S = 30.0

CHAT_GREETING = "Hi! What can I do for you?"
GAME_COMING_SOON = "Games are coming soon. For now I can chat, read your brief, or dance."


@dataclass
class Wake:
    id: str
    activity: str
    label: str
    #: monotonic time this robot first saw it (for QUEUE_MAX_S).
    seen_at: float


@dataclass
class CommandPollResult:
    #: Wakes seen for the first time in this poll, oldest first.
    new: list[Wake] = field(default_factory=list)
    error: str | None = None
    unauthorized: bool = False


def _clean_handled(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    ok = ("opened", "dismissed", "failed")
    return {str(k): v for k, v in raw.items() if isinstance(k, str) and v in ok}


class CommandPoller:
    """Polls this device's command queue, dedupes by id and hands wakes to the voice loop.

    Thread use: ``poll()`` runs on the background poll thread, ``take()`` on the voice loop's
    main thread, ``complete()`` on an ack thread. All state is behind one lock; network calls are
    made outside it.
    """

    def __init__(
        self,
        client_factory: Callable[[], BrainClient | None],
        load_handled: Callable[[], dict[str, str]],
        save_handled: Callable[[dict[str, str]], None],
        interval_s: Callable[[], float] = lambda: MAX_INTERVAL_S,
        monotonic: Callable[[], float] = time.monotonic,
        queue_max_s: float = QUEUE_MAX_S,
    ) -> None:
        self._client_factory = client_factory
        self._save_handled = save_handled
        self._interval_s = interval_s
        self._mono = monotonic
        self._queue_max_s = queue_max_s
        self._lock = threading.Lock()
        #: id -> ack result, insertion-ordered (oldest first) for the cap. Persisted.
        self._handled: dict[str, str] = _clean_handled(load_handled())
        #: Claimed ids whose activity is still running: their ack is sent by complete(), not re-sent by poll().
        self._inflight: set[str] = set()
        #: Wakes waiting for an idle robot, oldest first.
        self._queued: dict[str, Wake] = {}
        #: Ids in the last successful GET, and when it happened.
        self._listed: set[str] = set()
        self._listed_at: float | None = None
        self._next_at = 0.0
        self.failures = 0

    # ------------------------------------------------------------------ cadence

    def interval(self) -> float:
        return min(MAX_INTERVAL_S, max(1.0, float(self._interval_s())))

    def due(self) -> bool:
        return self._mono() >= self._next_at

    def backoff_s(self) -> float:
        """Same shape as the alert poller: the interval, doubling per failure, capped at 5 min."""
        base = self.interval()
        if not self.failures:
            return base
        return min(300.0, base * (2 ** min(self.failures - 1, 3)))

    def _live_window_s(self) -> float:
        # A listing is trusted for one poll interval plus slack. The brain accepts an "opened" ack
        # up to 60 s after expiresAt, which covers a command that expired since the last GET.
        return self.interval() + 30.0

    # ------------------------------------------------------------------ poll (background thread)

    def poll(self) -> CommandPollResult:
        client = self._client_factory()
        if client is None:
            with self._lock:
                self._queued.clear()
                self._listed, self._listed_at = set(), None
            self._next_at = self._mono() + self.interval()
            return CommandPollResult(error="not paired")
        try:
            items = client.commands()
        except BrainUnavailable as e:
            self.failures += 1
            self._next_at = self._mono() + self.backoff_s()
            return CommandPollResult(error=f"brain unreachable: {e}")
        except BrainError as e:
            self.failures += 1
            self._next_at = self._mono() + self.backoff_s()
            return CommandPollResult(error=str(e), unauthorized=e.unauthorized)
        self.failures = 0
        now = self._mono()
        new: list[Wake] = []
        with self._lock:
            ids = [str(c.get("id")) for c in items if isinstance(c.get("id"), str) and c.get("id")]
            self._listed, self._listed_at = set(ids), now
            # Not listed any more: expired, or acked elsewhere. Drop it without acting.
            for qid in [q for q in self._queued if q not in self._listed]:
                del self._queued[qid]
            resend = [(i, self._handled[i]) for i in dict.fromkeys(ids) if i in self._handled and i not in self._inflight]
            for c in items:
                cid = c.get("id")
                if c.get("kind") != "reachy_wake" or not isinstance(cid, str) or not cid:
                    continue  # unknown kinds: ignore, don't ack
                if cid in self._handled or cid in self._queued:
                    continue
                activity = c.get("activity") or "chat"
                w = Wake(id=cid, activity=str(activity), label=str(c.get("label", "")), seen_at=now)
                self._queued[cid] = w
                new.append(w)
        for cid, result in resend:
            self._send_ack(client, cid, result)
        self._next_at = self._mono() + self.backoff_s()
        return CommandPollResult(new=new)

    # ------------------------------------------------------------------ take (voice loop thread)

    def take(self) -> Wake | None:
        """The oldest queued wake that may run now, already claimed (it will never be returned
        again). Call only when the robot is idle. Wakes that waited too long are dismissed here
        (their ack goes out with the next poll); wakes whose listing is stale stay queued."""
        with self._lock:
            if not self._queued:
                return None
            now = self._mono()
            changed = False
            for qid, w in list(self._queued.items()):
                if now - w.seen_at > self._queue_max_s:
                    del self._queued[qid]
                    self._remember(qid, "dismissed")
                    changed = True
                    log.info("command %s waited too long for an idle robot; dismissed", qid)
            picked: Wake | None = None
            fresh = self._listed_at is not None and now - self._listed_at <= self._live_window_s()
            if fresh:
                for qid, w in self._queued.items():
                    if qid in self._listed:
                        picked = w
                        break
            if picked is not None:
                del self._queued[picked.id]
                # "opened" = the activity was started. complete() corrects it if it couldn't be.
                self._remember(picked.id, "opened")
                self._inflight.add(picked.id)
                changed = True
            if changed:
                self._persist()
            return picked

    def pending(self) -> int:
        with self._lock:
            return len(self._queued)

    # ------------------------------------------------------------------ complete (ack thread)

    def complete(self, wake: Wake, result: str) -> bool:
        """Record the final result of a claimed wake and ack it. Returns True once the brain
        has the ack (or it is moot). A failed ack is re-sent by poll() while the brain lists it."""
        with self._lock:
            self._remember(wake.id, result)
            self._inflight.discard(wake.id)
            self._persist()
        client = self._client_factory()
        if client is None:
            return False
        return self._send_ack(client, wake.id, result)

    # ------------------------------------------------------------------ helpers

    def _remember(self, cid: str, result: str) -> None:
        self._handled.pop(cid, None)
        self._handled[cid] = result
        while len(self._handled) > MAX_REMEMBERED:
            oldest = next(iter(self._handled))
            if oldest in self._inflight:
                break
            del self._handled[oldest]

    def _persist(self) -> None:
        try:
            self._save_handled(dict(self._handled))
        except Exception:  # noqa: BLE001  (a full disk must not stop the robot; memory still dedupes)
            log.exception("could not persist handled commands")

    def _send_ack(self, client: BrainClient, cid: str, result: str) -> bool:
        try:
            client.ack_command(cid, result)
            return True
        except BrainError as e:
            if e.status in (404, 409, 410):
                # 404: not ours / gone. 409: already acked with another result. 410: "opened" after
                # expiry, informational only. Nothing more to send.
                log.info("ack %s %s: %s (not retried)", cid, result, e)
                return True
            log.warning("ack %s %s failed: %s (will retry while listed)", cid, result, e)
            return False
        except BrainUnavailable as e:
            log.warning("ack %s %s failed: %s (will retry while listed)", cid, result, e)
            return False


# ---------------------------------------------------------------------- running a wake


class WakeBody(Protocol):
    def greet(self) -> None: ...
    def dance(self) -> None: ...
    def neutral(self) -> None: ...
    def confused(self) -> None: ...


class WakeVoice(Protocol):
    def say(self, text: str) -> bool: ...
    def brief(self, kind: str = "daily") -> bool: ...


def run_wake(
    wake: Wake,
    voice: WakeVoice,
    body: WakeBody,
    request_talk: Callable[[], None],
    on_status: Callable[[str], None] = lambda s: None,
) -> str:
    """Run one claimed wake on an idle robot. Returns the ack result.

    - chat: wake-up sound + greeting, then one tap-to-talk style listen (the voice loop starts it).
    - brief: the daily brief, exactly like the Brief me button.
    - dance: a short dance, no speech, no network.
    - game: no game exists yet; says so and acks "failed".
    """
    a = wake.activity
    if a == "chat":
        body.greet()
        if not voice.say(CHAT_GREETING):
            return "failed"  # brain unreachable: don't open the mic for a turn that can't work
        request_talk()
        return "opened"
    if a == "brief":
        on_status("briefing")
        return "opened" if voice.brief("daily") else "failed"
    if a == "dance":
        on_status("dancing")
        body.dance()
        body.neutral()
        return "opened"
    if a == "game":
        if not voice.say(GAME_COMING_SOON):
            body.confused()
        body.neutral()
        return "failed"
    log.info("unknown wake activity %r: ignored", a)
    return "failed"
