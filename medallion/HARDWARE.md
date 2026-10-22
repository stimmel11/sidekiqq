# SideKiqq Medallion: hardware guide

The medallion is a pendant-sized push-to-talk BLE microphone. Press the button, speak, and release.
The phone app (`MedallionService`) receives the audio, sends it to the brain, and speaks the reply on
your glasses or earbuds. The medallion has no speaker. It reports back with an LED pulse while the
brain is thinking and with haptic buzzes.

The pin numbers in this guide match `include/config.h`. If you change one, change the other too.

---

## 1. Bill of materials

Prices are approximate single-unit USD prices from late 2026 (Seeed, Adafruit, DigiKey, AliExpress).

### Build A (default): XIAO ESP32-S3 Sense, on-board mic, discrete motor driver

| # | Part | Example | Approx. |
|---|------|---------|--------:|
| 1 | MCU + mic | **Seeed Studio XIAO ESP32-S3 Sense** (ESP32-S3R8, 8 MB PSRAM, on-board PDM mic, LiPo charger). Remove the camera; it isn't used | $14 |
| 2 | Battery | 1S LiPo, 3.7 V, **400 mAh 502535** (5 × 25 × 35 mm) with protection PCB | $6 |
| 3 | Power switch (optional) | SS12D07 sub-mini slide switch, in series with BAT+ (for shipping and storage) | $0.30 |
| 4 | Vibration motor | 10 × 2.7 mm coin ERM, 3 V, about 70 mA (e.g. Adafruit 1201) | $2 |
| 5 | Motor driver | **AO3400A** N-MOSFET (SOT-23), **1N4148W** flyback diode, 100 Ω gate resistor, 100 kΩ gate pull-down | $0.30 |
| 6 | LED | 0603 or 3 mm LED (white or cyan) + 1 kΩ resistor | $0.20 |
| 7 | Button | Low-profile tactile switch, e.g. Panasonic EVQ-P7 (side-actuated) or Omron B3U-1000P | $0.60 |
| 8 | Battery sense | 2 × 220 kΩ 0603 (1 %) + 100 nF 0603 | $0.10 |
| 9 | Enclosure | 3D-printed pendant (see §6), acoustic mesh disc for the mic port, lanyard or magnetic clasp | $3–8 |
| 10 | Misc | 30 AWG silicone wire, Kapton tape, 1 mm double-sided foam tape | $2 |
| | **Total** | | **≈ $30** |

### Build B: plain XIAO ESP32-S3, INMP441 mic, DRV2605L haptics (`env:xiao_esp32s3_inmp441`)

