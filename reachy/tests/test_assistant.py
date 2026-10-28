import json

import numpy as np

from fakebrain import TOKEN
from sidekiqq_reachy.api import BrainClient
from sidekiqq_reachy.assistant import NOT_SENT, Assistant, Outcome
from sidekiqq_reachy.confirm import DraftConfirmation

SPEECH = np.full(16000, 1000, np.int16)  # 1 s "utterance" (content is irrelevant to the fake STT)


class FakeBody:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.played = 0

    def __getattr__(self, name):
        def rec(*a, **k):
            self.calls.append(name)
        return rec

    def play_wav(self, wav: bytes) -> None:
        assert wav[:4] == b"RIFF"
        self.played += 1
        self.calls.append("play_wav")


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def make(brain, token=TOKEN, clock=None):
    clock = clock or Clock()
    body = FakeBody()
    flags = {"unauth": 0, "status": []}
    a = Assistant(
        client_factory=(lambda: BrainClient(brain.url, token, timeout=3)) if token is not None else (lambda: None),
        body=body,
        voice=lambda: "nova",
        confirmation=DraftConfirmation(now=clock),
        on_unauthorized=lambda: flags.__setitem__("unauth", flags["unauth"] + 1),
        on_status=lambda s, e: flags["status"].append((s, e)),
        now=clock,
    )
    return a, body, clock, flags


def spoken_texts(brain):
    return [json.loads(r["body"])["text"] for r in brain.requests if r["path"] == "/api/speak"]


def test_simple_question_flow(brain):
    brain.transcripts = ["what's on today"]
    brain.ask_replies = [{"reply": "You have 3 meetings and a proposal due.", "spoken": "Three meetings and a proposal due."}]
    a, body, _, _ = make(brain)
    assert a.handle_utterance(SPEECH) is Outcome.ANSWERED
    assert brain.paths() == ["/api/transcribe", "/api/ask", "/api/speak"]
    ask = json.loads(brain.requests[1]["body"])
    assert ask == {"text": "what's on today", "device": "reachy"}
    assert spoken_texts(brain) == ["Three meetings and a proposal due."]
    assert json.loads(brain.requests[2]["body"])["voice"] == "nova"
    assert body.calls.index("thinking_start") < body.calls.index("play_wav") < body.calls.index("nod")


def test_conversation_id_is_reused_until_idle(brain):
    brain.transcripts = ["a", "b", "c"]
    a, _, clock, _ = make(brain)
    a.handle_utterance(SPEECH)
    clock.t += 60
    a.handle_utterance(SPEECH)
    clock.t += 301
    a.handle_utterance(SPEECH)
    asks = [json.loads(r["body"]) for r in brain.requests if r["path"] == "/api/ask"]
    assert "conversationId" not in asks[0] and asks[1]["conversationId"] == "c1" and "conversationId" not in asks[2]


def draft_reply():
    return {"reply": "Drafted.", "spoken": "I drafted a reply to Dana.", "actions": [{"type": "draft_created", "id": "dr_1", "summary": "Draft to dana@acme.com: Proposal"}]}


def test_draft_read_back_includes_body_summary_and_send_it_approves(brain):
    brain.transcripts = ["reply to dana that the proposal is attached", "Send it."]
    brain.ask_replies = [draft_reply()]
    brain.drafts = [{"id": "dr_1", "to": ['"Dana Lee" <dana@acme.com>'], "subject": "Proposal", "body": "Hi Dana,\nThe proposal is attached. Thanks"}]
    a, body, clock, _ = make(brain)
    assert a.handle_utterance(SPEECH) is Outcome.AWAITING_CONFIRM
    assert spoken_texts(brain)[-1] == "Send this: email to Dana Lee, subject Proposal. It says: The proposal is attached? Say 'send it' to confirm, or anything else to cancel."
    assert a.awaiting_confirm and body.calls[-1] == "listening"
    clock.t += 20
    assert a.handle_utterance(SPEECH) is Outcome.DRAFT_SENT
    assert brain.approved == ["dr_1"]
    assert spoken_texts(brain)[-1] == "Sent."
    # The "send it" answer is never forwarded to /api/ask.
    assert brain.paths().count("/api/ask") == 1


def test_anything_else_cancels_and_does_not_approve(brain):
    brain.transcripts = ["draft it", "yes"]
    brain.ask_replies = [draft_reply()]
    a, _, _, _ = make(brain)
    a.handle_utterance(SPEECH)
    assert a.handle_utterance(SPEECH) is Outcome.DRAFT_NOT_SENT
    assert brain.approved == [] and spoken_texts(brain)[-1] == NOT_SENT
    assert brain.paths().count("/api/ask") == 1


def test_silence_cancels(brain):
    brain.transcripts = ["draft it"]
    brain.ask_replies = [draft_reply()]
    a, _, _, _ = make(brain)
    a.handle_utterance(SPEECH)
    assert a.handle_utterance(None) is Outcome.DRAFT_NOT_SENT
    assert not a.awaiting_confirm and brain.approved == []
    assert a.handle_utterance(None) is Outcome.NOTHING_HEARD


def test_empty_transcript_cancels(brain):
    brain.transcripts = ["draft it", ""]
    brain.ask_replies = [draft_reply()]
    a, _, _, _ = make(brain)
    a.handle_utterance(SPEECH)
    assert a.handle_utterance(SPEECH) is Outcome.DRAFT_NOT_SENT
    assert brain.approved == []


