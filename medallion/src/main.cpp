// SideKiqq medallion firmware: push-to-talk BLE microphone for the SideKiqq phone app.
//
// Protocol: lib/core/src/protocol.h (mirrors MedallionProtocol.kt / ARCHITECTURE.md).
// Pins and tunables: include/config.h. Hardware guide: HARDWARE.md.
//
// Loop responsibilities (everything here runs on the Arduino loop task, core 1):
//   button state machine -> CONTROL 0x01/0x02/0x03 and the mic task
//   mic packet queue     -> AUDIO notifications (with back-pressure)
//   phone CONTROL writes -> LED pulse / haptics
//   battery sampling, LED + haptic rendering, advertising, deep-sleep policy
#include <Arduino.h>

#include "audio_capture.h"
#include "audio_framer.h"
#include "battery.h"
#include "ble_link.h"
#include "config.h"
#include "power.h"
#include "power_policy.h"
#include "protocol.h"
#include "ptt_button.h"
#include "ui.h"
#include "ui_patterns.h"

using namespace sidekiqq;

namespace {

enum class Session : uint8_t { Idle, Streaming, Draining };

Session g_session = Session::Idle;
PttButton g_ptt;
BatteryFilter g_battery;
PowerPolicyConfig g_powerCfg;

uint8_t g_batteryPct = 100;
bool g_batteryKnown = false;
uint32_t g_lastBatteryAt = 0;
uint32_t g_lastActivity = 0;
uint32_t g_drainDeadline = 0;
bool g_thinking = false;
uint32_t g_thinkingSince = 0;
uint32_t g_linkEpoch = 0;

bool buttonRaw() { return digitalRead(PIN_BUTTON) == (BUTTON_ACTIVE_LOW ? LOW : HIGH); }

bool batteryLow() { return g_batteryKnown && g_batteryPct <= BATTERY_LOW_PCT; }

void sampleBattery(bool notify) {
  const uint32_t mv = power::readBatteryMv();
  if (mv == 0) {
    // No cell or no divider fitted (e.g. bench testing on USB): report "full".
    g_batteryKnown = false;
    g_batteryPct = 100;
  } else {
    g_batteryKnown = true;
    const uint8_t pct = g_battery.addSampleMv(mv);
    if (pct != g_batteryPct) {
      g_batteryPct = pct;
      ble::setBattery(pct, notify);
    }
    return;
  }
  ble::setBattery(g_batteryPct, notify);
}

LedMode steadyLedMode() {
  if (g_session != Session::Idle) return LedMode::Listening;
  if (g_thinking) return LedMode::Thinking;
  if (batteryLow()) return LedMode::LowBattery;
  return ble::connected() ? LedMode::Connected : LedMode::Advertising;
}

void startUtterance(uint32_t now) {
  if (!ble::readyForAudio()) {
    log_w("PTT pressed but the phone is not connected/subscribed");
    ui::flash(LedMode::Error, now);
    ui::haptic(haptics::kError, now);
    return;
  }
  g_thinking = false;
  ble::requestFastLink(true);
  if (!ble::sendControl(proto::kCtrlStart)) {
    ui::flash(LedMode::Error, now);
    return;
  }
  const size_t packet = AudioFramer::packetSizeForMtu(ble::mtu());
  audio::start(packet);
  g_session = Session::Streaming;
  if (HAPTIC_ON_START) ui::haptic(haptics::kTick, now);  // shorter than MIC_WARMUP_MS
  log_i("utterance start (packet %u B, MTU %u)", (unsigned)packet, ble::mtu());
}

void endUtterance(uint32_t now) {
  if (g_session != Session::Streaming) return;
  audio::stop(/*flush=*/true);
  g_session = Session::Draining;  // END goes out once the queued audio has been sent
  g_drainDeadline = now + END_DRAIN_TIMEOUT_MS;
}

void cancelUtterance(bool notifyPhone) {
  if (g_session == Session::Idle) return;
  audio::stop(/*flush=*/false);
  if (notifyPhone) ble::sendControl(proto::kCtrlCancel);
  g_session = Session::Idle;
  ble::requestFastLink(false);
  log_i("utterance cancelled");
}

void pumpAudio(uint32_t now) {
  audio::Packet pkt;
  for (int i = 0; i < 16 && audio::peek(&pkt); ++i) {
    if (!ble::sendAudio(pkt.data, pkt.len)) break;  // out of buffers: retry next loop
    audio::pop();
  }
  if (g_session == Session::Draining &&
      (audio::queued() == 0 || static_cast<int32_t>(now - g_drainDeadline) >= 0)) {
    if (audio::queued() > 0) log_w("drain timeout, %u packets dropped", (unsigned)audio::queued());
    audio::stop(/*flush=*/false);  // clears anything left
    ble::sendControl(proto::kCtrlEnd);
    g_session = Session::Idle;
    ble::requestFastLink(false);
    log_i("utterance end (%u packets dropped in capture)", (unsigned)audio::dropped());
  }
}

void handlePhoneControl(uint32_t now) {
  uint8_t op;
  while (ble::pollControl(&op)) {
    g_lastActivity = now;
    switch (proto::decodeControlWrite(&op, 1)) {
      case proto::ControlCommand::Thinking:
        g_thinking = true;
        g_thinkingSince = now;
        break;
      case proto::ControlCommand::ReplyDelivered:
        g_thinking = false;
        ui::haptic(haptics::kShort, now);
        break;
      case proto::ControlCommand::NeedsAttention:
        ui::haptic(haptics::kDouble, now);
        break;
      case proto::ControlCommand::Unknown:
        log_d("ignoring CONTROL write 0x%02x", op);
        break;
    }
  }
  if (g_thinking && now - g_thinkingSince > THINKING_TIMEOUT_MS) g_thinking = false;
}

void handleButton(uint32_t now) {
  const PttEvent ev = g_ptt.update(buttonRaw(), now);
  if (ev == PttEvent::None) return;
  g_lastActivity = now;
  log_d("ptt: %s", pttEventName(ev));
  switch (ev) {
    case PttEvent::Start:
      if (g_session == Session::Idle) startUtterance(now);
      break;
    case PttEvent::End:
      endUtterance(now);
      break;
    case PttEvent::Cancel:
      cancelUtterance(/*notifyPhone=*/true);
      break;
    case PttEvent::Status:
      ui::flash(LedMode::Status, now, batteryStatusBlinks(g_batteryPct));
      break;
    case PttEvent::None:
      break;
  }
}

void handleLinkChanges(uint32_t now) {
  const uint32_t epoch = ble::linkEpoch();
  if (epoch == g_linkEpoch) return;
  g_linkEpoch = epoch;
  g_lastActivity = now;  // the disconnected-sleep timer starts at the drop
  // Any utterance in flight is lost; the phone cancels its assembler on disconnect too.
  cancelUtterance(/*notifyPhone=*/false);
  g_ptt.abort();
  g_thinking = false;
  if (ble::connected()) ble::setBattery(g_batteryPct, false);
}

void checkPower(uint32_t now) {
  const bool busy = g_session != Session::Idle || g_thinking || ui::busy() || g_ptt.talking() ||
                    g_ptt.pressed();
  const uint32_t mv = g_batteryKnown ? g_battery.filteredMv() : 0;
  const PowerAction act = decidePower(g_powerCfg, ble::connected(), busy, now - g_lastActivity, mv);
  if (act == PowerAction::Stay) return;
  ui::shutdown();
  power::deepSleep(act == PowerAction::DeepSleepLowBattery ? "battery critical" : "idle");
}

}  // namespace

