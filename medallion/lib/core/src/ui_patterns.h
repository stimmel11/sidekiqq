// LED and haptic timing patterns. Pure C++: the firmware only maps the results onto PWM pins.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace sidekiqq {

// ---------------------------------------------------------------- haptics

// A haptic pattern is a list of on/off durations starting with "on":
// {on, off, on, off, ...}. A zero-length entry ends the pattern early.
struct HapticPattern {
  const uint16_t* stepsMs;
  uint8_t count;
};

namespace haptics {
extern const HapticPattern kTick;            // recording started
extern const HapticPattern kShort;           // 0x11 reply delivered
extern const HapticPattern kDouble;          // 0x12 needs attention
extern const HapticPattern kError;           // pressed while not connected
}  // namespace haptics

class HapticSequencer {
 public:
  void play(const HapticPattern& p, uint32_t nowMs);
  void stop() { active_ = false; }
  // True while the motor should be driven.
  bool isOn(uint32_t nowMs);
  bool active() const { return active_; }

 private:
  HapticPattern p_{nullptr, 0};
  uint32_t start_ = 0;
  bool active_ = false;
};

// ---------------------------------------------------------------- LED

enum class LedMode : uint8_t {
  Off,
  Advertising,     // short blink every 2 s: looking for the phone
  Connected,       // off (saves power); one faint blink every 10 s
  Listening,       // solid on while streaming audio
  Thinking,        // breathing pulse (phone sent 0x10)
  Error,           // 3 fast blinks, then back to the previous mode
  LowBattery,      // double blink every 4 s
  Status,          // battery gauge: 1-4 blinks
};

// Brightness 0..255 for a mode at `elapsedMs` since the mode was entered.
// `statusBlinks` is used by LedMode::Status only.
uint8_t ledBrightness(LedMode mode, uint32_t elapsedMs, uint8_t statusBlinks = 0);

// How long a one-shot mode lasts before the caller should return to the steady mode
// (0 = steady mode, never expires).
uint32_t ledModeDurationMs(LedMode mode, uint8_t statusBlinks = 0);

// 1..4 blinks for the battery gauge (<=25 % -> 1, ... >75 % -> 4).
uint8_t batteryStatusBlinks(uint8_t percent);

}  // namespace sidekiqq
