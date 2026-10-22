import json
import socket

import numpy as np
import pytest

from fakebrain import TOKEN
from sidekiqq_reachy.api import BrainClient, BrainError, BrainUnavailable
from sidekiqq_reachy.audio import decode_wav, encode_wav


def test_pair_sends_device_reachy_and_stores_token(brain):
    c = BrainClient(brain.url)
    out = c.pair(" 123456 ")
    assert out == {"token": TOKEN, "deviceId": "dev_1", "device": "reachy"}
    assert c.token == TOKEN
    req = brain.requests[-1]
    assert json.loads(req["body"]) == {"code": "123456", "device": "reachy", "name": "Reachy Mini"}
    assert "Authorization" not in req["headers"]


def test_pair_bad_code(brain):
    with pytest.raises(BrainError) as e:
        BrainClient(brain.url).pair("000000")
    assert e.value.status == 401 and e.value.code == "invalid_code"


def test_transcribe_posts_wav_with_bearer(brain):
    brain.transcripts = ["  what's on today  "]
    c = BrainClient(brain.url, TOKEN)
    wav = encode_wav(np.zeros(16000, np.int16))
    assert c.transcribe(wav) == "what's on today"
    req = brain.requests[-1]
    assert req["headers"]["Content-Type"] == "audio/wav"
    assert req["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert req["body"] == wav


def test_ask_uses_device_reachy_and_conversation(brain):
    brain.ask_replies = [{"reply": "Long", "spoken": "Short", "actions": [{"type": "draft_created", "id": "d1", "summary": "Draft to x: y"}]}]
    res = BrainClient(brain.url, TOKEN).ask("hi", "conv-1")
    assert json.loads(brain.requests[-1]["body"]) == {"text": "hi", "device": "reachy", "conversationId": "conv-1"}
    assert res.spoken == "Short" and res.draft_actions[0]["id"] == "d1"


def test_speak_returns_wav(brain):
    wav = BrainClient(brain.url, TOKEN).speak("hello", "nova")
    assert decode_wav(wav).sample_rate == 24000
    assert json.loads(brain.requests[-1]["body"]) == {"text": "hello", "voice": "nova"}


def test_alerts_cursor(brain):
    brain.alerts = [{"id": "1", "title": "a"}, {"id": "2", "title": "b"}]
    c = BrainClient(brain.url, TOKEN)
    p = c.alerts()
    assert [a["id"] for a in p.items] == ["1", "2"] and p.cursor == "2" and not p.more
    assert "since" not in brain.requests[-1]["query"]
    p2 = c.alerts(since="2")
    assert p2.items == [] and p2.cursor == "2"
    assert brain.requests[-1]["query"]["since"] == ["2"]


def test_unauthorized_and_not_paired(brain):
    with pytest.raises(BrainError) as e:
        BrainClient(brain.url, "wrong").ask("hi")
    assert e.value.unauthorized
    with pytest.raises(BrainError) as e2:
        BrainClient(brain.url, "").ask("hi")
    assert e2.value.unauthorized
    assert not any(r["path"] == "/api/ask" and r["headers"].get("Authorization") is None for r in brain.requests)


def test_gets_retry_once_on_5xx_but_ask_never_retries(brain):
    c = BrainClient(brain.url, TOKEN)
    brain.fail["/api/alerts"] = 503
    assert c.alerts().cursor == "0"
    assert brain.paths().count("/api/alerts") == 2
    brain.fail["/api/ask"] = 503
    with pytest.raises(BrainError):
        c.ask("hi")
    assert brain.paths().count("/api/ask") == 1


def test_network_error_is_brain_unavailable():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    with pytest.raises(BrainUnavailable):
        BrainClient(f"http://127.0.0.1:{port}", TOKEN, timeout=2).ask("hi")


def test_approve_and_pending_drafts(brain):
    brain.drafts = [{"id": "d/1", "to": ["a@x.com"], "subject": "s", "body": "b"}]
    c = BrainClient(brain.url, TOKEN)
    assert c.pending_drafts()[0]["id"] == "d/1"
    c.approve_draft("d1")
    assert brain.approved == ["d1"]
    assert brain.requests[-1]["method"] == "POST"


def test_brief(brain):
    assert BrainClient(brain.url, TOKEN).brief("daily")["kind"] == "daily"
    assert brain.requests[-1]["query"] == {"kind": ["daily"]}
