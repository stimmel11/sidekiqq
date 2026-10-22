#include "ui_patterns.h"

namespace sidekiqq {

namespace {
const uint16_t kTickSteps[] = {25};
const uint16_t kShortSteps[] = {70};
const uint16_t kDoubleSteps[] = {70, 90, 70};
const uint16_t kErrorSteps[] = {40, 60, 40, 60, 40};

constexpr uint8_t kFull = 255;
constexpr uint8_t kDim = 40;

uint8_t blinkTrain(uint32_t t, uint8_t blinks, uint32_t onMs, uint32_t offMs, uint8_t level) {
  const uint32_t period = onMs + offMs;
  if (blinks == 0 || t >= period * blinks) return 0;
  return (t % period) < onMs ? level : 0;
}
}  // namespace

namespace haptics {
const HapticPattern kTick{kTickSteps, 1};
const HapticPattern kShort{kShortSteps, 1};
const HapticPattern kDouble{kDoubleSteps, 3};
const HapticPattern kError{kErrorSteps, 5};
}  // namespace haptics

void HapticSequencer::play(const HapticPattern& p, uint32_t nowMs) {
  p_ = p;
  start_ = nowMs;
  active_ = p.stepsMs != nullptr && p.count > 0;
}

bool HapticSequencer::isOn(uint32_t nowMs) {
  if (!active_) return false;
  uint32_t t = nowMs - start_;
  for (uint8_t i = 0; i < p_.count; ++i) {
    const uint32_t d = p_.stepsMs[i];
    if (d == 0) break;
    if (t < d) return (i % 2) == 0;
    t -= d;
  }
  active_ = false;
  return false;
}

uint8_t ledBrightness(LedMode mode, uint32_t t, uint8_t statusBlinks) {
  switch (mode) {
    case LedMode::Off:
      return 0;
    case LedMode::Advertising:
      return (t % 2000) < 60 ? kFull : 0;
    case LedMode::Connected:
      return (t % 10000) < 30 ? kDim : 0;
    case LedMode::Listening:
      return kFull;
    case LedMode::Thinking: {
      // Triangle "breathing" wave, 1.2 s period, never fully dark, squared for a
      // perceptually smoother ramp.
      const uint32_t period = 1200;
      const uint32_t phase = t % period;
      const uint32_t half = period / 2;
      const uint32_t tri = phase < half ? phase : period - phase;  // 0..600
      const uint32_t lin = 20 + (tri * 235) / half;                // 20..255
      return static_cast<uint8_t>((lin * lin) / 255);
    }
    case LedMode::Error:
      return blinkTrain(t, 3, 80, 80, kFull);
    case LedMode::LowBattery: {
      const uint32_t p = t % 4000;
      return blinkTrain(p, 2, 60, 120, kFull);
    }
    case LedMode::Status:
      return blinkTrain(t, statusBlinks, 200, 250, kFull);
  }
  return 0;
}

uint32_t ledModeDurationMs(LedMode mode, uint8_t statusBlinks) {
  switch (mode) {
    case LedMode::Error:  return 3 * 160;
    case LedMode::Status: return static_cast<uint32_t>(statusBlinks) * 450 + 300;
    default:              return 0;
  }
}

uint8_t batteryStatusBlinks(uint8_t percent) {
  if (percent > 75) return 4;
  if (percent > 50) return 3;
  if (percent > 25) return 2;
  return 1;
}

}  // namespace sidekiqq
