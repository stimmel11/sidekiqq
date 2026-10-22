#include "audio_framer.h"

namespace sidekiqq {

size_t AudioFramer::packetSizeForMtu(uint16_t mtu) {
  size_t room = mtu > proto::kAttNotifyHeader ? mtu - proto::kAttNotifyHeader : 0;
  if (room > proto::kMaxAudioPacket) room = proto::kMaxAudioPacket;
  if (room < 3) room = 3;  // seq + one sample; ATT minimum MTU (23) gives 20 anyway
  size_t payload = (room - 1) & ~static_cast<size_t>(1);
  return payload + 1;
}

void AudioFramer::begin(size_t maxPacket) {
  if (maxPacket > proto::kMaxAudioPacket) maxPacket = proto::kMaxAudioPacket;
  if (maxPacket < 3) maxPacket = 3;
  payloadBytes_ = (maxPacket - 1) & ~static_cast<size_t>(1);
  fill_ = 0;
  seq_ = 0;
  emitted_ = 0;
}

size_t AudioFramer::push(const int16_t* samples, size_t count, EmitFn emit, void* ctx) {
  size_t packets = 0;
  for (size_t i = 0; i < count; ++i) {
    const uint16_t s = static_cast<uint16_t>(samples[i]);
    buf_[1 + fill_] = static_cast<uint8_t>(s & 0xFF);  // little-endian on the wire
    buf_[2 + fill_] = static_cast<uint8_t>(s >> 8);
    fill_ += 2;
    if (fill_ >= payloadBytes_) {
      emitPacket(emit, ctx);
      ++packets;
    }
  }
  return packets;
}

size_t AudioFramer::flush(EmitFn emit, void* ctx) {
  if (fill_ == 0) return 0;
  emitPacket(emit, ctx);
  return 1;
}

void AudioFramer::emitPacket(EmitFn emit, void* ctx) {
  buf_[0] = seq_;
  if (emit != nullptr) emit(buf_, fill_ + 1, ctx);
  seq_ = static_cast<uint8_t>(seq_ + 1);
  ++emitted_;
  fill_ = 0;
}

}  // namespace sidekiqq
