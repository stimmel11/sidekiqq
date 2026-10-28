import json

import pytest

from fakebrain import TOKEN
from sidekiqq_reachy.api import BrainClient
from sidekiqq_reachy.commands import (
    CHAT_GREETING,
    GAME_COMING_SOON,
    MAX_REMEMBERED,
    CommandPoller,
    Wake,
    run_wake,
)
from sidekiqq_reachy.config import ConfigStore
from sidekiqq_reachy.controller import Controller


def wake(i: int, activity: str | None = "dance", kind: str = "reachy_wake"):
    c = {"id": f"cmd_{i}", "at": "2026-10-28T12:00:00.000Z", "expiresAt": "2026-10-28T12:15:00.000Z", "kind": kind, "label": "Wake Reachy to dance", "from": "phone"}
    if activity:
        c["activity"] = activity
    return c


class Mono:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class Store:
    def __init__(self, handled=None) -> None:
        self.handled = dict(handled or {})
        self.saves = 0

    def load(self):
        return dict(self.handled)

    def save(self, h):
        self.handled = dict(h)
        self.saves += 1


NOW = 1793188860.0  # 2026-10-28T12:01:00Z, one minute after wake()'s `at`


def make(brain, store=None, mono=None, token=TOKEN, interval=60.0, queue_max_s=120.0, wall=lambda: NOW):
    store = store or Store()
    mono = mono or Mono()
    p = CommandPoller(
        client_factory=(lambda: BrainClient(brain.url, token, timeout=2)) if token is not None else (lambda: None),
        load_handled=store.load,
        save_handled=store.save,
        interval_s=lambda: interval,
        monotonic=mono,
        queue_max_s=queue_max_s,
        wall_clock=wall,
    )
    return p, store, mono


# ---------------------------------------------------------------------- client


def test_client_lists_and_acks(brain):
    brain.commands = [wake(1)]
    c = BrainClient(brain.url, TOKEN, timeout=2)
    items = c.commands()
    assert [x["id"] for x in items] == ["cmd_1"]
    req = brain.requests[-1]
    assert req["method"] == "GET" and req["path"] == "/api/commands" and req["query"]["limit"] == ["20"]
    c.ack_command("cmd_1", "opened")
    req = brain.requests[-1]
    assert req["path"] == "/api/commands/cmd_1/ack" and json.loads(req["body"]) == {"result": "opened"}
    assert req["headers"]["Content-Type"] == "application/json"
    with pytest.raises(ValueError):
        c.ack_command("cmd_1", "done")


def test_ack_is_retried_once_on_5xx(brain):
    brain.commands = [wake(1)]
    brain.fail["/api/commands/cmd_1/ack"] = 503
    BrainClient(brain.url, TOKEN, timeout=2).ack_command("cmd_1", "opened")
    assert brain.acks == [("cmd_1", "opened")]


# ---------------------------------------------------------------------- poll / dedupe


def test_new_wake_surfaces_once_and_is_claimed_once(brain):
    brain.commands = [wake(1)]
    p, store, mono = make(brain)
    assert p.due()
    r = p.poll()
    assert [w.id for w in r.new] == ["cmd_1"] and r.error is None
    assert not p.due()
    # Re-delivered (still listed, not acked yet): not new again.
    mono.t += 61
    assert p.poll().new == []
    w = p.take()
    assert w is not None and w.id == "cmd_1" and w.activity == "dance"
    assert store.handled == {"cmd_1": "opened"}  # persisted before acting
    assert p.take() is None  # never handed out twice
    # Still listed on the next poll while the activity runs: no duplicate, no early ack.
    mono.t += 61
    assert p.poll().new == [] and p.take() is None
    assert brain.acks == []
    assert p.complete(w, "opened") is True
    assert brain.acks == [("cmd_1", "opened")]
    mono.t += 61
    assert p.poll().new == [] and p.take() is None


