"""Robot body: poses, antenna motion and audio playback on a Reachy Mini.

SDK calls used (verified in reachy_mini 1.12.0 source):
- ``reachy_mini.goto_target(head=4x4, antennas=[right, left] rad, duration=s)`` (blocking, interpolated)
- ``reachy_mini.set_target(head=4x4, antennas=[right, left] rad)`` (immediate, for 50 Hz loops)
- ``reachy_mini.utils.create_head_pose(roll=, pitch=, yaw=, degrees=True)``
- ``reachy_mini.media.play_sound(path)``: absolute path, or a file name in the SDK assets
  (``confused1.wav``, ``wake_up.wav``...). Plays asynchronously through GStreamer.

Every method swallows and logs errors: a motion glitch must never break the voice loop.
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from typing import Any

import numpy as np

from .audio import chime_wav, wav_bytes_duration

log = logging.getLogger("sidekiqq_reachy.body")


def _deg(*a: float) -> np.ndarray:
    return np.deg2rad(np.array(a, dtype=np.float64))


class RobotBody:
    def __init__(self, reachy_mini: Any, stop_event: threading.Event) -> None:
        from reachy_mini.utils import create_head_pose  # imported lazily so tests don't need the SDK

        self.r = reachy_mini
        self.stop_event = stop_event
        self._pose = create_head_pose
        self._motion_lock = threading.RLock()
        self._think_stop = threading.Event()
        self._think_thread: threading.Thread | None = None
        self._tmpdir = tempfile.mkdtemp(prefix="sidekiqq_reachy_")
        self._chime_path = os.path.join(self._tmpdir, "chime.wav")
        with open(self._chime_path, "wb") as f:
            f.write(chime_wav())
        #: True while the robot is talking; the mic loop drops frames so we don't hear ourselves.
        self.speaking = threading.Event()

    # ------------------------------------------------------------------ helpers

    def _goto(self, duration: float, roll: float = 0, pitch: float = 0, yaw: float = 0, antennas: tuple[float, float] = (0, 0)) -> None:
        if self.stop_event.is_set():
            return
        try:
            with self._motion_lock:
                self.r.goto_target(
                    head=self._pose(roll=roll, pitch=pitch, yaw=yaw, degrees=True),
                    antennas=_deg(*antennas),
                    duration=duration,
                )
        except Exception:  # noqa: BLE001
            log.exception("goto_target failed")

    def _sound(self, name_or_path: str) -> None:
        try:
            self.r.media.play_sound(name_or_path)
        except Exception:  # noqa: BLE001
            log.exception("play_sound(%s) failed", name_or_path)

    # ------------------------------------------------------------------ expressions

    def neutral(self) -> None:
        self.thinking_stop()
        self._goto(0.6)

    def listening(self) -> None:
        """Curious head tilt, antennas perked up."""
        self.thinking_stop()
        self._goto(0.35, roll=8, antennas=(25, -25))

    def thinking_start(self) -> None:
        if self._think_thread and self._think_thread.is_alive():
            return
        self._think_stop.clear()
        self._think_thread = threading.Thread(target=self._think_loop, name="sk-thinking", daemon=True)
        self._think_thread.start()

    def thinking_stop(self) -> None:
        self._think_stop.set()
        t = self._think_thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=1.0)
        self._think_thread = None

    def _think_loop(self) -> None:
        """Slow asymmetric antenna 'pondering' with a slight head tilt, at 50 Hz."""
        t0 = time.monotonic()
        head = self._pose(roll=-6, pitch=0, yaw=6, degrees=True)
        while not self._think_stop.is_set() and not self.stop_event.is_set():
            t = time.monotonic() - t0
            a = 30.0 * np.sin(2 * np.pi * 0.8 * t)
            b = 30.0 * np.sin(2 * np.pi * 0.8 * t + np.pi / 2)
            try:
                with self._motion_lock:
                    self.r.set_target(head=head, antennas=_deg(a, b))
            except Exception:  # noqa: BLE001
                log.exception("set_target failed")
                return
            time.sleep(0.02)

    def nod(self) -> None:
        """Reply delivered."""
        self.thinking_stop()
        self._goto(0.22, pitch=12, antennas=(10, -10))
        self._goto(0.22, pitch=-4, antennas=(10, -10))
        self._goto(0.35)

    def attention(self) -> None:
        """CRITICAL/HIGH alert: antennas snap up, quick look-around, short chime."""
        self.thinking_stop()
        self._sound(self._chime_path)
        self._goto(0.18, antennas=(60, -60))
        self._goto(0.25, yaw=15, roll=5, antennas=(60, -60))
        self._goto(0.25, yaw=-15, roll=-5, antennas=(40, -40))
        self._goto(0.4, antennas=(20, -20))

    def confused(self) -> None:
        """Couldn't reach the brain / didn't understand."""
        self.thinking_stop()
        self._sound("confused1.wav")
        self._goto(0.3, roll=12, antennas=(-20, 20))
        self._goto(0.5)

    # ------------------------------------------------------------------ audio out

    def play_wav(self, wav: bytes) -> None:
        """Play a WAV on the robot speaker and block until it has finished (or stop is set)."""
        duration = wav_bytes_duration(wav)
        if duration <= 0:
            return
        fd, path = tempfile.mkstemp(suffix=".wav", dir=self._tmpdir)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(wav)
            self.speaking.set()
            self.r.media.play_sound(path)
            # play_sound is asynchronous; wait for the clip, staying responsive to stop.
            self.stop_event.wait(duration + 0.25)
        except Exception:  # noqa: BLE001
            log.exception("playback failed")
        finally:
            self.speaking.clear()
            try:
                os.unlink(path)
            except OSError:
                pass

    def close(self) -> None:
        self.thinking_stop()
        try:
            for name in os.listdir(self._tmpdir):
                os.unlink(os.path.join(self._tmpdir, name))
            os.rmdir(self._tmpdir)
        except OSError:
            pass
