"""A tiny in-process fake of the SideKiqq brain HTTP API, for client tests."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

import numpy as np

from sidekiqq_reachy.audio import encode_wav

TOKEN = "skq_test_token"


class FakeBrain:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.transcripts: list[str] = []
        self.ask_replies: list[dict[str, Any]] = []
        self.alerts: list[dict[str, Any]] = []
        self.drafts: list[dict[str, Any]] = []
        self.approved: list[str] = []
        #: Device commands for this robot (DeviceCommand dicts). Listed until acked; set
        #: "expired": True on one to stop listing it (the brain's 15-min expiry).
        self.commands: list[dict[str, Any]] = []
        #: (id, result) for every ack request that reached the handler (incl. no-ops and 409s).
        self.acks: list[tuple[str, str]] = []
        #: path prefix -> status (fails once) or (status, times)
        self.fail: dict[str, Any] = {}
        self.brief = {"kind": "daily", "generatedAt": "2026-10-21T12:00:00Z", "sections": [], "top5": []}
        brain = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _json(self, status: int, obj: Any) -> None:
                self._send(status, json.dumps(obj).encode())

            def _handle(self, method: str) -> None:
                u = urlparse(self.path)
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                rec = {"method": method, "path": u.path, "query": parse_qs(u.query), "headers": dict(self.headers), "body": raw}
                brain.requests.append(rec)
                for prefix, spec in list(brain.fail.items()):
                    if u.path.startswith(prefix):
                        status, times = spec if isinstance(spec, tuple) else (spec, 1)
                        if times <= 1:
                            del brain.fail[prefix]
                        else:
                            brain.fail[prefix] = (status, times - 1)
                        return self._json(status, {"error": "boom", "code": "x"})
                if u.path == "/api/devices/pair":
                    body = json.loads(raw)
                    if body.get("code") != "123456":
                        return self._json(401, {"error": "Invalid or expired pairing code", "code": "invalid_code"})
                    return self._json(200, {"token": TOKEN, "deviceId": "dev_1", "device": body.get("device")})
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    return self._json(401, {"error": "Invalid or revoked device token", "code": "unauthorized"})
                if u.path == "/api/transcribe":
                    return self._json(200, {"text": brain.transcripts.pop(0) if brain.transcripts else ""})
                if u.path == "/api/ask":
                    r = brain.ask_replies.pop(0) if brain.ask_replies else {"reply": "ok", "spoken": "ok"}
                    return self._json(200, {"conversationId": "c1", "actions": [], **r})
                if u.path == "/api/speak":
                    return self._send(200, encode_wav(np.zeros(2400, np.int16), 24000), "audio/wav")
                if u.path == "/api/alerts":
                    since = int((rec["query"].get("since") or ["0"])[0])
                    limit = int((rec["query"].get("limit") or ["50"])[0])
                    newer = [a for a in brain.alerts if int(a["id"]) > since]
                    page = newer[:limit]
                    more = len(newer) > len(page)
                    latest = max([int(a["id"]) for a in brain.alerts] + [since])
                    cursor = page[-1]["id"] if more else str(latest)
                    return self._json(200, {"items": page, "cursor": cursor, "more": more})
                if u.path == "/api/commands" and method == "GET":
                    live = [{k: v for k, v in c.items() if k not in ("status", "expired")} for c in brain.commands if not c.get("status") and not c.get("expired")]
                    return self._json(200, {"items": live})
                if u.path.startswith("/api/commands/") and u.path.endswith("/ack") and method == "POST":
                    cid = u.path.split("/")[3]
                    result = json.loads(raw).get("result")
                    brain.acks.append((cid, result))
                    c = next((x for x in brain.commands if x["id"] == cid), None)
                    if c is None:
                        return self._json(404, {"error": "no such command", "code": "not_found"})
                    if c.get("status") == result:
                        return self._json(200, {"ok": True})
                    if c.get("status"):
                        return self._json(409, {"error": "already acked", "code": "already_acked"})
                    c["status"] = result
                    return self._json(200, {"ok": True})
                if u.path == "/api/brief":
                    return self._json(200, brain.brief)
                if u.path == "/api/drafts" and method == "GET":
                    return self._json(200, {"items": brain.drafts})
                if u.path.startswith("/api/drafts/") and u.path.endswith("/approve") and method == "POST":
                    brain.approved.append(u.path.split("/")[3])
                    return self._json(200, {"ok": True})
                return self._json(404, {"error": "not found"})

            def do_GET(self) -> None:
                self._handle("GET")

            def do_POST(self) -> None:
                self._handle("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._t = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._t.start()

    def paths(self) -> list[str]:
        return [r["path"] for r in self.requests]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
