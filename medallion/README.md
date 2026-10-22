# SideKiqq Medallion firmware

The medallion is a wearable push-to-talk microphone for SideKiqq. It runs on an ESP32-S3 (default:
Seeed XIAO ESP32-S3 Sense) and is built with PlatformIO, the Arduino framework and NimBLE-Arduino.
It streams 16 kHz mono PCM16 over BLE to the phone app, which handles transcription, the brain and
the spoken reply.

- **Protocol:** `lib/core/src/protocol.h`. It mirrors ARCHITECTURE.md → *Medallion BLE protocol*
  and `android/phone/.../medallion/MedallionProtocol.kt`. Where the two disagree, the Kotlin wins.
- **Hardware:** BOM, wiring, power budget, assembly, flashing and pairing are in
  [HARDWARE.md](HARDWARE.md).
- **Pins and tunables:** `include/config.h`. This is the only file you should need to edit.

## Layout

```
include/config.h        pins, gestures, BLE/power tunables
src/main.cpp            loop: button → CONTROL + mic, packet pump, phone opcodes, sleep policy
src/ble_link.*          NimBLE GATT server, advertising/reconnect, back-pressured notifications
src/audio_capture.*     I2S PDM (or INMP441) capture task → DC block/gain → framer → packet queue
src/ui.*                LED (LEDC PWM) and haptics (MOSFET PWM or DRV2605L RTP)
src/power.*             CPU clock, battery ADC, deep sleep with button wake
lib/core/src/           pure C++ logic, host-tested: protocol, audio_framer, ptt_button,
                        battery, audio_dsp, ui_patterns, power_policy
test/                   Unity tests for lib/core (pio test -e native)
```

## Wire format (as implemented)

| Characteristic | UUID | Properties | Content |
|---|---|---|---|
| Service | `5a1d0001-5e1d-4b1a-9e1d-51de4b1a0001` | n/a | In the primary advertisement (the phone's ScanFilter matches it) |
| AUDIO | `5a1d0002-…0001` | notify | `[seq u8][PCM16 LE …]`, ≤ 240 B **including** seq. Payload is 238 B (119 samples) at MTU 247, 18 B at MTU 23. Seq starts at 0 each utterance and wraps 255 → 0 |
| CONTROL | `5a1d0003-…0001` | write, write-no-rsp, notify | medallion→phone `0x01` start / `0x02` end / `0x03` cancel; phone→medallion `0x10` thinking / `0x11` reply delivered / `0x12` needs attention |
| BATTERY | `5a1d0004-…0001` | read, notify | u8 percent, notified when it changes |

`0x02` is sent only after the queued audio has gone out (or after 1.5 s), so END never overtakes the
last AUDIO packet.

## Build and test

```bash
pio run                 # firmware (env xiao_esp32s3_sense)
pio run -t upload
pio test -e native      # 31 host tests: framing, PTT state machine, battery, DSP, UI, power policy
```

## Open items

- **Security:** no bonding or encryption yet. Bonding has to be added on both the phone and the
  firmware side (see HARDWARE.md §8).
- **Battery life:** stock Arduino-ESP32 2.0.x cannot light-sleep with BLE on, so expect about 14 h
  connected on a 400 mAh cell. A custom-sdkconfig build should give several days (see HARDWARE.md §4).
- **Unmeasured:** current draw and audio quality (`MIC_GAIN_Q8`) have not been measured on real
  hardware yet.
