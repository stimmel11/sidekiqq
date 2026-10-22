"""Pure audio helpers: mic frame conversion, energy endpointing, WAV framing, a chime.

Everything here is numpy-only (no robot, no network) so it is unit-tested directly.

Reachy Mini SDK facts this relies on (checked in reachy_mini 1.12.0 source,
media/audio_base.py): ``media.get_audio_sample()`` returns float32 ``(n, 2)`` stereo
in [-1, 1] at ``media.get_input_audio_samplerate()`` (16000 Hz on the ReSpeaker), or
``None`` when nothing is buffered.
"""

from __future__ import annotations

import enum
import struct
from collections import deque
from dataclasses import dataclass

import numpy as np

TARGET_RATE = 16_000  # the brain's /api/transcribe contract: 16 kHz mono PCM16
FRAME_MS = 30
FRAME_SAMPLES = TARGET_RATE * FRAME_MS // 1000  # 480


# --------------------------------------------------------------------------- conversion


def to_mono_float(sample: np.ndarray) -> np.ndarray:
    """(n,), (n, 1) or (n, channels) float audio -> (n,) float32 mono."""
    a = np.asarray(sample, dtype=np.float32)
    if a.ndim == 2:
        a = a.mean(axis=1) if a.shape[1] > 1 else a[:, 0]
    return a.reshape(-1).astype(np.float32, copy=False)


