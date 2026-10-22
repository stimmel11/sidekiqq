import numpy as np
import pytest

from sidekiqq_reachy.audio import (
    FRAME_SAMPLES,
    EndpointConfig,
    EndpointEvent,
    Endpointer,
    FrameAssembler,
    WavFormatError,
    chime_wav,
    decode_wav,
    encode_wav,
    mic_to_pcm16,
    resample_linear,
    rms_dbfs,
    wav_bytes_duration,
)

RATE = 16_000


def tone(seconds: float, amp: float = 0.3, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(RATE * seconds)) / RATE
    return (amp * 32767 * np.sin(2 * np.pi * freq * t)).astype(np.int16)


def noise(seconds: float, amp: float = 0.002, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.normal(0, amp * 32767, int(RATE * seconds))).astype(np.int16)


def frames(pcm: np.ndarray) -> list[np.ndarray]:
    return FrameAssembler().push(pcm)


def run(ep: Endpointer, pcm: np.ndarray) -> list[EndpointEvent]:
    events = []
    for f in frames(pcm):
        ev = ep.feed(f)
        if ev is not EndpointEvent.NONE:
            events.append(ev)
    return events


# ---------------------------------------------------------------- WAV framing


def test_encode_wav_header_is_the_brain_contract():
    wav = encode_wav(np.zeros(RATE, dtype=np.int16))
    assert wav[:4] == b"RIFF" and wav[8:16] == b"WAVEfmt "
    assert len(wav) == 44 + RATE * 2
    assert int.from_bytes(wav[4:8], "little") == 36 + RATE * 2
    assert int.from_bytes(wav[20:22], "little") == 1  # PCM
    assert int.from_bytes(wav[22:24], "little") == 1  # mono
    assert int.from_bytes(wav[24:28], "little") == 16000
    assert int.from_bytes(wav[28:32], "little") == 32000  # byte rate
    assert int.from_bytes(wav[34:36], "little") == 16  # bits
    assert wav[36:40] == b"data" and int.from_bytes(wav[40:44], "little") == RATE * 2


def test_wav_roundtrip_and_duration():
    pcm = tone(0.5)
    out = decode_wav(encode_wav(pcm, 24_000))
    assert out.sample_rate == 24_000 and out.channels == 1
    np.testing.assert_array_equal(out.samples, pcm)
    assert out.duration_s == pytest.approx(0.5 * RATE / 24_000)


def test_decode_tolerates_streamed_size_and_extra_chunks():
    pcm = tone(0.1)
    wav = bytearray(encode_wav(pcm))
    wav[40:44] = (0xFFFFFFFF).to_bytes(4, "little")
    assert decode_wav(bytes(wav)).samples.size == pcm.size
    # LIST chunk between fmt and data
    base = encode_wav(pcm)
    with_list = base[:36] + b"LIST" + (4).to_bytes(4, "little") + b"INFO" + base[36:]
    assert decode_wav(with_list).samples.size == pcm.size


def test_decode_rejects_garbage():
    with pytest.raises(WavFormatError):
        decode_wav(b"hello" * 20)
    assert wav_bytes_duration(b"nope") == 0.0


def test_mic_conversion_stereo_float_to_16k_int16():
    # SDK mic chunks are float32 (n, 2) at the input rate.
    stereo = np.stack([np.full(480, 0.5, np.float32), np.full(480, 0.0, np.float32)], axis=1)
    out = mic_to_pcm16(stereo, 16_000)
    assert out.dtype == np.int16 and out.shape == (480,)
    assert out[0] == round(0.25 * 32767)
    # 48 kHz input is resampled to 16 kHz
    assert mic_to_pcm16(np.zeros((4800, 2), np.float32), 48_000).shape == (1600,)
    assert resample_linear(np.ones(10, np.float32), 16_000, 16_000).shape == (10,)


def test_frame_assembler_rechunks():
    fa = FrameAssembler()
    assert fa.push(np.zeros(300, np.int16)) == []
    out = fa.push(np.zeros(700, np.int16))
    assert [f.size for f in out] == [FRAME_SAMPLES, FRAME_SAMPLES]
    assert fa.push(np.zeros(FRAME_SAMPLES - 40, np.int16))[0].size == FRAME_SAMPLES


def test_rms_dbfs():
    assert rms_dbfs(np.zeros(480, np.int16)) == pytest.approx(-120.0)
    assert rms_dbfs(np.full(480, 32767, np.int16)) == pytest.approx(0.0, abs=0.01)


# ---------------------------------------------------------------- endpointing


def test_endpointer_detects_an_utterance_and_keeps_preroll():
    ep = Endpointer()
    pcm = np.concatenate([noise(1.0), tone(1.2), noise(1.2)])
    events = run(ep, pcm)
    assert events == [EndpointEvent.STARTED, EndpointEvent.ENDED]
    utt = ep.utterance()
    dur = utt.size / RATE
    assert 1.2 <= dur <= 1.2 + 0.3 + 0.3  # speech + preroll + a little tail
    assert ep.speech_ms >= 1100


def test_endpointer_times_out_on_silence_and_ignores_room_noise():
    ep = Endpointer(EndpointConfig(no_speech_timeout_ms=2000))
    assert run(ep, noise(3.0, amp=0.01)) == [EndpointEvent.NO_SPEECH]
    assert ep.utterance().size == 0


def test_endpointer_ignores_a_short_click():
    ep = Endpointer(EndpointConfig(no_speech_timeout_ms=3000))
    click = np.concatenate([noise(0.5), tone(0.04, amp=0.8), noise(3.0)])
    assert run(ep, click) == [EndpointEvent.NO_SPEECH]


def test_endpointer_adapts_to_a_loud_but_steady_room():
    ep = Endpointer()
    loud_room = noise(1.5, amp=0.03, seed=1)
    speech = tone(1.0, amp=0.5)
    events = run(ep, np.concatenate([loud_room, speech + noise(1.0, amp=0.03, seed=2), noise(1.5, amp=0.03, seed=3)]))
    assert events == [EndpointEvent.STARTED, EndpointEvent.ENDED]


def test_endpointer_short_pause_does_not_end_the_utterance():
    ep = Endpointer()
    pcm = np.concatenate([noise(0.5), tone(0.6), noise(0.4), tone(0.6), noise(1.2)])
    assert run(ep, pcm) == [EndpointEvent.STARTED, EndpointEvent.ENDED]
    assert ep.utterance().size / RATE > 1.5


def test_endpointer_caps_length():
    ep = Endpointer(EndpointConfig(max_utterance_ms=2000))
    assert run(ep, np.concatenate([noise(0.3), tone(5.0)])) == [EndpointEvent.STARTED, EndpointEvent.MAX_LENGTH]
    assert ep.utterance().size / RATE == pytest.approx(2.0, abs=0.05)
    assert ep.feed(np.zeros(FRAME_SAMPLES, np.int16)) is EndpointEvent.NONE  # done


def test_chime_is_short_valid_wav():
    w = decode_wav(chime_wav())
    assert 0.2 < w.duration_s < 0.5 and w.samples.dtype == np.int16
