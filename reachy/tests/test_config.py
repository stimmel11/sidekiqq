import json
import os
import stat

import pytest

from fakebrain import TOKEN
from sidekiqq_reachy.config import ConfigStore, Settings, SettingsError, apply_updates, validate_brain_url
from sidekiqq_reachy.controller import Controller


def test_defaults_are_private():
    s = Settings()
    assert s.wake_word_enabled is False
    assert s.speak_alerts is False
    assert not s.paired


def test_save_is_0600_and_roundtrips(tmp_path):
    p = tmp_path / "cfg" / "config.json"
    store = ConfigStore(p)
    store.save(Settings(brain_url="https://b.example", token="secret"))
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(p.parent).st_mode) == 0o700
    assert store.load().token == "secret"
    # unknown keys are ignored, corrupt files fall back to defaults
    p.write_text(json.dumps({"brain_url": "https://x.example", "bogus": 1}))
    assert store.load().brain_url == "https://x.example"
    p.write_text("{nope")
    assert store.load() == Settings()


def test_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("SIDEKIQQ_REACHY_CONFIG", str(tmp_path / "c.json"))
    assert ConfigStore().path == tmp_path / "c.json"


@pytest.mark.parametrize("url", ["ftp://x", "not a url", "http://brain.example.com", "https://b.example/api"])
def test_bad_brain_urls(url):
    with pytest.raises(SettingsError):
        validate_brain_url(url)


def test_good_brain_urls():
    assert validate_brain_url(" https://b.vercel.app/ ") == "https://b.vercel.app"
    assert validate_brain_url("http://localhost:3000") == "http://localhost:3000"


def test_apply_updates_validates_and_protects_token():
    s = Settings()
    apply_updates(s, {"voice": "nova", "speak_alerts": True, "alert_poll_seconds": "90"})
    assert (s.voice, s.speak_alerts, s.alert_poll_seconds) == ("nova", True, 90)
    for bad in ({"token": "x"}, {"alert_cursor": "9"}, {"voice": "darth"}, {"speak_alerts": "yes"}, {"alert_poll_seconds": 5}):
        with pytest.raises(SettingsError):
            apply_updates(s, bad)


def test_public_never_contains_token():
    pub = Settings(brain_url="https://b.example", token="secret").public()
    assert "token" not in pub and pub["paired"] is True
    assert "secret" not in json.dumps(pub)


def test_controller_pair_unpair_and_status(brain, tmp_path):
    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    with pytest.raises(SettingsError):
        ctl.pair(brain.url, "12")
    with pytest.raises(SettingsError, match="Pairing failed"):
        ctl.pair(brain.url, "000000")
    st = ctl.pair(brain.url, "123456")
    assert st["paired"] and "token" not in json.dumps(st)
    assert ConfigStore(tmp_path / "c.json").load().token == TOKEN
    assert ctl.client() is not None and ctl.client().token == TOKEN
    ctl.save_cursor("12")
    assert ctl.load_cursor() == "12"
    # Switching brains drops the token and cursor.
    ctl.update_settings({"brain_url": "https://other.example"})
    assert not ctl.settings.paired and ctl.load_cursor() == ""
    ctl.pair(brain.url, "123456")
    ctl.mark_unauthorized()
    assert ctl.status()["paired"] is False and ctl.status()["authFailed"] is True
    ctl.unpair()
    assert ctl.client() is None


def test_controller_unreachable_brain(tmp_path):
    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    with pytest.raises(SettingsError, match="Can't reach"):
        ctl.pair("http://127.0.0.1:9", "123456")
    assert not ctl.settings.paired


def test_note_alert_hides_names(tmp_path):
    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    ctl.note_alert({"title": "Critical: Dana Lee", "importance": "CRITICAL", "at": "x"})
    assert "Dana" not in json.dumps(ctl.status())