| Part | Example | Approx. |
|------|---------|--------:|
| MCU | Seeed XIAO ESP32-S3 (non-Sense) | $7.50 |
| Mic | INMP441 I2S MEMS breakout | $3 |
| Haptic driver | Adafruit DRV2605L breakout (#2305) | $8 |
| Everything else | As in Build A, minus the MOSFET, diode and resistors from item 5 | ≈ $15 |

The DRV2605L gives crisper, braked buzzes and takes load off the MCU pin. The INMP441 board is larger
than the Sense board's built-in mic but picks up sound better at chest distance.

Any other ESP32-S3 board will work, provided it has a LiPo charger and you edit `config.h`. The
original ESP32, the C3 and the C6 lack the throughput margin or PDM-RX support this design relies on.

---

## 2. Wiring

XIAO pad to GPIO: D0=1, D1=2, D2=3, D3=4, D4=5, D5=6, D6=43, D7=44, D8=7, D9=8, D10=9.

| Function | XIAO pad | GPIO | `config.h` | Connect to |
|----------|----------|------|-----------|------------|
| Push-to-talk button | D1 | 2 | `PIN_BUTTON` | Button between the pad and **GND**. Uses the internal pull-up, active LOW. It is also the deep-sleep wake pin (RTC GPIO) |
| Status LED | D8 | 7 | `PIN_LED` | Pad → 1 kΩ → LED anode; cathode → GND |
| Haptic MOSFET gate | D3 | 4 | `PIN_HAPTIC` | Pad → 100 Ω → AO3400A gate; 100 kΩ gate → GND; source → GND; drain → motor (−); motor (+) → **BAT+**; 1N4148W across the motor (cathode to BAT+) |
| Battery sense | D0 | 1 | `PIN_BATTERY_ADC` | BAT+ → 220 kΩ → **pad** → 220 kΩ → GND; 100 nF pad → GND |
| PDM mic CLK / DATA | (Sense board) | 42 / 41 | `PIN_PDM_CLK/DATA` | Built in. No wiring |
| Battery | BAT+ / BAT− pads (underside) | n/a | n/a | LiPo, through the optional slide switch on BAT+ |

Build B adds:

| Function | XIAO pad | GPIO | `config.h` | Connect to |
|----------|----------|------|-----------|------------|
| INMP441 SCK | D9 | 8 | `PIN_I2S_BCLK` | SCK |
| INMP441 WS | D10 | 9 | `PIN_I2S_WS` | WS |
| INMP441 SD | D7 | 44 | `PIN_I2S_DIN` | SD. Also tie **L/R → GND** (left channel), VDD → 3V3, GND → GND |
| DRV2605L SDA | D4 | 5 | `PIN_I2C_SDA` | SDA (the breakout has pull-ups). VIN → 3V3, OUT+/OUT− → motor |
| DRV2605L SCL | D5 | 6 | `PIN_I2C_SCL` | SCL |

Notes
- Do not use GPIO 0, 3, 45 or 46. They are ESP32-S3 strapping pins.
- On the Sense board, D8/D9/D10 also go to the microSD slot. Leave the slot empty.
- The motor runs from BAT+ (up to 4.2 V), not 3V3, so its current doesn't pass through the LDO.
  `HAPTIC_DUTY` (190/255, about 75 %) brings the average down to about 3 V for a 3 V motor.
- For bring-up on a bare board with no LED wired, build with `-DPIN_LED=21 -DLED_ACTIVE_LOW=1` to
  use the on-board user LED.
- The XIAO has no battery divider of its own. Without one, the firmware reports 100 % and skips
  low-battery protection (it assumes USB power).

---

## 3. Behaviour

| You do / phone sends | Medallion does | BLE |
|---|---|---|
| Hold the button (Hold mode, default) | LED solid on, short tick, audio streams | CONTROL notify `0x01`, then AUDIO notifies |
| Release | Remaining audio flushed | CONTROL notify `0x02` |
| Tap shorter than 250 ms | Discarded | `0x01` … `0x03` |
| Hold longer than 29 s | Ends automatically (the phone caps an utterance at 30 s) | `0x02` |
| Toggle mode (`env:xiao_esp32s3_toggle`): tap / tap | Start / end | `0x01` / `0x02` |
| Toggle mode: long press (≥ 1.2 s) while talking | Cancel | `0x03` |
| Toggle mode: long press while idle | Battery gauge, 1–4 blinks | n/a |
| Phone writes `0x10` | LED breathes (thinking). Times out after 45 s | n/a |
| Phone writes `0x11` | Short buzz, pulse stops | n/a |
| Phone writes `0x12` | Double buzz (needs attention, e.g. a HIGH/CRITICAL push) | n/a |
| Not connected and you press | 3 fast blinks + error buzz | n/a |

LED at rest: a blink every 2 s means it is advertising (looking for the phone). A faint blink every
10 s means it is connected. A double blink every 4 s means the battery is low (≤ 15 %).

---

## 4. Power budget and battery life

Measured figures for this exact board and firmware don't exist yet. The numbers below come from
Espressif and Seeed datasheet and application-note values. Measure your own unit with a USB power
meter or a Nordic PPK2 before relying on them.

| State | Stock Arduino-ESP32 2.0.x build | With automatic light sleep (custom sdkconfig, see below) |
|---|---|---|
| Deep sleep (button wake) + 9.5 µA divider | ~25 µA | ~25 µA |
| Advertising (fast 40 ms, then 1 s) | ~25 mA | ~1–3 mA |
| Connected, idle (100–200 ms interval, latency 4) | ~25–30 mA | ~2–4 mA |
| Streaming audio (7.5–15 ms interval, mic on) | ~45–55 mA | ~40–50 mA |
| Haptic buzz (70 ms) | +70 mA momentary | same |

Battery life with a 400 mAh cell, worn all day and connected to the phone, at 60 utterances/day of
about 5 s each (5 min of streaming per day):

- **Stock build:** about 400 mAh / ~28 mA ≈ **14 h of connected time**. That covers one waking
  day, so charge it every night.
- **Light-sleep build:** about 400 mAh / ~3.5 mA ≈ **4–5 days**.
- **Parked in deep sleep** (it sleeps automatically after 5 min without a phone, or after 60 min
  connected and untouched): months. The cell's own self-discharge sets the limit.

Stock Arduino-ESP32 2.0.17 is built with `CONFIG_PM_ENABLE` off and without BLE modem sleep.
`power.cpp` enables automatic light sleep and DVFS once those options exist (`#if CONFIG_PM_ENABLE`).
To get there, build with a custom sdkconfig (the pioarduino platform, or ESP-IDF with Arduino as a
component) that sets `CONFIG_PM_ENABLE=y`, `CONFIG_FREERTOS_USE_TICKLESS_IDLE=y`,
`CONFIG_BT_CTRL_MODEM_SLEEP=y` and `CONFIG_BT_CTRL_LOW_POWER_CLOCK=main XTAL`
(or 32 kHz XTAL if you add one). Until then, the deep-sleep timeouts in `config.h` are the main
battery lever:

- `SLEEP_DISCONNECTED_MS` (5 min)
- `SLEEP_CONNECTED_IDLE_MS` (60 min; set 0 to stay connected forever)

Waking from deep sleep takes one button press plus about 1–5 s for the phone to reconnect. That
first press is only a wake-up and is not recorded.

The XIAO charges at about 100 mA from USB-C, so a 400 mAh cell takes about 4–5 h. Below 3.35 V the
firmware deep-sleeps to protect the cell, and the protection PCB cuts off at about 3.0 V.

---

## 5. Assembly

1. **Bench test first.** Flash the board over USB-C with nothing attached (see §7), using
   `-DPIN_LED=21 -DLED_ACTIVE_LOW=1`. Open the serial monitor and check that it advertises and that
   the phone connects.
2. **Sense board:** remove the camera module and its ribbon. Keep the expansion board; it carries the
   mic. Its mic port faces away from the XIAO, so orient the enclosure's mic hole to match.
3. **Battery:** solder the LiPo leads to the BAT+/BAT− pads on the underside of the XIAO, with the
   slide switch in series on BAT+. Insulate the pads with Kapton. Check polarity twice. The XIAO has
   no reverse-polarity protection on the battery pads.
4. **Battery divider:** solder the two 220 kΩ resistors and the 100 nF capacitor dead-bug style
   between BAT+, D0 and GND. Sleeve them with Kapton.
5. **Haptics:** mount the AO3400A, diode and resistors on a scrap of perfboard, or dead-bug them on
   the motor leads. Stick the coin motor flat against the inside of the enclosure back, away from the
   mic, so the start tick isn't recorded. The firmware also discards the first 40 ms of audio.
6. **Button and LED:** wire them to D1 and D8 (see §2). Put the button where your thumb finds it
   without looking (the edge works better than the face).
7. **Strain relief:** tack the wires down with a dot of hot glue or UV resin. Leave the USB-C port
   reachable for charging and flashing.
8. **Close up and test:** check the LED patterns, a short and a long utterance, and the phone's
   0x11 buzz after a reply. Check that it wakes from deep sleep with a button press.

---

## 6. Enclosure ideas

- **3D-printed pendant** (PETG, or resin for a finer finish), about 30 × 42 × 12 mm. Use a two-part
  snap-fit shell with a USB-C cutout, a 1.5 mm mic hole covered by an acoustic mesh disc on the
  inside, a light pipe or thin translucent window over the LED, and a recessed button so it isn't
  pressed by accident.
- **Magnetic clip** (lapel or pocket edge) instead of a lanyard. A lapel puts the mic about 15 cm
  from your mouth, which gives the best recognition. Keep the magnet away from the motor.
- **Machined aluminium or walnut** case for a finished product. Metal detunes the antenna, so the
  XIAO's PCB-antenna end must sit under a plastic or wood window.
- Avoid fully sealed designs. The mic needs an air path, and the LiPo needs a little room to swell.

---

## 7. Flashing

Prerequisites: PlatformIO Core (`pip install platformio`) or the VS Code PlatformIO extension, and
a USB-C data cable.

```bash
cd medallion
pio run                                   # build the default env (xiao_esp32s3_sense)
pio run -t upload                         # flash
pio device monitor                        # logs at 115200 baud
pio run -e xiao_esp32s3_inmp441 -t upload # Build B
pio run -e xiao_esp32s3_toggle -t upload  # tap-to-talk / long-press-cancel gestures
pio test -e native                        # host unit tests, no hardware needed
```

If the upload fails to connect, hold **BOOT**, tap **RESET**, release BOOT, and retry. The same
applies if the board is in deep sleep, because USB-CDC is off while the chip sleeps. You can also
press the PTT button to wake it and upload within the 5-minute window.

---

## 8. Pairing with the phone app

There is no OS-level Bluetooth pairing. **Do not pair the medallion in Android's Bluetooth
settings.**

1. Install and sign in to the SideKiqq phone app, and pair the phone with the brain (one-time code,
   see ARCHITECTURE.md → Auth).
2. Power the medallion on. The LED blinks every 2 s while it advertises.
3. In the app, tap **Connect medallion** and grant *Nearby devices* (Android 12+) or *Location*
   (Android ≤ 11).
4. `MedallionService` scans for the SideKiqq service UUID, connects, requests MTU 247 and subscribes
   to AUDIO, CONTROL and BATTERY. The app status changes to `connected · NN%`, and the medallion LED
   switches to a faint 10 s blink.
5. Hold the button and speak. The app shows `listening`, then `thinking` (the medallion breathes),
   then `speaking`. The medallion gives a short buzz when the reply has been delivered.

After a drop (out of range, or the medallion slept), the app reconnects on its own with exponential
backoff. Pressing the button wakes a sleeping medallion, and it advertises fast for 30 s so the phone
finds it quickly.

**Security caveat:** the GATT service is open. There is no bonding or encryption, because
`MedallionService` connects without `createBond()`. The phone also connects to the first device it
finds that advertises the service UUID. Audio is only sent while the button is held, but a nearby
attacker could connect first, or sniff an utterance. Bonding with LE Secure Connections on both ends
is the planned fix. See the README's open items.
