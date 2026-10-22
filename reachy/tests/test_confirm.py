import pytest

from sidekiqq_reachy.confirm import (
    Confirmed,
    Declined,
    DraftConfirmation,
    Expired,
    NothingPending,
    draft_summary,
    is_send_it,
    normalize,
    one_sentence,
    prompt_for,
)


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.mark.parametrize("phrase", ["send it", "Send it.", "SEND IT!", "  send   it ", "send, it"])
def test_exact_send_it_confirms(phrase):
    assert is_send_it(phrase)


@pytest.mark.parametrize("phrase", ["don't send it", "send it later", "yes", "sure", "send", "send it now", "", "please send it"])
def test_anything_else_does_not_confirm(phrase):
    assert not is_send_it(phrase)


def test_normalize_matches_kotlin_rules():
    assert normalize("Don't, SEND it!!") == "don't send it"


def test_confirmed_within_window_and_one_shot():
    c = Clock()
    dc = DraftConfirmation(now=c)
    dc.offer("d1", "email to Dana, subject Proposal")
    c.t += 29.9
    assert dc.evaluate("Send it.") == Confirmed("d1")
    assert dc.pending is None
    assert dc.evaluate("send it") == NothingPending()


def test_other_phrase_declines_and_consumes():
    dc = DraftConfirmation(now=Clock())
    dc.offer("d1", "x")
    assert dc.evaluate("yes") == Declined()
    assert dc.evaluate("send it") == NothingPending()


def test_window_expiry():
    c = Clock()
    dc = DraftConfirmation(now=c)
    dc.offer("d1", "x")
    assert dc.remaining_s() == pytest.approx(30.0)
    c.t += 30.5
    assert dc.remaining_s() == 0.0
    assert dc.evaluate("send it") == Expired()


def test_new_offer_replaces_and_clear_cancels():
    dc = DraftConfirmation(now=Clock())
    dc.offer("d1", "x")
    dc.offer("d2", "y")
    assert dc.evaluate("send it") == Confirmed("d2")
    dc.offer("d3", "z")
    dc.clear()
    assert dc.evaluate("send it") == NothingPending()


def test_prompt_matches_phone_wording():
    assert prompt_for("Draft to dana@acme.com: Proposal.") == "Send this: Draft to dana@acme.com: Proposal? Say 'send it' to confirm, or anything else to cancel."


def test_one_sentence_skips_greeting_and_truncates():
    body = "Hi Dana,\n\nThe revised proposal is attached and pricing is unchanged. Let me know by Friday.\n\nThanks"
    assert one_sentence(body) == "The revised proposal is attached and pricing is unchanged."
    long = "word " * 80
    s = one_sentence(long, max_chars=60)
    assert len(s) <= 60 and s.endswith("…")
    assert one_sentence("") == ""


def test_draft_summary_has_recipient_subject_and_gist():
    s = draft_summary(['"Dana Lee" <dana@acme.com>'], "Proposal", "Hi Dana,\nAttached is the proposal. Thanks!")
    assert s == "email to Dana Lee, subject Proposal. It says: Attached is the proposal"
    many = draft_summary(["a@x.com", "b@x.com", "c@x.com", "d@x.com"], "", "")
    assert many == "email to a@x.com, b@x.com and 2 more, subject (no subject)"
