package com.sidekiqq.watch.audio

import com.sidekiqq.shared.audio.WavEncoder

/** The single call site for the shared WavEncoder (44-byte RIFF header, PCM16 LE). */
object WavAdapter {
    fun toWav(pcm16Mono: ByteArray, sampleRate: Int): ByteArray =
        WavEncoder.encode(pcm16Mono, sampleRate = sampleRate, channels = 1)
}
