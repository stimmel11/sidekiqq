"""Alert polling with a persisted cursor (GET /api/alerts), plus backoff on errors."""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .api import AlertsPage, BrainClient, BrainError, BrainUnavailable

ATTENTION_LEVELS = ("CRITICAL", "HIGH")


def needs_attention(alert: dict[str, Any]) -> bool:
    return alert.get("importance") in ATTENTION_LEVELS


def alert_age_s(alert: dict[str, Any], now: float) -> float:
    try:
        at = datetime.fromisoformat(str(alert.get("at", "")).replace("Z", "+00:00"))
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        return now - at.timestamp()
    except ValueError:
        return 0.0


def alert_speech(alert: dict[str, Any]) -> str:
    title = str(alert.get("title", "")).strip().rstrip(".")
    body = str(alert.get("body", "")).strip()
    return f"{title}. {body}" if body else f"{title}."


@dataclass
class PollResult:
    #: Every new alert since the last cursor (oldest first).
    new: list[dict[str, Any]]
    #: The subset that should trigger the attention gesture (CRITICAL/HIGH and recent enough).
    attention: list[dict[str, Any]]
    error: str | None = None
    unauthorized: bool = False


class AlertPoller:
    """Fetches new alerts and advances the cursor. The cursor is persisted after every page,
    so a crash never replays alerts that were already handed out."""

    MAX_PAGES = 5

    def __init__(
        self,
        client_factory: Callable[[], BrainClient | None],
        load_cursor: Callable[[], str],
        save_cursor: Callable[[str], None],
        interval_s: Callable[[], float] = lambda: 60.0,
        max_age_s: Callable[[], float] = lambda: 7200.0,
        wall_clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client_factory = client_factory
        self._load_cursor = load_cursor
        self._save_cursor = save_cursor
        self._interval_s = interval_s
        self._max_age_s = max_age_s
        self._wall = wall_clock
        self._mono = monotonic
        self._next_at = 0.0
        self.failures = 0

    def due(self) -> bool:
        return self._mono() >= self._next_at

    def backoff_s(self) -> float:
        base = self._interval_s()
        if not self.failures:
            return base
        return min(300.0, base * (2 ** min(self.failures - 1, 3)))

    def poll(self) -> PollResult:
        client = self._client_factory()
        if client is None:
            self._next_at = self._mono() + self._interval_s()
            return PollResult([], [], error="not paired")
        new: list[dict[str, Any]] = []
        try:
            cursor = self._load_cursor() or None
            for _ in range(self.MAX_PAGES):
                page: AlertsPage = client.alerts(since=cursor)
                new.extend(page.items)
                if page.cursor and page.cursor != cursor:
                    cursor = page.cursor
                    self._save_cursor(cursor)
                if not page.more:
                    break
            self.failures = 0
            result = PollResult(new, self._attention(new))
        except BrainUnavailable as e:
            self.failures += 1
            result = PollResult(new, self._attention(new), error=f"brain unreachable: {e}")
        except BrainError as e:
            self.failures += 1
            result = PollResult(new, self._attention(new), error=str(e), unauthorized=e.unauthorized)
        self._next_at = self._mono() + self.backoff_s()
        return result

    def _attention(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = self._wall()
        return [a for a in items if needs_attention(a) and alert_age_s(a, now) <= self._max_age_s()]
