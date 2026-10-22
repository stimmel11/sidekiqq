#include "ui.h"

#include <Arduino.h>

#include "config.h"

#if HAPTIC_DRIVER == HAPTIC_DRIVER_DRV2605L
#include <Wire.h>
#endif

using namespace sidekiqq;

namespace ui {
namespace {

LedMode g_mode = LedMode::Off;
uint32_t g_modeSince = 0;
LedMode g_overlay = LedMode::Off;
bool g_overlayActive = false;
uint32_t g_overlaySince = 0;
uint8_t g_statusBlinks = 0;
uint8_t g_lastLed = 0xFF;

HapticSequencer g_seq;
bool g_motorOn = false;

void writeLed(uint8_t level) {
  if (level == g_lastLed) return;
  g_lastLed = level;
  ledcWrite(LED_PWM_CHANNEL, LED_ACTIVE_LOW ? 255 - level : level);
}

#if HAPTIC_DRIVER == HAPTIC_DRIVER_DRV2605L
// DRV2605L in real-time playback (RTP) mode: amplitude written to RTP_INPUT, so the same
// on/off sequencer drives it. Open-loop ERM (CONTROL3 default), clamp ~3.0 V.
constexpr uint8_t kDrvAddr = 0x5A;
bool g_drvOk = false;

void drvWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(kDrvAddr);
  Wire.write(reg);
  Wire.write(val);
  g_drvOk = Wire.endTransmission() == 0;
}

void motorBegin() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  drvWrite(0x01, 0x00);  // MODE: out of standby, internal trigger
  drvWrite(0x1A, 0x36);  // FEEDBACK: ERM (N_ERM_LRA = 0)
  drvWrite(0x17, 0x8B);  // OD_CLAMP ~3.0 V open-loop
  drvWrite(0x02, 0x00);  // RTP_INPUT = 0
  drvWrite(0x01, 0x05);  // MODE: real-time playback
  if (!g_drvOk) log_w("DRV2605L not responding on I2C");
}

void motorSet(bool on) { drvWrite(0x02, on ? 0x7F : 0x00); }

void motorShutdown() {
  drvWrite(0x02, 0x00);
  drvWrite(0x01, 0x40);  // STANDBY
}
#else
void motorBegin() {
  ledcSetup(HAPTIC_PWM_CHANNEL, HAPTIC_PWM_FREQ_HZ, HAPTIC_PWM_BITS);
  ledcAttachPin(PIN_HAPTIC, HAPTIC_PWM_CHANNEL);
  ledcWrite(HAPTIC_PWM_CHANNEL, 0);
}

void motorSet(bool on) { ledcWrite(HAPTIC_PWM_CHANNEL, on ? HAPTIC_DUTY : 0); }

void motorShutdown() {
  ledcWrite(HAPTIC_PWM_CHANNEL, 0);
  ledcDetachPin(PIN_HAPTIC);
  pinMode(PIN_HAPTIC, OUTPUT);
  digitalWrite(PIN_HAPTIC, LOW);
}
#endif

}  // namespace

void begin() {
  ledcSetup(LED_PWM_CHANNEL, LED_PWM_FREQ_HZ, LED_PWM_BITS);
  ledcAttachPin(PIN_LED, LED_PWM_CHANNEL);
  writeLed(0);
  motorBegin();
}

void setMode(LedMode mode, uint32_t nowMs) {
  if (mode == g_mode) return;
  g_mode = mode;
  g_modeSince = nowMs;
}

LedMode mode() { return g_mode; }

void flash(LedMode overlay, uint32_t nowMs, uint8_t statusBlinks) {
  g_overlay = overlay;
  g_overlaySince = nowMs;
  g_statusBlinks = statusBlinks;
  g_overlayActive = true;
}

void haptic(const HapticPattern& p, uint32_t nowMs) { g_seq.play(p, nowMs); }

void update(uint32_t nowMs) {
  uint8_t level;
  if (g_overlayActive &&
      static_cast<uint32_t>(nowMs - g_overlaySince) < ledModeDurationMs(g_overlay, g_statusBlinks)) {
    level = ledBrightness(g_overlay, nowMs - g_overlaySince, g_statusBlinks);
  } else {
    g_overlayActive = false;
    level = ledBrightness(g_mode, nowMs - g_modeSince);
  }
  writeLed(level);

  const bool on = g_seq.isOn(nowMs);
  if (on != g_motorOn) {
    g_motorOn = on;
    motorSet(on);
  }
}

bool busy() { return g_overlayActive || g_seq.active(); }

void shutdown() {
  g_seq.stop();
  g_motorOn = false;
  motorShutdown();
  writeLed(0);
  ledcDetachPin(PIN_LED);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LED_ACTIVE_LOW ? HIGH : LOW);
}

}  // namespace ui
