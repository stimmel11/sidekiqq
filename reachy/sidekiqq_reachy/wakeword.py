"""Optional on-device wake word via openWakeWord. OFF by default (Settings.wake_word_enabled).

Audio fed here never leaves the robot: detection runs locally, and only the utterance AFTER
the wake word goes to the brain. Install the extra with ``pip install "sidekiqq_reachy[wakeword]"``.

openWakeWord ships pre-trained models such as "hey_jarvis", "alexa" and "hey_mycroft"; a custom
"hey SideKiqq" model can be trained with its tools and set as ``wake_word_model`` (a path to a
.onnx/.tflite file also works). Not yet tested on a real robot.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

log = logging.getLogger("sidekiqq_reachy.wakeword")

CHUNK = 1280  # 80 ms at 16 kHz, what openWakeWord expects per predict() call


class WakeWordUnavailable(RuntimeError):
    pass


class WakeWord:
    def __init__(self, model: str = "hey_jarvis", threshold: float = 0.5) -> None:
        try:
            import openwakeword  # type: ignore[import-not-found]
            from openwakeword.model import Model  # type: ignore[import-not-found]
        except ImportError as e:  # pragma: no cover - depends on optional extra
            raise WakeWordUnavailable('openWakeWord is not installed (pip install "sidekiqq_reachy[wakeword]")') from e
        try:  # pragma: no cover - needs network/models
            utils: Any = getattr(openwakeword, "utils", None)
            if utils is not None and hasattr(utils, "download_models"):
                utils.download_models()
        except Exception:  # noqa: BLE001
            log.warning("could not download openWakeWord models; using any cached ones")
        self.model = Model(wakeword_models=[model])  # pragma: no cover
        self.threshold = threshold
        self._buf = np.zeros(0, dtype=np.int16)

    def feed(self, pcm16: np.ndarray) -> bool:
        """Feed 16 kHz mono int16 audio. True when the wake word was heard."""
        self._buf = np.concatenate([self._buf, pcm16.astype(np.int16, copy=False)])
        hit = False
        while self._buf.size >= CHUNK:
            chunk, self._buf = self._buf[:CHUNK], self._buf[CHUNK:]
            scores = self.model.predict(chunk)
            if any(float(s) >= self.threshold for s in scores.values()):
                hit = True
        if hit:
            self.reset()
        return hit

    def reset(self) -> None:
        self._buf = np.zeros(0, dtype=np.int16)
        try:
            self.model.reset()
        except Exception:  # noqa: BLE001
            pass
