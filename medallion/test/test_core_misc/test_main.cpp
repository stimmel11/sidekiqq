// Battery, DSP, UI pattern and power-policy tests.
#include <unity.h>

#include "audio_dsp.h"
#include "battery.h"
#include "power_policy.h"
#include "ui_patterns.h"

using namespace sidekiqq;

void setUp() {}
void tearDown() {}

// ------------------------------------------------------------------ battery

void test_divider_math() {
  TEST_ASSERT_EQUAL(4200, dividerToBatteryMv(2100, 220000, 220000));
  TEST_ASSERT_EQUAL(3000, dividerToBatteryMv(1000, 200000, 100000));
  TEST_ASSERT_EQUAL(0, dividerToBatteryMv(1000, 100000, 0));
}

void test_lipo_curve_endpoints_and_monotonic() {
  TEST_ASSERT_EQUAL(100, lipoPercentFromMv(4300));
  TEST_ASSERT_EQUAL(100, lipoPercentFromMv(4200));
  TEST_ASSERT_EQUAL(0, lipoPercentFromMv(3300));
  TEST_ASSERT_EQUAL(0, lipoPercentFromMv(3000));
  TEST_ASSERT_EQUAL(50, lipoPercentFromMv(3910));
  TEST_ASSERT_EQUAL(55, lipoPercentFromMv(3930));  // interpolated between 3910/50 and 3950/60
  uint8_t prev = 0;
  for (uint32_t mv = 3000; mv <= 4300; mv += 5) {
    const uint8_t p = lipoPercentFromMv(mv);
    TEST_ASSERT_TRUE(p >= prev);
    TEST_ASSERT_TRUE(p <= 100);
    prev = p;
  }
}

void test_battery_filter_smooths_and_hysteresis() {
  BatteryFilter f(3, 1);
  TEST_ASSERT_EQUAL(50, f.addSampleMv(3910));  // first sample primes
  // A single noisy sample barely moves the filtered value; reported percent stays put.
  TEST_ASSERT_EQUAL(50, f.addSampleMv(3950));
  // Sustained change converges.
  for (int i = 0; i < 60; ++i) f.addSampleMv(4020);
  // 4020 mV = 80 %; the 1 % hysteresis may hold it one step short.
  TEST_ASSERT_UINT8_WITHIN(1, 80, f.percent());
  TEST_ASSERT_UINT32_WITHIN(3, 4020, f.filteredMv());
}

// ------------------------------------------------------------------ DSP

void test_dc_blocker_removes_offset() {
  DcBlockGain dsp(256);
  int16_t buf[256];
  int16_t last = 0;
  for (int block = 0; block < 40; ++block) {  // 40 * 256 samples = 0.64 s
    for (auto& s : buf) s = 3000;
    dsp.process(buf, 256);
    last = buf[255];
  }
  TEST_ASSERT_INT_WITHIN(5, 0, last);
}

void test_gain_and_saturation() {
  DcBlockGain dsp(256 * 4);
  int16_t buf[2] = {10000, -20000};
  dsp.process(buf, 2);
  TEST_ASSERT_EQUAL(32767, buf[0]);   // 10000 * 4 saturates
  TEST_ASSERT_EQUAL(-32768, buf[1]);  // big negative step saturates too
}

void test_i2s32_conversion() {
  TEST_ASSERT_EQUAL(0x1234, i2s32ToPcm16(0x12340000, 16));
  TEST_ASSERT_EQUAL(-1, i2s32ToPcm16(static_cast<int32_t>(0xFFFF0000), 16));
  TEST_ASSERT_EQUAL(32767, i2s32ToPcm16(0x40000000, 14));  // +12 dB saturates
  TEST_ASSERT_EQUAL(0x48D0, i2s32ToPcm16(0x12340000, 14));
}

// ------------------------------------------------------------------ UI patterns