def test_duplicate_ids_in_one_listing_are_queued_once(brain):
    brain.commands = [wake(1), dict(wake(1))]
    p, _, _ = make(brain)
    assert [w.id for w in p.poll().new] == ["cmd_1"]
    assert p.take() is not None and p.take() is None


def test_missing_activity_defaults_to_chat(brain):
    brain.commands = [wake(1, activity=None)]
    p, _, _ = make(brain)
    p.poll()
    assert p.take().activity == "chat"


def test_unknown_kinds_are_ignored_and_not_acked(brain):
    brain.commands = [wake(1, kind="open_url"), wake(2, kind="teleport")]
    p, store, mono = make(brain)
    assert p.poll().new == []
    assert p.take() is None
    mono.t += 61
    p.poll()
    assert brain.acks == [] and store.handled == {}


def test_lost_ack_is_resent_while_listed(brain):
    brain.commands = [wake(1)]
    p, store, mono = make(brain)
    p.poll()
    w = p.take()
    brain.fail["/api/commands/cmd_1/ack"] = (500, 2)  # both attempts fail
    assert p.complete(w, "opened") is False
    assert brain.commands[0].get("status") is None
    mono.t += 61
    assert p.poll().new == []  # resend, not re-run
    assert brain.acks == [("cmd_1", "opened")]
    assert p.take() is None


def test_restart_does_not_repeat_a_handled_wake(brain, tmp_path):
    """The app died after acting but before its ack landed: the brain still lists the command."""
    brain.commands = [wake(1)]
    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    ctl.pair(brain.url, "123456")
    p1 = CommandPoller(ctl.client, ctl.load_handled_commands, ctl.save_handled_commands, monotonic=Mono())
    p1.poll()
    assert p1.take() is not None  # claimed, then "crash" before complete()
    ctl2 = Controller(ConfigStore(tmp_path / "c.json"))
    assert ctl2.load_handled_commands() == {"cmd_1": "opened"}
    p2 = CommandPoller(ctl2.client, ctl2.load_handled_commands, ctl2.save_handled_commands, monotonic=Mono())
    assert p2.poll().new == []
    assert p2.take() is None
    assert brain.acks == [("cmd_1", "opened")]
    # The settings page never shows the handled ids.
    assert "handled_commands" not in json.dumps(ctl2.status())


def test_unpair_and_new_brain_forget_handled_commands(brain, tmp_path):
    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    ctl.pair(brain.url, "123456")
    ctl.save_handled_commands({"cmd_1": "opened"})
    ctl.unpair()
    assert ctl.load_handled_commands() == {}
    ctl.pair(brain.url, "123456")
    ctl.save_handled_commands({"cmd_1": "opened"})
    ctl.update_settings({"brain_url": "https://other.example.com"})
    assert ctl.load_handled_commands() == {}


def test_corrupt_handled_store_is_ignored(brain):
    p, _, _ = make(brain, store=Store({"cmd_9": "exploded", "cmd_8": "failed"}))
    brain.commands = [wake(9), wake(8)]
    assert [w.id for w in p.poll().new] == ["cmd_9"]


def test_handled_ids_are_capped(brain):
    store = Store({f"old_{i}": "opened" for i in range(MAX_REMEMBERED)})
    brain.commands = [wake(1)]
    p, store, _ = make(brain, store=store)
    p.poll()
    p.take()
    assert len(store.handled) == MAX_REMEMBERED and "cmd_1" in store.handled and "old_0" not in store.handled


# ---------------------------------------------------------------------- expiry / liveness


def test_wake_that_expires_while_queued_is_dropped_without_acting(brain):
    brain.commands = [wake(1)]
    p, store, mono = make(brain)
    p.poll()
    brain.commands[0]["expired"] = True  # brain stops listing it
    mono.t += 61
    p.poll()
    assert p.take() is None and p.pending() == 0
    assert brain.acks == [] and store.handled == {}


