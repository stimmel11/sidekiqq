#include "power_policy.h"

namespace sidekiqq {

PowerAction decidePower(const PowerPolicyConfig& cfg, bool connected, bool busy, uint32_t idleMs,
                        uint32_t batteryMv) {
  if (busy) return PowerAction::Stay;
  const bool batteryPresent = batteryMv >= cfg.noBatteryBelowMv;
  if (batteryPresent && batteryMv < cfg.criticalMv) return PowerAction::DeepSleepLowBattery;
  if (!connected) {
    return idleMs >= cfg.disconnectedSleepMs ? PowerAction::DeepSleep : PowerAction::Stay;
  }
  if (cfg.connectedIdleSleepMs != 0 && idleMs >= cfg.connectedIdleSleepMs) return PowerAction::DeepSleep;
  return PowerAction::Stay;
}

}  // namespace sidekiqq
