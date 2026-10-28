"""Local settings, including the device token. Stored as JSON with 0600 permissions.

Location: ``$SIDEKIQQ_REACHY_CONFIG`` if set, else ``~/.config/sidekiqq_reachy/config.json``.
The token is never returned by the settings web UI.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

VOICES = ("alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse")


def default_path() -> Path:
    env = os.environ.get("SIDEKIQQ_REACHY_CONFIG")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".config" / "sidekiqq_reachy" / "config.json"


@dataclass
class Settings:
    brain_url: str = ""
    token: str = ""
    device_id: str = ""
    voice: str = "alloy"
    #: Speak CRITICAL/HIGH alerts aloud. Off: gesture + chime only.
    speak_alerts: bool = False
    #: Local wake word (openWakeWord). Off by default: nothing listens until "Talk" is pressed.
    wake_word_enabled: bool = False
    wake_word_model: str = "hey_jarvis"
    wake_word_threshold: float = 0.5
    alert_poll_seconds: int = 60
    #: Alerts older than this are not announced (e.g. after the robot was off overnight).
    alert_max_age_minutes: int = 120
    alert_cursor: str = ""
    #: Device commands this robot already acted on: id -> ack result ("opened"/"dismissed"/"failed").
    #: Persisted so a restart never repeats a wake the brain still lists (its ack may have been lost).
    handled_commands: dict[str, str] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def paired(self) -> bool:
        return bool(self.brain_url and self.token)

    def public(self) -> dict[str, Any]:
        """Settings safe to show in the web UI (never the token)."""
        d = asdict(self)
        d.pop("token", None)
        d.pop("extra", None)
        d.pop("handled_commands", None)
        d["paired"] = self.paired
        return d


class SettingsError(ValueError):
    pass


def validate_brain_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    p = urlparse(url)
    if p.scheme not in ("https", "http") or not p.netloc:
        raise SettingsError("Brain URL must look like https://your-brain.vercel.app")
    if p.scheme == "http" and p.hostname not in ("localhost", "127.0.0.1") and not (p.hostname or "").endswith(".local"):
        raise SettingsError("Use https:// for the brain (http is only allowed for localhost / .local)")
    if p.path not in ("", "/") or p.query or p.fragment:
        raise SettingsError("Brain URL should be just the base, without a path")
    return url


def apply_updates(s: Settings, updates: dict[str, Any]) -> Settings:
    """Validate and apply user-editable settings. Unknown or protected keys are rejected."""
    editable = {"brain_url", "voice", "speak_alerts", "wake_word_enabled", "wake_word_model", "wake_word_threshold", "alert_poll_seconds", "alert_max_age_minutes"}
    for k, v in updates.items():
        if k not in editable:
            raise SettingsError(f"'{k}' cannot be changed here")
        if k == "brain_url":
            v = validate_brain_url(str(v))
        elif k == "voice":
            if v not in VOICES:
                raise SettingsError(f"voice must be one of {', '.join(VOICES)}")
        elif k in ("speak_alerts", "wake_word_enabled"):
            if not isinstance(v, bool):
                raise SettingsError(f"{k} must be true or false")
        elif k == "wake_word_threshold":
            v = float(v)
            if not 0.05 <= v <= 0.99:
                raise SettingsError("wake_word_threshold must be between 0.05 and 0.99")
        elif k == "alert_poll_seconds":
            v = int(v)
            if not 30 <= v <= 3600:
                raise SettingsError("alert_poll_seconds must be 30-3600")
        elif k == "alert_max_age_minutes":
            v = int(v)
            if not 1 <= v <= 7 * 24 * 60:
                raise SettingsError("alert_max_age_minutes must be 1-10080")
        elif k == "wake_word_model":
            v = str(v).strip()
            if not v or len(v) > 64:
                raise SettingsError("wake_word_model must be a model name")
        setattr(s, k, v)
    return s


class ConfigStore:
    """Thread-safe load/save. Writes atomically and keeps the file at 0600."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_path()
        self._lock = threading.RLock()

    def load(self) -> Settings:
        with self._lock:
            try:
                raw = json.loads(self.path.read_text("utf-8"))
            except FileNotFoundError:
                return Settings()
            except (OSError, ValueError):
                return Settings()
            if not isinstance(raw, dict):
                return Settings()
            known = {f.name for f in fields(Settings)}
            s = Settings(**{k: v for k, v in raw.items() if k in known})
            if not isinstance(s.handled_commands, dict):
                s.handled_commands = {}
            return s

    def save(self, s: Settings) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(self.path.parent, 0o700)
            except OSError:
                pass
            fd, tmp = tempfile.mkstemp(prefix=".config-", dir=str(self.path.parent))
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(asdict(s), f, indent=2)
                os.replace(tmp, self.path)
                os.chmod(self.path, 0o600)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
