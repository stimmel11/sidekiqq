// SideKiqq medallion: ALL pin assignments and tunables live here.
// HARDWARE.md's wiring table mirrors this file; change both together.
//
// Default target: Seeed Studio XIAO ESP32-S3 Sense (on-board PDM mic).
//   XIAO pad -> GPIO:  D0=1  D1=2  D2=3  D3=4  D4=5  D5=6  D6=43  D7=44  D8=7  D9=8  D10=9
//   Avoid S3 strapping pins GPIO0/3/45/46. Deep-sleep wake needs an RTC GPIO (GPIO0-21).
#pragma once

#include <stdint.h>

// ------------------------------------------------------------------ identity
#ifndef DEVICE_NAME
#define DEVICE_NAME "SideKiqq Medallion"  // scan-response name; the phone filters on the service UUID
#endif
#define FIRMWARE_VERSION "0.1.0"

// ------------------------------------------------------------------ push-to-talk button
// Momentary switch between the pin and GND, internal pull-up (active LOW).
// Must be an RTC GPIO: it is also the deep-sleep wake source (ext0).
#define PIN_BUTTON 2  // XIAO D1
#define BUTTON_ACTIVE_LOW 1

// Gesture mode: 0 = Hold (press-and-hold to talk), 1 = Toggle (tap to start/stop, long-press cancel).
#ifndef PTT_MODE
#define PTT_MODE 0
#endif
#define PTT_DEBOUNCE_MS 25
#define PTT_MIN_TALK_MS 250        // Hold mode: shorter press = accidental tap -> CANCEL (0x03)
#define PTT_LONG_PRESS_MS 1200     // Toggle mode: long press -> CANCEL while talking, battery status when idle
#define PTT_MAX_UTTERANCE_MS 29000 // auto END before the phone's 30 s cap

// ------------------------------------------------------------------ microphone
// MIC_TYPE_PDM:   on-board MSM261D3526H1CPM PDM mic of the XIAO ESP32-S3 Sense (CLK=42, DATA=41)
// MIC_TYPE_I2S:   external INMP441 (I2S, 24-bit in 32-bit slots, L/R pin tied to GND = left)
#define MIC_TYPE_PDM 1
#define MIC_TYPE_I2S 2
#ifndef MIC_TYPE
#define MIC_TYPE MIC_TYPE_PDM
#endif

#define PIN_PDM_CLK 42   // Sense board, fixed
#define PIN_PDM_DATA 41  // Sense board, fixed

#define PIN_I2S_BCLK 8   // XIAO D9  (INMP441 SCK)
#define PIN_I2S_WS 9     // XIAO D10 (INMP441 WS)
#define PIN_I2S_DIN 44   // XIAO D7  (INMP441 SD)
#define I2S_SAMPLE_SHIFT 14  // INMP441: 32-bit slot -> 16-bit (16 = no gain, 14 = +12 dB)

#define MIC_GAIN_Q8 (256 * 4)  // post-DC-block digital gain (x4 = +12 dB) for the PDM mic
#define MIC_WARMUP_MS 40       // discard the first samples after the mic clock starts (pop / DC settle)
#define AUDIO_DMA_FRAMES 256   // samples per i2s_read (16 ms @ 16 kHz)
#define AUDIO_PACKET_QUEUE 192 // queued BLE packets (~1.4 s at 238 B/packet) to ride out slow conn intervals

// ------------------------------------------------------------------ LED
// External LED: pin -> 1 kOhm -> LED anode, cathode -> GND (active HIGH).
// For a bare dev board use the on-board user LED instead: -DPIN_LED=21 -DLED_ACTIVE_LOW=1
#ifndef PIN_LED
#define PIN_LED 7  // XIAO D8
#endif
#ifndef LED_ACTIVE_LOW
#define LED_ACTIVE_LOW 0
#endif
#define LED_PWM_CHANNEL 0
#define LED_PWM_FREQ_HZ 5000
#define LED_PWM_BITS 8

// ------------------------------------------------------------------ haptics
// HAPTIC_DRIVER_GPIO:     coin ERM motor switched by an N-MOSFET (AO3400A) or NPN on PIN_HAPTIC.
// HAPTIC_DRIVER_DRV2605L: TI DRV2605L breakout on I2C (PIN_I2C_SDA/SCL), ERM library effects.
#define HAPTIC_DRIVER_GPIO 1
#define HAPTIC_DRIVER_DRV2605L 2
#ifndef HAPTIC_DRIVER
#define HAPTIC_DRIVER HAPTIC_DRIVER_GPIO
#endif
#define PIN_HAPTIC 4      // XIAO D3, MOSFET gate (100 kOhm pull-down on the gate)
#define HAPTIC_PWM_CHANNEL 1
#define HAPTIC_PWM_FREQ_HZ 20000  // above audible range
#define HAPTIC_PWM_BITS 8
#define HAPTIC_DUTY 190           // ~75 %: a 3.0 V motor fed from a 4.2 V cell
#define HAPTIC_ON_START 1         // tick when recording starts
#define PIN_I2C_SDA 5     // XIAO D4
#define PIN_I2C_SCL 6     // XIAO D5

// ------------------------------------------------------------------ battery
// LiPo + -> R_TOP -> PIN_BATTERY_ADC -> R_BOTTOM -> GND, 100 nF from the ADC pin to GND.
// The XIAO ESP32-S3 has no built-in battery divider; this one draws ~9.5 uA at 4.2 V.
#define PIN_BATTERY_ADC 1  // XIAO D0 (ADC1_CH0; ADC2 is unusable while the radio is on)
#define BATTERY_R_TOP_OHM 220000UL
#define BATTERY_R_BOTTOM_OHM 220000UL
#define BATTERY_SAMPLES 8
#define BATTERY_PERIOD_MS 30000UL
#define BATTERY_LOW_PCT 15
#define BATTERY_CRITICAL_MV 3350

// ------------------------------------------------------------------ BLE
#define BLE_TX_POWER ESP_PWR_LVL_P3  // +3 dBm; a pendant is never far from the phone
#define ADV_FAST_INTERVAL_MS 40     // first ADV_FAST_WINDOW_MS after boot/disconnect: quick reconnect
#define ADV_FAST_WINDOW_MS 30000UL
#define ADV_SLOW_INTERVAL_MS 1000   // afterwards: low duty
// Connection parameters requested by the medallion (units: interval 1.25 ms, timeout 10 ms).
#define CONN_FAST_MIN 6    // 7.5 ms  while streaming audio (~32 kB/s)
#define CONN_FAST_MAX 12   // 15 ms
#define CONN_FAST_LATENCY 0
#define CONN_IDLE_MIN 80   // 100 ms  while idle
#define CONN_IDLE_MAX 160  // 200 ms
#define CONN_IDLE_LATENCY 4
#define CONN_TIMEOUT 500   // 5 s supervision timeout
#define END_DRAIN_TIMEOUT_MS 1500  // max wait for queued audio before sending END
#define THINKING_TIMEOUT_MS 45000  // stop pulsing if the phone never sends 0x11

// ------------------------------------------------------------------ power
#define CPU_FREQ_MHZ 80                        // minimum that keeps BLE + I2S happy
#define SLEEP_DISCONNECTED_MS (5UL * 60UL * 1000UL)
#define SLEEP_CONNECTED_IDLE_MS (60UL * 60UL * 1000UL)  // 0 = stay connected forever
#define LOOP_IDLE_DELAY_MS 5                   // loop yield when nothing is streaming
