#include "audio_dsp.h"

namespace sidekiqq {

void DcBlockGain::process(int16_t* samples, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    const int32_t x = samples[i];
    // y in Q15 to keep precision in the feedback path.
    const int64_t yQ15 = static_cast<int64_t>(x - x1_) * 32768 + ((y1Q15_ * kRQ15) >> 15);
    x1_ = x;
    y1Q15_ = yQ15;
    const int64_t y = yQ15 / 32768;
    samples[i] = saturate16(static_cast<int32_t>((y * gainQ8_) >> 8));
  }
}

}  // namespace sidekiqq
