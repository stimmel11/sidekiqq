from datetime import datetime, timedelta, timezone

from fakebrain import TOKEN
from sidekiqq_reachy.alerts import AlertPoller, alert_speech, needs_attention
from sidekiqq_reachy.api import BrainClient

NOW = datetime(2026, 10, 21, 18, 0, tzinfo=timezone.utc)


def alert(i: int, importance: str | None = "HIGH", minutes_ago: int = 1, title: str = "Important: Dana"):
    a = {"id": str(i), "at": (NOW - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z"), "title": title, "body": "ACME waiting", "kind": "email", "priority": "normal"}
    if importance:
        a["importance"] = importance
    return a


class Store:
    def __init__(self, cursor: str = "") -> None:
        self.cursor = cursor
        self.saves: list[str] = []

    def load(self) -> str:
        return self.cursor

    def save(self, c: str) -> None:
        self.cursor = c
        self.saves.append(c)


class Mono:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def make(brain, store, mono=None, token=TOKEN):
    mono = mono or Mono()
    return AlertPoller(
        client_factory=lambda: BrainClient(brain.url, token, timeout=2),
        load_cursor=store.load,
        save_cursor=store.save,
        interval_s=lambda: 60.0,
        max_age_s=lambda: 7200.0,
        wall_clock=lambda: NOW.timestamp(),
        monotonic=mono,
    ), mono


def test_poll_advances_and_persists_cursor_and_filters_attention(brain):
    brain.alerts = [alert(1, "CRITICAL"), alert(2, "MEDIUM"), alert(3, None), alert(4, "HIGH", minutes_ago=600)]
    store = Store()
    p, mono = make(brain, store)
    assert p.due()
    r = p.poll()
    assert [a["id"] for a in r.new] == ["1", "2", "3", "4"]
    assert [a["id"] for a in r.attention] == ["1"]  # 4 is too old; 2/3 aren't urgent
    assert store.cursor == "4"
    assert not p.due()
    mono.t += 61
    assert p.due()
    r2 = p.poll()
    assert r2.new == [] and store.saves == ["4"]
    brain.alerts.append(alert(5, "HIGH"))
    mono.t += 61
    assert [a["id"] for a in p.poll().attention] == ["5"]
    assert brain.requests[-1]["query"]["since"] == ["4"]


def test_poll_follows_more_pages(brain):
    brain.alerts = [alert(i) for i in range(1, 121)]
    store = Store()
    p, _ = make(brain, store)
    r = p.poll()
    assert len(r.new) == 120 and store.cursor == "120"
    assert store.saves == ["50", "100", "120"]


def test_network_errors_back_off_and_keep_cursor(brain):
    store = Store("7")
    p, mono = make(brain, store)
    brain.close()
    r = p.poll()
    assert r.error and "unreachable" in r.error
    assert store.cursor == "7"
    assert p.failures == 1 and p.backoff_s() == 60
    mono.t += 61
    p.poll()
    assert p.backoff_s() == 120
    for _ in range(5):
        mono.t += 1000
        p.poll()
    assert p.backoff_s() == 300


def test_unauthorized_is_reported(brain):
    p, _ = make(brain, Store(), token="revoked")
    r = p.poll()
    assert r.unauthorized


def test_not_paired_is_quiet():
    p = AlertPoller(client_factory=lambda: None, load_cursor=lambda: "", save_cursor=lambda c: None)
    r = p.poll()
    assert r.error == "not paired" and r.new == []


def test_alert_text():
    assert needs_attention({"importance": "CRITICAL"}) and not needs_attention({"importance": "LOW"}) and not needs_attention({})
    assert alert_speech({"title": "Critical: Dana Lee", "body": "Contract at risk."}) == "Critical: Dana Lee. Contract at risk."