void setup() {
  Serial.begin(115200);
  power::begin();
  ui::begin();
  const uint32_t now = millis();
  log_i("SideKiqq medallion %s (wake by button: %d)", FIRMWARE_VERSION, power::wokeByButton());

  g_powerCfg.disconnectedSleepMs = SLEEP_DISCONNECTED_MS;
  g_powerCfg.connectedIdleSleepMs = SLEEP_CONNECTED_IDLE_MS;
  g_powerCfg.criticalMv = BATTERY_CRITICAL_MV;

  sampleBattery(false);
  g_lastBatteryAt = now;
  if (g_batteryKnown && g_battery.filteredMv() < BATTERY_CRITICAL_MV) {
    // Too flat to run the radio: show it and go back to sleep.
    ui::flash(LedMode::LowBattery, now);
    const uint32_t t0 = millis();
    while (millis() - t0 < 1500) { ui::setMode(LedMode::LowBattery, millis()); ui::update(millis()); delay(10); }
    ui::shutdown();
    power::deepSleep("battery critical at boot");
  }

  ble::begin(g_batteryPct);
  if (!audio::begin()) log_e("microphone init failed");

  PttConfig cfg;
  cfg.mode = PTT_MODE == 1 ? PttMode::Toggle : PttMode::Hold;
  cfg.debounceMs = PTT_DEBOUNCE_MS;
  cfg.minTalkMs = PTT_MIN_TALK_MS;
  cfg.longPressMs = PTT_LONG_PRESS_MS;
  cfg.maxUtteranceMs = PTT_MAX_UTTERANCE_MS;
  // The press that woke us from deep sleep is ignored until released (the link is not up yet).
  g_ptt.begin(cfg, buttonRaw(), now);

  g_lastActivity = now;
  g_linkEpoch = ble::linkEpoch();
  if (power::wokeByButton()) ui::haptic(haptics::kTick, now);
}

void loop() {
  const uint32_t now = millis();

  handleLinkChanges(now);
  handlePhoneControl(now);
  handleButton(now);
  if (g_session != Session::Idle) pumpAudio(now);

  if (g_session == Session::Idle && now - g_lastBatteryAt >= BATTERY_PERIOD_MS) {
    g_lastBatteryAt = now;
    sampleBattery(true);
  }

  ui::setMode(steadyLedMode(), now);
  ui::update(now);
  ble::loop(now);
  checkPower(now);

  // Streaming produces a packet every ~7.4 ms; idle loops can yield longer.
  delay(g_session == Session::Idle ? LOOP_IDLE_DELAY_MS : 1);
}