def resample_linear(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Linear-interpolation resampler. Fine for speech going to an STT service."""
    if src_rate == dst_rate or x.size == 0:
        return x.astype(np.float32, copy=False)
    n_out = int(round(x.size * dst_rate / src_rate))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)
    src_t = np.arange(x.size, dtype=np.float64) / src_rate
    dst_t = np.arange(n_out, dtype=np.float64) / dst_rate
    return np.interp(dst_t, src_t, x).astype(np.float32)


def float_to_pcm16(x: np.ndarray) -> np.ndarray:
    return (np.clip(x, -1.0, 1.0) * 32767.0).round().astype(np.int16)


def pcm16_to_float(x: np.ndarray) -> np.ndarray:
    return (x.astype(np.float32) / 32768.0).astype(np.float32)


def mic_to_pcm16(sample: np.ndarray, src_rate: int) -> np.ndarray:
    """One SDK mic chunk -> 16 kHz mono int16."""
    return float_to_pcm16(resample_linear(to_mono_float(sample), src_rate, TARGET_RATE))


class FrameAssembler:
    """Re-chunks arbitrary-length int16 input into fixed FRAME_SAMPLES frames."""

    def __init__(self, frame_samples: int = FRAME_SAMPLES) -> None:
        self.frame_samples = frame_samples
        self._buf = np.zeros(0, dtype=np.int16)

    def push(self, pcm: np.ndarray) -> list[np.ndarray]:
        self._buf = np.concatenate([self._buf, pcm.astype(np.int16, copy=False)])
        frames: list[np.ndarray] = []
        while self._buf.size >= self.frame_samples:
            frames.append(self._buf[: self.frame_samples].copy())
            self._buf = self._buf[self.frame_samples :]
        return frames

    def reset(self) -> None:
        self._buf = np.zeros(0, dtype=np.int16)


# --------------------------------------------------------------------------- WAV


def encode_wav(pcm: np.ndarray, sample_rate: int = TARGET_RATE) -> bytes:
    """Mono int16 samples -> a complete RIFF/WAVE (PCM16 LE) file."""
    data = np.asarray(pcm, dtype="<i2").tobytes()
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(data),
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        1,  # mono
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        len(data),
    )
    return header + data


class WavFormatError(ValueError):
    pass


@dataclass
class WavAudio:
    samples: np.ndarray  # int16, shape (n,) for mono or (n, channels)
    sample_rate: int
    channels: int

    @property
    def duration_s(self) -> float:
        n = self.samples.shape[0]
        return n / self.sample_rate if self.sample_rate else 0.0


def decode_wav(data: bytes) -> WavAudio:
    """Parse a PCM16 WAV, tolerating streamed placeholder sizes (0 / 0xFFFFFFFF)."""
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise WavFormatError("not a RIFF/WAVE file")
    off = 12
    fmt: tuple[int, int, int, int] | None = None
    while off + 8 <= len(data):
        cid = data[off : off + 4]
        (size,) = struct.unpack_from("<I", data, off + 4)
        body = off + 8
        if cid == b"fmt ":
            if size < 16 or body + 16 > len(data):
                raise WavFormatError("truncated fmt chunk")
            audio_format, channels, rate, _, _, bits = struct.unpack_from("<HHIIHH", data, body)
            fmt = (audio_format, channels, rate, bits)
        elif cid == b"data":
            if size in (0, 0xFFFFFFFF) or body + size > len(data):
                size = len(data) - body
            if fmt is None:
                raise WavFormatError("data before fmt")
            audio_format, channels, rate, bits = fmt
            if audio_format not in (1, 0xFFFE) or bits != 16:
                raise WavFormatError("only PCM16 is supported")
            raw = data[body : body + size - (size % (2 * channels))]
            s = np.frombuffer(raw, dtype="<i2").astype(np.int16)
            if channels > 1:
                s = s.reshape(-1, channels)
            return WavAudio(s, rate, channels)
        off = body + size + (size % 2)
    raise WavFormatError("missing fmt or data chunk")


# --------------------------------------------------------------------------- endpointing


def rms_dbfs(frame: np.ndarray) -> float:
    if frame.size == 0:
        return -120.0
    x = frame.astype(np.float64) / 32768.0
    rms = float(np.sqrt(np.mean(x * x)))
    return 20.0 * np.log10(max(rms, 1e-6))


class EndpointEvent(enum.Enum):
    NONE = "none"
    STARTED = "started"  # speech onset detected
    ENDED = "ended"  # utterance complete; call .utterance()
    NO_SPEECH = "no_speech"  # nobody spoke before the timeout
    MAX_LENGTH = "max_length"  # hit the cap; .utterance() still valid


@dataclass
class EndpointConfig:
    frame_ms: int = FRAME_MS
    #: Speech must be this many dB above the running noise floor...
    margin_db: float = 12.0
    #: ...and above this absolute level (rejects a silent room's tiny fluctuations).
    min_speech_dbfs: float = -45.0
    start_frames: int = 3  # ~90 ms of speech to trigger onset
    end_silence_ms: int = 800  # trailing silence that ends an utterance
    preroll_ms: int = 300  # audio kept from before the onset
    no_speech_timeout_ms: int = 6000
    max_utterance_ms: int = 30_000
    #: The first frames only measure the room (no onset), so a noisy room doesn't trigger instantly.
    calibration_ms: int = 210
    initial_noise_dbfs: float = -60.0


class Endpointer:
    """Energy-based voice activity endpointing over fixed 16 kHz int16 frames.

    The noise floor adapts (fast down, slow up) while nobody is speaking, so a fan or a
    noisy office raises the threshold instead of keeping the mic open forever.
    """

    def __init__(self, cfg: EndpointConfig | None = None) -> None:
        self.cfg = cfg or EndpointConfig()
        self.reset()

    def reset(self) -> None:
        c = self.cfg
        self.noise_dbfs = c.initial_noise_dbfs
        self.in_speech = False
        self.done = False
        self._run = 0
        self._silence_ms = 0
        self._elapsed_ms = 0
        self._speech_ms = 0
        self._preroll: deque[np.ndarray] = deque(maxlen=max(1, c.preroll_ms // c.frame_ms))
        self._frames: list[np.ndarray] = []

    def threshold_dbfs(self) -> float:
        return max(self.noise_dbfs + self.cfg.margin_db, self.cfg.min_speech_dbfs)

    def feed(self, frame: np.ndarray) -> EndpointEvent:
        if self.done:
            return EndpointEvent.NONE
        c = self.cfg
        self._elapsed_ms += c.frame_ms
        level = rms_dbfs(frame)
        loud = level > self.threshold_dbfs()

        if not self.in_speech:
            if self._elapsed_ms <= c.calibration_ms:
                # Calibrate: start from the first frame, then keep the quietest level seen.
                self.noise_dbfs = level if self._elapsed_ms == c.frame_ms else min(self.noise_dbfs, level)
                self._preroll.append(frame)
                return EndpointEvent.NONE
            if not loud:
                # Track the floor: drop quickly, rise slowly.
                alpha = 0.3 if level < self.noise_dbfs else 0.05
                self.noise_dbfs += alpha * (level - self.noise_dbfs)
            self._preroll.append(frame)
            self._run = self._run + 1 if loud else 0
            if self._run >= c.start_frames:
                self.in_speech = True
                self._frames = list(self._preroll)
                self._speech_ms = self._run * c.frame_ms
                self._silence_ms = 0
                return EndpointEvent.STARTED
            if self._elapsed_ms >= c.no_speech_timeout_ms:
                self.done = True
                return EndpointEvent.NO_SPEECH
            return EndpointEvent.NONE

        self._frames.append(frame)
        if loud:
            self._silence_ms = 0
            self._speech_ms += c.frame_ms
        else:
            self._silence_ms += c.frame_ms
        if self._silence_ms >= c.end_silence_ms:
            self.done = True
            return EndpointEvent.ENDED
        if len(self._frames) * c.frame_ms >= c.max_utterance_ms:
            self.done = True
            return EndpointEvent.MAX_LENGTH
        return EndpointEvent.NONE

    def utterance(self) -> np.ndarray:
        """The captured utterance (pre-roll included, most of the trailing silence trimmed)."""
        if not self._frames:
            return np.zeros(0, dtype=np.int16)
        keep_tail = max(0, len(self._frames) - max(0, self._silence_ms - 200) // self.cfg.frame_ms)
        return np.concatenate(self._frames[:keep_tail] or self._frames).astype(np.int16)

    @property
    def speech_ms(self) -> int:
        return self._speech_ms


# --------------------------------------------------------------------------- sounds


def chime_wav(sample_rate: int = TARGET_RATE) -> bytes:
    """A short two-note attention chime (~0.35 s) as a WAV file."""
    parts = []
    for freq, dur in ((880.0, 0.14), (1318.5, 0.2)):
        t = np.arange(int(sample_rate * dur)) / sample_rate
        env = np.minimum(1.0, np.minimum(t / 0.01, (dur - t) / 0.05))
        parts.append(0.35 * np.sin(2 * np.pi * freq * t) * env)
    return encode_wav(float_to_pcm16(np.concatenate(parts).astype(np.float32)), sample_rate)


def wav_bytes_duration(data: bytes) -> float:
    try:
        return decode_wav(data).duration_s
    except WavFormatError:
        return 0.0


__all__ = [
    "TARGET_RATE",
    "FRAME_SAMPLES",
    "EndpointConfig",
    "EndpointEvent",
    "Endpointer",
    "FrameAssembler",
    "WavAudio",
    "WavFormatError",
    "chime_wav",
    "decode_wav",
    "encode_wav",
    "float_to_pcm16",
    "mic_to_pcm16",
    "pcm16_to_float",
    "resample_linear",
    "rms_dbfs",
    "to_mono_float",
    "wav_bytes_duration",
]