def test_stale_listing_holds_the_wake(brain):
    """No successful GET recently (brain unreachable): don't act on an old listing."""
    brain.commands = [wake(1)]
    p, _, mono = make(brain, interval=30.0, queue_max_s=1000)
    p.poll()
    mono.t += 61  # live window = 30 + 30 s
    assert p.take() is None and p.pending() == 1
    brain.fail["/api/commands"] = (500, 2)
    p.poll()
    assert p.take() is None
    mono.t += 120
    p.poll()  # brain back
    assert p.take() is not None


def test_wake_queued_too_long_is_dismissed_and_acked(brain):
    brain.commands = [wake(1)]
    p, store, mono = make(brain, queue_max_s=120)
    p.poll()
    mono.t += 121  # robot was busy the whole time
    assert p.take() is None
    assert store.handled == {"cmd_1": "dismissed"}
    p.poll()
    assert brain.acks == [("cmd_1", "dismissed")]
    assert p.take() is None


def test_conflicting_or_gone_ack_is_not_retried(brain):
    brain.commands = [wake(1), wake(2)]
    p, _, _ = make(brain)
    p.poll()
    w1, w2 = p.take(), p.take()
    brain.commands[0]["status"] = "dismissed"  # acked elsewhere with another result -> 409
    brain.commands.pop()  # gone -> 404
    assert p.complete(w1, "opened") is True
    assert p.complete(w2, "opened") is True


# ---------------------------------------------------------------------- cadence / errors


def test_backoff_and_unauthorized(brain):
    p, _, mono = make(brain, token="wrong", interval=60.0)
    r = p.poll()
    assert r.unauthorized and r.error
    assert p.interval() == 30.0  # capped like the phone's 30 s
    assert p.backoff_s() == 30.0
    p.poll()
    assert p.backoff_s() == 60.0
    for _ in range(6):
        p.poll()
    assert p.backoff_s() == 240.0  # 30 * 2^3, same shape as alerts


def test_interval_follows_a_shorter_alert_setting(brain):
    p, _, _ = make(brain, interval=45.0)
    assert p.interval() == 30.0
    p2, _, _ = make(brain, interval=10.0)
    assert p2.interval() == 10.0


def test_not_paired_and_unreachable(brain):
    p, _, _ = make(brain, token=None)
    assert p.poll().error == "not paired"
    dead = CommandPoller(lambda: BrainClient("http://127.0.0.1:9", TOKEN, timeout=0.5), dict, lambda h: None, monotonic=Mono())
    r = dead.poll()
    assert r.error and r.error.startswith("brain unreachable") and dead.failures == 1


# ---------------------------------------------------------------------- running each wake


class FakeBody:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def __getattr__(self, name):
        def rec(*a, **k):
            self.calls.append(name)
        return rec


class FakeVoice:
    def __init__(self, ok: bool = True) -> None:
        self.ok = ok
        self.said: list[str] = []
        self.briefs = 0

    def say(self, text: str) -> bool:
        self.said.append(text)
        return self.ok

    def brief(self, kind: str = "daily") -> bool:
        assert kind == "daily"
        self.briefs += 1
        return self.ok


def W(activity: str) -> Wake:
    return Wake(id="cmd_1", activity=activity, label="", seen_at=0.0)


def test_chat_greets_then_opens_one_listen():
    body, voice, talks, status = FakeBody(), FakeVoice(), [], []
    assert run_wake(W("chat"), voice, body, lambda: talks.append(1), status.append) == "opened"
    assert body.calls[0] == "greet" and voice.said == [CHAT_GREETING] and talks == [1]


def test_chat_without_brain_does_not_open_the_mic():
    talks: list[int] = []
    assert run_wake(W("chat"), FakeVoice(ok=False), FakeBody(), lambda: talks.append(1)) == "failed"
    assert talks == []


def test_brief_runs_the_daily_brief():
    voice, status = FakeVoice(), []
    assert run_wake(W("brief"), voice, FakeBody(), lambda: None, status.append) == "opened"
    assert voice.briefs == 1 and status == ["briefing"]
    assert run_wake(W("brief"), FakeVoice(ok=False), FakeBody(), lambda: None) == "failed"


