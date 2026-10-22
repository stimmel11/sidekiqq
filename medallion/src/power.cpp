#include "power.h"

#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/rtc_io.h>
#include <esp_sleep.h>
#include <sdkconfig.h>

#if CONFIG_PM_ENABLE
#include <esp_pm.h>
#endif

#include "battery.h"
#include "config.h"

namespace power {
namespace {
bool g_wokeByButton = false;

bool buttonPressed() { return digitalRead(PIN_BUTTON) == (BUTTON_ACTIVE_LOW ? LOW : HIGH); }
}  // namespace

void begin() {
  setCpuFrequencyMhz(CPU_FREQ_MHZ);

  const esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  g_wokeByButton = cause == ESP_SLEEP_WAKEUP_EXT0;
  if (cause != ESP_SLEEP_WAKEUP_UNDEFINED) {
    // Back from deep sleep: release the pin holds so LEDC can drive the pins again, and hand
    // the button back from the RTC domain to the digital GPIO matrix.
    gpio_hold_dis(static_cast<gpio_num_t>(PIN_LED));
    gpio_hold_dis(static_cast<gpio_num_t>(PIN_HAPTIC));
    gpio_deep_sleep_hold_dis();
    rtc_gpio_deinit(static_cast<gpio_num_t>(PIN_BUTTON));
  }
  pinMode(PIN_BUTTON, BUTTON_ACTIVE_LOW ? INPUT_PULLUP : INPUT_PULLDOWN);

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_BATTERY_ADC, ADC_11db);  // 0..~3.1 V; divider puts 4.2 V at 2.1 V

#if CONFIG_PM_ENABLE
  // Only active with a custom sdkconfig (stock Arduino-ESP32 2.0.x ships with PM disabled).
  // With CONFIG_FREERTOS_USE_TICKLESS_IDLE + CONFIG_BT_CTRL_MODEM_SLEEP this gives automatic
  // light sleep between BLE connection events.
  esp_pm_config_esp32s3_t pm = {};
  pm.max_freq_mhz = CPU_FREQ_MHZ;
  pm.min_freq_mhz = 40;
  pm.light_sleep_enable = true;
  if (esp_pm_configure(&pm) != ESP_OK) {
    pm.light_sleep_enable = false;
    esp_pm_configure(&pm);
    log_w("automatic light sleep unavailable; DFS only");
  }
#endif
}

bool wokeByButton() { return g_wokeByButton; }

uint32_t readBatteryMv() {
  uint32_t sum = 0;
  for (int i = 0; i < BATTERY_SAMPLES; ++i) sum += analogReadMilliVolts(PIN_BATTERY_ADC);
  const uint32_t adcMv = sum / BATTERY_SAMPLES;
  const uint32_t mv = sidekiqq::dividerToBatteryMv(adcMv, BATTERY_R_TOP_OHM, BATTERY_R_BOTTOM_OHM);
  return (mv < 2500 || mv > 4500) ? 0 : mv;
}

void deepSleep(const char* reason) {
  log_i("deep sleep: %s", reason);

  // A still-held button would wake us immediately.
  const uint32_t t0 = millis();
  while (buttonPressed() && millis() - t0 < 10000) delay(10);

  // Park outputs low and hold them through deep sleep (no LED glow, motor gate off).
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LED_ACTIVE_LOW ? HIGH : LOW);
  pinMode(PIN_HAPTIC, OUTPUT);
  digitalWrite(PIN_HAPTIC, LOW);
  gpio_hold_en(static_cast<gpio_num_t>(PIN_LED));
  gpio_hold_en(static_cast<gpio_num_t>(PIN_HAPTIC));
  gpio_deep_sleep_hold_en();

  const gpio_num_t btn = static_cast<gpio_num_t>(PIN_BUTTON);
  rtc_gpio_init(btn);
  rtc_gpio_set_direction(btn, RTC_GPIO_MODE_INPUT_ONLY);
  if (BUTTON_ACTIVE_LOW) {
    rtc_gpio_pullup_en(btn);
    rtc_gpio_pulldown_dis(btn);
  } else {
    rtc_gpio_pulldown_en(btn);
    rtc_gpio_pullup_dis(btn);
  }
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);  // keep the RTC pull-up alive
  esp_sleep_enable_ext0_wakeup(btn, BUTTON_ACTIVE_LOW ? 0 : 1);

  Serial.flush();
  esp_deep_sleep_start();
}

}  // namespace power
