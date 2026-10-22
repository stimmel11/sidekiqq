// Microphone capture task: I2S (PDM or standard) -> DC block + gain -> AudioFramer -> packet queue.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

namespace audio {

struct Packet {
  uint8_t len;
  uint8_t data[sidekiqq::proto::kMaxAudioPacket];
};

bool begin();

// Starts a new utterance with the given AUDIO packet size (incl. seq byte). Clears old packets.
void start(size_t packetSize);

// Stops capture. flush=true emits the last partial packet (END); flush=false discards
// everything still queued (CANCEL / link lost). Blocks until the capture task acknowledged.
void stop(bool flush);

bool capturing();

// Packet queue consumed by the BLE sender on the main loop.
bool peek(Packet* out);
void pop();
size_t queued();

// Packets dropped because the queue was full (the phone sees them as seq gaps).
uint32_t dropped();

}  // namespace audio