def test_dance_moves_without_speaking():
    body, voice, status = FakeBody(), FakeVoice(), []
    assert run_wake(W("dance"), voice, body, lambda: None, status.append) == "opened"
    assert body.calls == ["dance", "neutral"] and voice.said == [] and status == ["dancing"]


def test_game_is_a_polite_stub():
    body, voice, talks = FakeBody(), FakeVoice(), []
    assert run_wake(W("game"), voice, body, lambda: talks.append(1)) == "failed"
    assert voice.said == [GAME_COMING_SOON] and talks == []


def test_unknown_activity_does_nothing():
    body, voice, talks = FakeBody(), FakeVoice(), []
    assert run_wake(W("karaoke"), voice, body, lambda: talks.append(1)) == "failed"
    assert body.calls == [] and voice.said == [] and talks == []


def test_no_wake_mode_touches_drafts(brain):
    """Waking never approves anything: only the voice confirmation does."""
    from sidekiqq_reachy.assistant import Assistant

    brain.drafts = [{"id": "d1", "to": ["a@b.c"], "subject": "s", "body": "b"}]
    client = BrainClient(brain.url, TOKEN, timeout=2)
    a = Assistant(lambda: client, FakeBody())
    for act in ("chat", "brief", "dance", "game", "karaoke"):
        run_wake(W(act), a, FakeBody(), lambda: None)
    assert brain.approved == []
    assert not any("/approve" in p for p in brain.paths())


# ---------------------------------------------------------------------- review fixes


def test_old_chat_is_dismissed_even_if_just_seen(brain):
    """Robot was offline when the owner asked: a chat must not open the mic 10 minutes later."""
    brain.commands = [wake(1, "chat"), wake(2, "dance")]
    p, store, _ = make(brain, wall=lambda: NOW + 9 * 60)
    p.poll()
    w = p.take()
    assert w is not None and w.id == "cmd_2"  # a dance is fine; the chat is too old
    assert store.handled["cmd_1"] == "dismissed"
    p.poll()
    assert ("cmd_1", "dismissed") in brain.acks


def test_recent_chat_runs_with_some_clock_skew(brain):
    brain.commands = [wake(1, "chat")]
    p, _, _ = make(brain, wall=lambda: NOW + 120)  # 3 min after `at`: inside 120 s + 60 s skew
    p.poll()
    assert p.take().activity == "chat"


def test_wrong_typed_handled_commands_in_config_are_ignored(brain, tmp_path):
    for bad in ('"x"', "null", "[1, 2]"):
        path = tmp_path / "c.json"
        path.write_text('{"brain_url": "' + brain.url + '", "token": "' + TOKEN + '", "handled_commands": ' + bad + "}")
        ctl = Controller(ConfigStore(path))
        assert ctl.load_handled_commands() == {}
        p = CommandPoller(ctl.client, ctl.load_handled_commands, ctl.save_handled_commands, monotonic=Mono())
        brain.commands = [wake(1)]
        assert [w.id for w in p.poll().new] == ["cmd_1"]
    (tmp_path / "c.json").write_text("[]")
    assert ConfigStore(tmp_path / "c.json").load().handled_commands == {}


def test_unpair_and_repair_do_not_write_old_ids_back(brain, tmp_path):
    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    ctl.pair(brain.url, "123456")
    brain.commands = [wake(1), wake(2)]
    p = CommandPoller(ctl.client, ctl.load_handled_commands, ctl.save_handled_commands, monotonic=Mono())
    p.poll()
    w1 = p.take()
    assert ctl.load_handled_commands() == {"cmd_1": "opened"}
    ctl.unpair()
    assert p.complete(w1, "opened") is False  # old pairing's wake: not recorded, not acked
    assert ctl.load_handled_commands() == {}
    ctl.pair(brain.url, "123456")
    assert p.take() is None  # the queued cmd_2 belonged to the old pairing state
    brain.commands = [wake(3)]
    p.poll()
    p.take()
    assert ctl.load_handled_commands() == {"cmd_3": "opened"}
    assert brain.acks == []
