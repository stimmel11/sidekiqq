// When to put the medallion into deep sleep. Pure C++.
//
// Deep sleep drops the BLE link (the radio is off); the button wakes the chip, it re-advertises
// and the phone's MedallionService reconnects (autoConnect to the known device, else rescan).
#pragma once

#include <stdint.h>

namespace sidekiqq {

struct PowerPolicyConfig {
  uint32_t disconnectedSleepMs = 5UL * 60UL * 1000UL;   // advertising with no phone
  uint32_t connectedIdleSleepMs = 60UL * 60UL * 1000UL; // connected but untouched; 0 = never
  uint32_t criticalMv = 3350;                           // protect the cell below this
  uint32_t noBatteryBelowMv = 2500;                     // readings below = no cell / no divider
};

enum class PowerAction : uint8_t { Stay = 0, DeepSleep, DeepSleepLowBattery };

// `busy`: streaming, draining, thinking, or a haptic/LED pattern still playing.
// `idleMs`: time since the last button activity or phone CONTROL write.
// `batteryMv`: filtered battery voltage, 0 if not measured yet.
PowerAction decidePower(const PowerPolicyConfig& cfg, bool connected, bool busy, uint32_t idleMs,
                        uint32_t batteryMv);

}  // namespace sidekiqq
