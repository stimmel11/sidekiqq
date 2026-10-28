"""Integration tests against the real Reachy Mini SDK classes (ReachyMiniApp, create_head_pose,
FastAPI settings app) with a fake robot/media and the fake brain. Skipped when the SDK isn't
installed (it needs GStreamer/PyGObject)."""

import threading
import time

import numpy as np
import pytest

reachy_mini = pytest.importorskip("reachy_mini")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from fakebrain import TOKEN  # noqa: E402
from sidekiqq_reachy.assistant import Assistant  # noqa: E402
from sidekiqq_reachy.config import ConfigStore  # noqa: E402
from sidekiqq_reachy.controller import Controller  # noqa: E402
from sidekiqq_reachy.expressions import RobotBody  # noqa: E402
from sidekiqq_reachy.main import SidekiqqReachy, VoiceLoop, register_routes  # noqa: E402


class FakeMedia:
    """SDK-shaped mic: float32 (n, 2) chunks at 16 kHz; None when nothing is buffered."""

    def __init__(self, script: np.ndarray) -> None:
        self.script = script
        self.pos = 0
        self.recording = False
        self.played: list[str] = []
        self.gate = threading.Event()

    def start_recording(self):
        self.recording = True

    def stop_recording(self):
        self.recording = False

    def get_input_audio_samplerate(self):
        return 16000

    def get_audio_sample(self):
        if not self.gate.is_set():
            time.sleep(0.005)
            return np.zeros((512, 2), np.float32) + 0.0005
        if self.pos >= len(self.script):
            time.sleep(0.005)
            return np.zeros((512, 2), np.float32) + 0.0005
        chunk = self.script[self.pos : self.pos + 512]
        self.pos += 512
        return np.stack([chunk, chunk], axis=1)

    def play_sound(self, path):
        self.played.append(path)


class FakeRobot:
    def __init__(self, media: FakeMedia) -> None:
        self.media = media
        self.targets = 0
        self.gotos = 0

    def set_target(self, head=None, antennas=None, body_yaw=None):
        assert head.shape == (4, 4) and len(antennas) == 2
        self.targets += 1

    def goto_target(self, head=None, antennas=None, duration=0.5, **kw):
        assert head.shape == (4, 4) and len(antennas) == 2 and duration > 0
        self.gotos += 1


def test_app_class_contract():
    assert issubclass(SidekiqqReachy, reachy_mini.ReachyMiniApp)
    assert SidekiqqReachy.custom_app_url == "http://0.0.0.0:8042"
    from importlib.metadata import entry_points  # noqa: F401  (entry point is declared in pyproject)


def test_settings_web_ui_routes(brain, tmp_path):
    app = SidekiqqReachy()
    assert app.settings_app is not None
    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    register_routes(app.settings_app, ctl)
    c = TestClient(app.settings_app)
    assert "SideKiqq" in c.get("/").text
    assert c.get("/static/main.js").status_code == 200
    assert c.get("/sk/status").json()["paired"] is False
    assert c.post("/sk/talk", content="x", headers={"content-type": "text/plain"}).status_code == 415
    assert c.post("/sk/pair", json={"brain_url": brain.url, "code": "000000"}).status_code == 400
    r = c.post("/sk/pair", json={"brain_url": brain.url, "code": "123456"})
    assert r.status_code == 200 and r.json()["paired"] and TOKEN not in r.text
    assert c.post("/sk/settings", json={"token": "x"}).status_code == 400
    assert c.post("/sk/settings", json={"speak_alerts": True}).json()["settings"]["speak_alerts"] is True
    assert c.post("/sk/talk", json={}).status_code == 200 and ctl.talk_requested.is_set()
    assert TOKEN not in c.get("/sk/status").text


def test_voice_loop_end_to_end_with_fake_robot(brain, tmp_path):
    rate = 16000
    t = np.arange(int(rate * 1.0)) / rate
    speech = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    quiet = np.zeros(int(rate * 1.2), np.float32) + 0.0005
    media = FakeMedia(np.concatenate([quiet[:4800], speech, quiet]))
    robot = FakeRobot(media)
    stop = threading.Event()

    brain.transcripts = ["what's next"]
    brain.ask_replies = [{"reply": "Call Dana.", "spoken": "Call Dana."}]
    brain.alerts = [{"id": "1", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "title": "Critical: Dana", "body": "Contract risk", "kind": "email", "importance": "CRITICAL", "priority": "high"}]

    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    ctl.pair(brain.url, "123456")
    body = RobotBody(robot, stop)
    assistant = Assistant(ctl.client, body, voice=lambda: ctl.settings.voice, on_unauthorized=ctl.mark_unauthorized, on_status=ctl.set_status)
    loop = VoiceLoop(media, body, assistant, ctl, stop)
    th = threading.Thread(target=loop.run, daemon=True)
    th.start()

    # The alert poll runs immediately: attention gesture + chime, but no speech (speak_alerts off).
    deadline = time.time() + 10
    while time.time() < deadline and not any(p.endswith("chime.wav") for p in media.played):
        time.sleep(0.05)
    assert any(p.endswith("chime.wav") for p in media.played)
    assert ctl.load_cursor() == "1"

    while time.time() < deadline and loop._busy():
        time.sleep(0.05)
    ctl.request_talk()
    media.gate.set()
    while time.time() < deadline and "/api/speak" not in brain.paths():
        time.sleep(0.05)
    stop.set()
    th.join(timeout=5)
    assert not th.is_alive(), "loop must stop promptly on stop_event"
    paths = brain.paths()
    assert paths.index("/api/transcribe") < paths.index("/api/ask") < paths.index("/api/speak")
    assert robot.gotos > 0
    assert not media.recording