def test_send_it_after_window_is_a_new_question_not_an_approval(brain):
    brain.transcripts = ["draft it", "send it"]
    brain.ask_replies = [draft_reply(), {"reply": "Send what?", "spoken": "Send what?"}]
    a, _, clock, _ = make(brain)
    a.handle_utterance(SPEECH)
    clock.t += 31
    assert a.handle_utterance(SPEECH) is Outcome.ANSWERED
    assert brain.approved == []
    assert brain.paths().count("/api/ask") == 2


def test_cancel_button(brain):
    brain.transcripts = ["draft it"]
    brain.ask_replies = [draft_reply()]
    a, _, _, _ = make(brain)
    a.handle_utterance(SPEECH)
    assert a.cancel_pending() is True
    assert not a.awaiting_confirm and spoken_texts(brain)[-1] == NOT_SENT
    assert a.cancel_pending() is False


def test_draft_body_fetch_failure_falls_back_to_summary(brain):
    brain.transcripts = ["draft it"]
    brain.ask_replies = [draft_reply()]
    brain.drafts = [{"id": "dr_1", "to": ["dana@acme.com"], "subject": "Proposal", "body": "secret body"}]
    brain.fail["/api/drafts"] = (500, 2)  # GETs retry once, so fail both attempts
    a, _, _, _ = make(brain)
    a.handle_utterance(SPEECH)
    assert brain.paths().count("/api/drafts") == 2
    assert spoken_texts(brain)[-1].startswith("Send this: Draft to dana@acme.com: Proposal?")


def test_draft_read_back_prefers_brain_readback(brain):
    brain.transcripts = ["reply to dana"]
    brain.ask_replies = [draft_reply()]
    brain.drafts = [{"id": "dr_1", "kind": "email", "to": ['"Dana Lee" <dana@acme.com>'], "subject": "Proposal",
                     "body": "Hi Dana,\nThe proposal is attached.", "readback": "Email to dana@acme.com, with the subject: Proposal."}]
    a, _, _, _ = make(brain)
    assert a.handle_utterance(SPEECH) is Outcome.AWAITING_CONFIRM
    assert spoken_texts(brain)[-1] == (
        "Send this: Email to dana@acme.com, with the subject: Proposal. Message begins: The proposal is attached? "
        "Say 'send it' to confirm, or anything else to cancel."
    )


def test_approve_failure_is_reported_and_not_retried(brain):
    brain.transcripts = ["draft it", "send it"]
    brain.ask_replies = [draft_reply()]
    a, _, _, _ = make(brain)
    a.handle_utterance(SPEECH)
    brain.fail["/api/drafts/dr_1/approve"] = 410
    assert a.handle_utterance(SPEECH) is Outcome.FAILED
    assert [r for r in brain.paths() if r.endswith("/approve")] == ["/api/drafts/dr_1/approve"]
    assert spoken_texts(brain)[-1] == "I couldn't send it. The draft is still saved in the app."


def test_short_noise_is_ignored(brain):
    a, _, _, _ = make(brain)
    assert a.handle_utterance(np.zeros(1000, np.int16)) is Outcome.NOTHING_HEARD
    assert brain.requests == []


def test_not_paired(brain):
    a, body, _, _ = make(brain, token=None)
    assert a.handle_utterance(SPEECH) is Outcome.NOT_PAIRED
    assert "confused" in body.calls and brain.requests == []


def test_revoked_token_triggers_unauthorized(brain):
    a, body, _, flags = make(brain, token="revoked")
    assert a.handle_utterance(SPEECH) is Outcome.FAILED
    assert flags["unauth"] == 1 and "confused" in body.calls
    assert "/api/speak" not in brain.paths()


def test_brain_down_looks_confused_without_crashing(brain):
    url = brain.url
    brain.close()
    body = FakeBody()
    a = Assistant(client_factory=lambda: BrainClient(url, TOKEN, timeout=2), body=body)
    assert a.handle_utterance(SPEECH) is Outcome.FAILED
    assert "confused" in body.calls and "thinking_stop" in body.calls


def test_ask_error_speaks_trouble(brain):
    brain.transcripts = ["hi"]
    brain.fail["/api/ask"] = 504
    a, _, _, _ = make(brain)
    assert a.handle_utterance(SPEECH) is Outcome.FAILED
    assert spoken_texts(brain) == ["Sorry, I'm having trouble reaching SideKiqq."]


def test_brief(brain):
    brain.brief = {"kind": "daily", "sections": [{"title": "TODAY", "items": ["Call Dana"]}], "top5": []}
    a, body, _, _ = make(brain)
    assert a.brief() is True
    assert brain.requests[0]["query"] == {"kind": ["daily"]}
    assert "Today: Call Dana." in spoken_texts(brain)[0]
    assert body.calls[-1] == "nod"


def test_long_reply_is_split_across_speak_calls(brain):
    brain.transcripts = ["read it all"]
    long = "This is a sentence that goes on. " * 60
    brain.ask_replies = [{"reply": long, "spoken": long}]
    a, body, _, _ = make(brain)
    a.handle_utterance(SPEECH)
    texts = spoken_texts(brain)
    assert len(texts) >= 2 and all(len(t) <= 900 for t in texts)
    assert body.played == len(texts)
