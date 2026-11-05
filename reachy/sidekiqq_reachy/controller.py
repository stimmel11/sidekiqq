"""Shared app state behind the settings web UI. No robot, no FastAPI: unit-testable."""

from __future__ import annotations

import threading
import time
from dataclasses import replace
from typing import Any, Callable

from .api import BrainClient, BrainError, BrainUnavailable
from .config import ConfigStore, Settings, SettingsError, apply_updates, validate_brain_url


class Controller:
    def __init__(self, store: ConfigStore, client_cls: Callable[..., BrainClient] = BrainClient) -> None:
        self.store = store
        self._client_cls = client_cls
        self._lock = threading.RLock()
        self._settings = store.load()
        self.state = "idle"
        self.last_error: str | None = None
        self.last_alert: dict[str, Any] | None = None
        self.auth_failed = False
        self.awaiting_confirm = False
        self.wake_word_status = "off"
        self.talk_requested = threading.Event()
        self.brief_requested = threading.Event()
        self.cancel_requested = threading.Event()
        self.settings_changed = threading.Event()

    # ------------------------------------------------------------------ settings

    @property
    def settings(self) -> Settings:
        with self._lock:
            return replace(self._settings)

    def update_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            s = apply_updates(replace(self._settings), updates)
            if "brain_url" in updates and s.brain_url != self._settings.brain_url:
                # A different brain means the old token and cursor are meaningless.
                s.token, s.device_id, s.alert_cursor = "", "", ""
                s.handled_commands = {}
            self.store.save(s)
            self._settings = s
        self.settings_changed.set()
        return self.status()

    def pair(self, brain_url: str, code: str, name: str = "Reachy Mini") -> dict[str, Any]:
        url = validate_brain_url(brain_url)
        code = (code or "").strip()
        if not (len(code) == 6 and code.isdigit()):
            raise SettingsError("The pairing code is 6 digits")
        client = self._client_cls(url)
        try:
            out = client.pair(code, name)
        except BrainUnavailable as e:
            raise SettingsError(f"Can't reach the brain at {url}: {e}") from None
        except BrainError as e:
            raise SettingsError(f"Pairing failed: {e.message}") from None
        with self._lock:
            s = replace(self._settings, brain_url=url, token=out["token"], device_id=out.get("deviceId", ""), alert_cursor="", handled_commands={})
            self.store.save(s)
            self._settings = s
            self.auth_failed = False
            self.last_error = None
        self.settings_changed.set()
        return self.status()

    def unpair(self) -> dict[str, Any]:
        with self._lock:
            s = replace(self._settings, token="", device_id="", alert_cursor="", handled_commands={})
            self.store.save(s)
            self._settings = s
        self.settings_changed.set()
        return self.status()

    def client(self) -> BrainClient | None:
        s = self.settings
        if not s.paired:
            return None
        return self._client_cls(s.brain_url, s.token)

    def load_cursor(self) -> str:
        return self.settings.alert_cursor

    def save_cursor(self, cursor: str) -> None:
        with self._lock:
            if cursor == self._settings.alert_cursor:
                return
            self._settings.alert_cursor = cursor
            self.store.save(self._settings)

    def load_handled_commands(self) -> dict[str, str]:
        h = self.settings.handled_commands
        return dict(h) if isinstance(h, dict) else {}

    def save_handled_commands(self, handled: dict[str, str]) -> None:
        with self._lock:
            if handled == self._settings.handled_commands:
                return
            self._settings.handled_commands = dict(handled)
            self.store.save(self._settings)

    def mark_unauthorized(self) -> None:
        self.auth_failed = True
        self.set_status("error", "The brain rejected this robot's token. Pair it again.")

    # ------------------------------------------------------------------ status / requests

    def set_status(self, state: str, error: str | None = None) -> None:
        self.state = state
        if error is not None or state == "idle":
            self.last_error = error

    def note_alert(self, alert: dict[str, Any]) -> None:
        # Importance and time only: the settings page has no login, so no names or subjects here.
        self.last_alert = {"importance": alert.get("importance"), "at": alert.get("at"), "seenAt": time.time()}

    def status(self) -> dict[str, Any]:
        s = self.settings
        return {
            "state": self.state,
            "paired": s.paired and not self.auth_failed,
            "authFailed": self.auth_failed,
            "awaitingConfirm": self.awaiting_confirm,
            "lastError": self.last_error,
            "lastAlert": self.last_alert,
            "wakeWord": self.wake_word_status,
            "settings": s.public(),
        }

    def request_talk(self) -> None:
        self.talk_requested.set()

    def request_brief(self) -> None:
        self.brief_requested.set()

    def request_cancel(self) -> None:
        self.cancel_requested.set()
