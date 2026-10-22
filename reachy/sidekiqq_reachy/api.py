"""Minimal SideKiqq brain client (stdlib only).

Endpoints used (ARCHITECTURE.md): /api/devices/pair, /api/transcribe, /api/ask, /api/speak,
/api/alerts, /api/brief, /api/drafts (GET, read-only) and /api/drafts/:id/approve.

Only GETs are retried. /api/ask is never retried (it may create a draft), and approve is
never retried automatically (the user said "send it" once).
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

USER_AGENT = "sidekiqq-reachy/0.1"


class BrainError(Exception):
    """The brain answered with an error status."""

    def __init__(self, status: int, message: str, code: str | None = None) -> None:
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message
        self.code = code

    @property
    def unauthorized(self) -> bool:
        return self.status == 401


class BrainUnavailable(Exception):
    """Network problem: DNS, refused, TLS, timeout."""


@dataclass
class AskResult:
    reply: str
    spoken: str
    conversation_id: str
    actions: list[dict[str, Any]] = field(default_factory=list)

    @property
    def draft_actions(self) -> list[dict[str, Any]]:
        return [a for a in self.actions if a.get("type") == "draft_created"]


@dataclass
class AlertsPage:
    items: list[dict[str, Any]]
    cursor: str
    more: bool


class BrainClient:
    def __init__(self, base_url: str, token: str = "", timeout: float = 30.0, ask_timeout: float = 95.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.ask_timeout = ask_timeout

    # ------------------------------------------------------------------ transport

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str | None = None,
        auth: bool = True,
        timeout: float | None = None,
        retries: int = 0,
    ) -> tuple[int, dict[str, str], bytes]:
        url = self.base_url + path
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json, audio/wav"}
        if content_type:
            headers["Content-Type"] = content_type
        if auth:
            if not self.token:
                raise BrainError(401, "not paired", "unauthorized")
            headers["Authorization"] = f"Bearer {self.token}"
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=body, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout or self.timeout) as res:
                    return res.status, {k.lower(): v for k, v in res.headers.items()}, res.read()
            except urllib.error.HTTPError as e:
                raw = e.read() if hasattr(e, "read") else b""
                msg, code = e.reason if isinstance(e.reason, str) else "error", None
                try:
                    j = json.loads(raw or b"{}")
                    msg = j.get("error") or msg
                    code = j.get("code")
                except ValueError:
                    pass
                if e.code >= 500 and attempt < retries:
                    attempt += 1
                    time.sleep(0.5 * attempt)
                    continue
                raise BrainError(e.code, str(msg), code) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                if attempt < retries:
                    attempt += 1
                    time.sleep(0.5 * attempt)
                    continue
                raise BrainUnavailable(str(getattr(e, "reason", e))) from None

    def _json(self, method: str, path: str, payload: Any = None, **kw: Any) -> Any:
        body = json.dumps(payload).encode() if payload is not None else None
        _, _, raw = self._request(method, path, body=body, content_type="application/json" if body is not None else None, **kw)
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            raise BrainError(502, "brain returned invalid JSON") from None

    # ------------------------------------------------------------------ endpoints

    def pair(self, code: str, name: str = "Reachy Mini") -> dict[str, str]:
        """Exchange a one-time code (from the owner) for a device token. Sets self.token."""
        out = self._json("POST", "/api/devices/pair", {"code": code.strip(), "device": "reachy", "name": name}, auth=False)
        token = out.get("token")
        if not isinstance(token, str) or not token:
            raise BrainError(502, "pairing response had no token")
        self.token = token
        return {"token": token, "deviceId": str(out.get("deviceId", "")), "device": str(out.get("device", ""))}

    def transcribe(self, wav: bytes) -> str:
        _, _, raw = self._request("POST", "/api/transcribe", body=wav, content_type="audio/wav", timeout=60)
        try:
            text = json.loads(raw).get("text", "")
        except ValueError:
            raise BrainError(502, "brain returned invalid JSON") from None
        return text.strip() if isinstance(text, str) else ""

    def ask(self, text: str, conversation_id: str | None = None) -> AskResult:
        payload: dict[str, Any] = {"text": text, "device": "reachy"}
        if conversation_id:
            payload["conversationId"] = conversation_id
        j = self._json("POST", "/api/ask", payload, timeout=self.ask_timeout)
        return AskResult(
            reply=str(j.get("reply", "")),
            spoken=str(j.get("spoken", "")),
            conversation_id=str(j.get("conversationId", "")),
            actions=list(j.get("actions") or []),
        )

    def speak(self, text: str, voice: str | None = None) -> bytes:
        payload: dict[str, Any] = {"text": text}
        if voice:
            payload["voice"] = voice
        _, headers, raw = self._request("POST", "/api/speak", body=json.dumps(payload).encode(), content_type="application/json", timeout=45)
        if not headers.get("content-type", "").startswith("audio/wav") or raw[:4] != b"RIFF":
            raise BrainError(502, "speak did not return a WAV")
        return raw

    def alerts(self, since: str | None = None, limit: int = 50) -> AlertsPage:
        q = {"limit": str(limit)}
        if since:
            q["since"] = since
        j = self._json("GET", "/api/alerts?" + urllib.parse.urlencode(q), retries=1)
        return AlertsPage(items=list(j.get("items") or []), cursor=str(j.get("cursor", since or "")), more=bool(j.get("more")))

    def brief(self, kind: str = "daily") -> dict[str, Any]:
        return self._json("GET", f"/api/brief?kind={urllib.parse.quote(kind)}", retries=1, timeout=60)

    def pending_drafts(self) -> list[dict[str, Any]]:
        return list(self._json("GET", "/api/drafts", retries=1).get("items") or [])

    def approve_draft(self, draft_id: str) -> None:
        """The ONLY send path. Call only after the strict "send it" confirmation."""
        self._json("POST", f"/api/drafts/{urllib.parse.quote(draft_id, safe='')}/approve")
