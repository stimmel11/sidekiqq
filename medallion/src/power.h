// CPU clocking, battery measurement, deep sleep with button wake.
#pragma once

#include <stdint.h>

namespace power {

void begin();

// True if this boot is a wake from deep sleep by the PTT button.
bool wokeByButton();

// Averaged battery voltage in mV (0 if the reading is implausible: no cell / no divider).
uint32_t readBatteryMv();

// Never returns. Waits for the button to be released, parks outputs, arms ext0 wake on the
// button and enters deep sleep. Caller shuts the UI down first.
[[noreturn]] void deepSleep(const char* reason);

}  // namespace power
