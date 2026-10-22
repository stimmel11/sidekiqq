#include "battery.h"

namespace sidekiqq {

namespace {
struct Point {
  uint16_t mv;
  uint8_t pct;
};
// Typical 1S LiPo discharge at low (~C/10) load. Descending voltage.
constexpr Point kCurve[] = {
    {4200, 100}, {4150, 95}, {4110, 90}, {4080, 85}, {4020, 80}, {3980, 70},
    {3950, 60},  {3910, 50}, {3870, 40}, {3850, 30}, {3840, 20}, {3820, 15},
    {3800, 10},  {3750, 5},  {3700, 3},  {3600, 1},  {3300, 0},
};
constexpr int kN = sizeof(kCurve) / sizeof(kCurve[0]);
}  // namespace

uint32_t dividerToBatteryMv(uint32_t adcMv, uint32_t rTopOhm, uint32_t rBottomOhm) {
  if (rBottomOhm == 0) return 0;
  // 64-bit to avoid overflow with large resistor values.
  return static_cast<uint32_t>(
      (static_cast<uint64_t>(adcMv) * (static_cast<uint64_t>(rTopOhm) + rBottomOhm) + rBottomOhm / 2) /
      rBottomOhm);
}

uint8_t lipoPercentFromMv(uint32_t mv) {
  if (mv >= kCurve[0].mv) return 100;
  if (mv <= kCurve[kN - 1].mv) return 0;
  for (int i = 1; i < kN; ++i) {
    if (mv >= kCurve[i].mv) {
      const Point hi = kCurve[i - 1];
      const Point lo = kCurve[i];
      const uint32_t span = hi.mv - lo.mv;
      const uint32_t num = (mv - lo.mv) * (hi.pct - lo.pct);
      return static_cast<uint8_t>(lo.pct + (num + span / 2) / span);
    }
  }
  return 0;
}

uint8_t BatteryFilter::addSampleMv(uint32_t batteryMv) {
  const int64_t sampleQ8 = static_cast<int64_t>(batteryMv) << 8;
  if (!primed_) {
    mvQ8_ = sampleQ8;
    primed_ = true;
    reported_ = lipoPercentFromMv(batteryMv);
    return reported_;
  }
  mvQ8_ += (sampleQ8 - mvQ8_) / (static_cast<int64_t>(1) << alphaShift_);
  const uint8_t pct = lipoPercentFromMv(filteredMv());
  const int diff = static_cast<int>(pct) - static_cast<int>(reported_);
  // Always allow reaching the ends of the scale so "100" and "0" are reported.
  if (diff > hysteresis_ || diff < -static_cast<int>(hysteresis_) || pct == 0 || pct == 100) {
    reported_ = pct;
  }
  return reported_;
}

}  // namespace sidekiqq
