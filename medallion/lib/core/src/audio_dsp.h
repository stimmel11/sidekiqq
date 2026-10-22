// Tiny fixed-point audio helpers used between the I2S driver and the framer. Pure C++.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace sidekiqq {

inline int16_t saturate16(int32_t v) {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return static_cast<int16_t>(v);
}

// INMP441 / SPH0645-style I2S mics deliver 24-bit samples left-justified in a 32-bit slot.
// `shift` picks the 16 bits we keep (16 = top 16 bits, smaller = more gain).
inline int16_t i2s32ToPcm16(int32_t raw, uint8_t shift) {
  return saturate16(raw >> shift);
}

// One-pole DC-blocking high-pass (y[n] = x[n] - x[n-1] + R*y[n-1], R ~= 0.995 at 16 kHz,
// ~13 Hz corner) followed by a gain in Q8 (256 = x1) with saturation. PDM mics on the ESP32-S3
// show a noticeable DC offset and are quiet at arm's length, so both matter for Whisper.
class DcBlockGain {
 public:
  explicit DcBlockGain(uint16_t gainQ8 = 256) : gainQ8_(gainQ8) {}
  void reset() { x1_ = 0; y1Q15_ = 0; }
  void setGainQ8(uint16_t g) { gainQ8_ = g; }

  void process(int16_t* samples, size_t count);

 private:
  static constexpr int32_t kRQ15 = 32604;  // 0.995 * 32768
  uint16_t gainQ8_;
  int32_t x1_ = 0;
  int64_t y1Q15_ = 0;
};

}  // namespace sidekiqq
