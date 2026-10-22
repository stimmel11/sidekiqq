// LED + haptic output. Patterns come from lib/core/ui_patterns; this maps them onto pins.
#pragma once

#include <stdint.h>

#include "ui_patterns.h"

namespace ui {

void begin();
void update(uint32_t nowMs);

// Steady LED mode (Advertising, Connected, Listening, Thinking, LowBattery, Off).
void setMode(sidekiqq::LedMode mode, uint32_t nowMs);
sidekiqq::LedMode mode();

// One-shot LED overlay (Error, Status) that returns to the steady mode when done.
void flash(sidekiqq::LedMode overlay, uint32_t nowMs, uint8_t statusBlinks = 0);

void haptic(const sidekiqq::HapticPattern& p, uint32_t nowMs);

// True while an overlay or haptic pattern is still playing (don't deep-sleep mid-buzz).
bool busy();

// All outputs off and pins parked low (before deep sleep).
void shutdown();

}  // namespace ui
