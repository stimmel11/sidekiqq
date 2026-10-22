// Splits a PCM16 sample stream into AUDIO notifications: [seq:uint8][PCM16 LE ...].
//
// - Packet size is min(240, mtu - 3) bytes including the sequence byte (see protocol.h).
// - The payload is always a whole number of samples (even byte count), so a lost packet never
//   shifts the phone's sample alignment. With MTU 247 that is 1 + 238 bytes = 119 samples.
// - The sequence counter starts at 0 for every utterance and wraps 255 -> 0, which is exactly
//   what UtteranceAssembler.kt expects (it takes the first packet as its baseline anyway).
// - The counter advances for every packet produced, even if the caller later fails to deliver
//   it, so the phone sees a gap and pads silence instead of silently shifting time.
//
// Pure C++ (no Arduino) so it is unit-tested natively.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

namespace sidekiqq {

class AudioFramer {
 public:
  // Called once per complete packet. `pkt` is only valid during the call.
  using EmitFn = void (*)(const uint8_t* pkt, size_t len, void* ctx);

  // Packet size (including the seq byte) for a negotiated ATT MTU.
  static size_t packetSizeForMtu(uint16_t mtu);

  explicit AudioFramer(size_t maxPacket = proto::kMaxAudioPacket) { begin(maxPacket); }

  // Starts a new utterance: clears pending samples, resets seq to 0, sets the packet size.
  void begin(size_t maxPacket);

  // Appends samples; emits every packet that fills up. Returns packets emitted.
  size_t push(const int16_t* samples, size_t count, EmitFn emit, void* ctx);

  // Emits the partially filled packet, if any. Returns packets emitted (0 or 1).
  size_t flush(EmitFn emit, void* ctx);

  size_t packetSize() const { return payloadBytes_ + 1; }
  size_t payloadBytes() const { return payloadBytes_; }
  size_t pendingBytes() const { return fill_; }
  uint8_t nextSeq() const { return seq_; }
  uint32_t packetsEmitted() const { return emitted_; }

 private:
  void emitPacket(EmitFn emit, void* ctx);

  uint8_t buf_[proto::kMaxAudioPacket];
  size_t payloadBytes_ = 0;
  size_t fill_ = 0;  // payload bytes currently in buf_[1..]
  uint8_t seq_ = 0;
  uint32_t emitted_ = 0;
};

}  // namespace sidekiqq