# ---------------------------------------------------------------------- device commands (reachy_wake)


def _wake_cmd(i, activity):
    return {"id": f"cmd_{i}", "at": "2026-10-28T12:00:00.000Z", "expiresAt": "2026-10-28T12:15:00.000Z", "kind": "reachy_wake", "label": f"Wake Reachy {activity}", "from": "phone", "activity": activity}


def _loop(brain, tmp_path, script=None, confirmation=None):
    media = FakeMedia(script if script is not None else np.zeros(16000, np.float32))
    robot = FakeRobot(media)
    stop = threading.Event()
    ctl = Controller(ConfigStore(tmp_path / "c.json"))
    ctl.pair(brain.url, "123456")
    body = RobotBody(robot, stop)
    assistant = Assistant(ctl.client, body, voice=lambda: ctl.settings.voice, on_unauthorized=ctl.mark_unauthorized, on_status=ctl.set_status, confirmation=confirmation)
    loop = VoiceLoop(media, body, assistant, ctl, stop)
    return media, robot, stop, ctl, assistant, loop


def _wait(cond, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline and not cond():
        time.sleep(0.05)
    return cond()


def test_dance_wake_runs_once_and_acks(brain, tmp_path):
    brain.commands = [_wake_cmd(1, "dance"), {**_wake_cmd(2, "dance"), "kind": "open_url"}]
    media, robot, stop, ctl, _, loop = _loop(brain, tmp_path)
    th = threading.Thread(target=loop.run, daemon=True)
    th.start()
    assert _wait(lambda: ("cmd_1", "opened") in brain.acks)
    stop.set()
    th.join(timeout=5)
    assert not th.is_alive()
    assert media.played.count("dance1.wav") == 1
    assert robot.gotos >= 8
    assert brain.acks == [("cmd_1", "opened")]  # the open_url isn't Reachy's: ignored, not acked
    assert ctl.load_handled_commands() == {"cmd_1": "opened"}
    assert "/api/speak" not in brain.paths()


def test_wake_waits_for_a_pending_send_it_and_never_approves(brain, tmp_path):
    """Mid-conversation: a draft is waiting for "send it". The wake must not interrupt or answer it."""
    from sidekiqq_reachy.confirm import DraftConfirmation

    brain.commands = [_wake_cmd(1, "dance")]
    conf = DraftConfirmation(window_s=1.2)
    media, robot, stop, ctl, assistant, loop = _loop(brain, tmp_path, confirmation=conf)
    conf.offer("d1", "an email to Dana")
    th = threading.Thread(target=loop.run, daemon=True)
    th.start()
    assert _wait(lambda: ("cmd_1", "opened") in brain.acks)
    stop.set()
    th.join(timeout=5)
    # Silence cancelled the draft (spoken "not sent") before the dance started.
    assert brain.approved == []
    spoken = [i for i, p in enumerate(media.played) if "sidekiqq_reachy_" in p and not p.endswith("chime.wav")]
    assert spoken and spoken[0] < media.played.index("dance1.wav")
    assert "/api/transcribe" not in brain.paths()


def test_chat_wake_greets_then_listens_for_one_turn(brain, tmp_path):
    rate = 16000
    t = np.arange(int(rate * 1.0)) / rate
    speech = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    quiet = np.zeros(int(rate * 1.2), np.float32) + 0.0005
    brain.commands = [_wake_cmd(1, "chat")]
    brain.transcripts = ["what's next"]
    brain.ask_replies = [{"reply": "Call Dana.", "spoken": "Call Dana."}]
    media, robot, stop, ctl, _, loop = _loop(brain, tmp_path, script=np.concatenate([quiet[:4800], speech, quiet]))
    th = threading.Thread(target=loop.run, daemon=True)
    th.start()
    assert _wait(lambda: ctl.state == "listening")
    assert "wake_up.wav" in media.played
    assert _wait(lambda: ("cmd_1", "opened") in brain.acks)
    media.gate.set()
    assert _wait(lambda: "/api/ask" in brain.paths())
    stop.set()
    th.join(timeout=5)
    paths = brain.paths()
    assert paths.index("/api/speak") < paths.index("/api/transcribe") < paths.index("/api/ask")
