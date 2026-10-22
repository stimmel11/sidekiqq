// Single-cell LiPo voltage -> percent, plus ADC divider maths and smoothing. Pure C++.
#pragma once

#include <stdint.h>

namespace sidekiqq {

// Battery voltage (mV) from the ADC pin voltage across the bottom resistor of a divider.
uint32_t dividerToBatteryMv(uint32_t adcMv, uint32_t rTopOhm, uint32_t rBottomOhm);

// Resting/light-load 1S LiPo open-circuit curve, linearly interpolated. 0..100.
uint8_t lipoPercentFromMv(uint32_t batteryMv);

// Exponential moving average for millivolt readings with hysteresis on the reported percent,
// so the phone does not see the value bounce between two numbers.
class BatteryFilter {
 public:
  // alphaShift: new = old + (sample - old) >> alphaShift (3 => 1/8 weight per sample)
  explicit BatteryFilter(uint8_t alphaShift = 3, uint8_t hysteresisPct = 1)
      : alphaShift_(alphaShift), hysteresis_(hysteresisPct) {}

  // Returns the (possibly unchanged) percent to report.
  uint8_t addSampleMv(uint32_t batteryMv);

  bool primed() const { return primed_; }
  uint32_t filteredMv() const { return static_cast<uint32_t>(mvQ8_ >> 8); }
  uint8_t percent() const { return reported_; }

 private:
  uint8_t alphaShift_;
  uint8_t hysteresis_;
  bool primed_ = false;
  int64_t mvQ8_ = 0;  // millivolts * 256
  uint8_t reported_ = 0;
};

}  // namespace sidekiqq