void test_haptic_short_and_double() {
  HapticSequencer h;
  h.play(haptics::kShort, 100);
  TEST_ASSERT_TRUE(h.isOn(100));
  TEST_ASSERT_TRUE(h.isOn(169));
  TEST_ASSERT_FALSE(h.isOn(170));
  TEST_ASSERT_FALSE(h.active());

  h.play(haptics::kDouble, 0);
  TEST_ASSERT_TRUE(h.isOn(10));    // first buzz
  TEST_ASSERT_FALSE(h.isOn(100));  // gap
  TEST_ASSERT_TRUE(h.isOn(170));   // second buzz
  TEST_ASSERT_FALSE(h.isOn(240));  // done
  TEST_ASSERT_FALSE(h.active());
}

void test_led_modes() {
  TEST_ASSERT_EQUAL(255, ledBrightness(LedMode::Listening, 12345));
  TEST_ASSERT_EQUAL(0, ledBrightness(LedMode::Off, 12345));
  // Thinking pulse: dim at the start of the period, full at mid-period, never off.
  const uint8_t lo = ledBrightness(LedMode::Thinking, 0);
  const uint8_t hi = ledBrightness(LedMode::Thinking, 600);
  TEST_ASSERT_TRUE(lo > 0);
  TEST_ASSERT_EQUAL(255, hi);
  for (uint32_t t = 0; t < 2400; t += 10) TEST_ASSERT_TRUE(ledBrightness(LedMode::Thinking, t) > 0);
  // Status gauge: exactly N blinks.
  int rising = 0;
  uint8_t prev = 0;
  for (uint32_t t = 0; t < ledModeDurationMs(LedMode::Status, 3); ++t) {
    const uint8_t v = ledBrightness(LedMode::Status, t, 3);
    if (v > 0 && prev == 0) ++rising;
    prev = v;
  }
  TEST_ASSERT_EQUAL(3, rising);
  TEST_ASSERT_EQUAL(1, batteryStatusBlinks(10));
  TEST_ASSERT_EQUAL(4, batteryStatusBlinks(100));
}

// ------------------------------------------------------------------ power policy

void test_power_policy() {
  PowerPolicyConfig c;
  c.disconnectedSleepMs = 300000;
  c.connectedIdleSleepMs = 3600000;
  c.criticalMv = 3350;
  // Busy always stays awake, even with a flat cell.
  TEST_ASSERT_TRUE(decidePower(c, false, true, 999999999, 3200) == PowerAction::Stay);
  // Disconnected: sleeps after the timeout.
  TEST_ASSERT_TRUE(decidePower(c, false, false, 299999, 3900) == PowerAction::Stay);
  TEST_ASSERT_TRUE(decidePower(c, false, false, 300000, 3900) == PowerAction::DeepSleep);
  // Connected: much longer idle timeout, or never when 0.
  TEST_ASSERT_TRUE(decidePower(c, true, false, 300000, 3900) == PowerAction::Stay);
  TEST_ASSERT_TRUE(decidePower(c, true, false, 3600000, 3900) == PowerAction::DeepSleep);
  c.connectedIdleSleepMs = 0;
  TEST_ASSERT_TRUE(decidePower(c, true, false, 999999999, 3900) == PowerAction::Stay);
  // Critical battery.
  TEST_ASSERT_TRUE(decidePower(c, true, false, 0, 3300) == PowerAction::DeepSleepLowBattery);
  // No cell / no divider (0 or implausibly low reading) never triggers the low-battery path.
  TEST_ASSERT_TRUE(decidePower(c, true, false, 0, 0) == PowerAction::Stay);
  TEST_ASSERT_TRUE(decidePower(c, true, false, 0, 1200) == PowerAction::Stay);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_divider_math);
  RUN_TEST(test_lipo_curve_endpoints_and_monotonic);
  RUN_TEST(test_battery_filter_smooths_and_hysteresis);
  RUN_TEST(test_dc_blocker_removes_offset);
  RUN_TEST(test_gain_and_saturation);
  RUN_TEST(test_i2s32_conversion);
  RUN_TEST(test_haptic_short_and_double);
  RUN_TEST(test_led_modes);
  RUN_TEST(test_power_policy);
  return UNITY_END();
}
