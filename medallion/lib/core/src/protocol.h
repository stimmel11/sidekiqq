// SideKiqq medallion GATT protocol.
//
// Binding definition: ARCHITECTURE.md "Medallion BLE protocol (GATT)" and
// android/phone/src/main/java/com/sidekiqq/phone/medallion/MedallionProtocol.kt.
// Where the two differ, the Kotlin wins. Keep this file byte-for-byte in sync with the Kotlin.
//
// Pure header (no Arduino / ESP-IDF) so it is shared by the firmware and the native tests.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace sidekiqq {
namespace proto {

// 128-bit UUIDs (MedallionProtocol.SERVICE / AUDIO / CONTROL / BATTERY)
constexpr const char* kServiceUuid = "5a1d0001-5e1d-4b1a-9e1d-51de4b1a0001";
constexpr const char* kAudioUuid   = "5a1d0002-5e1d-4b1a-9e1d-51de4b1a0001";  // notify
constexpr const char* kControlUuid = "5a1d0003-5e1d-4b1a-9e1d-51de4b1a0001";  // write (with response) + notify
constexpr const char* kBatteryUuid = "5a1d0004-5e1d-4b1a-9e1d-51de4b1a0001";  // read + notify, uint8 percent

// CONTROL opcodes, medallion -> phone (notify)
constexpr uint8_t kCtrlStart  = 0x01;  // start of utterance
constexpr uint8_t kCtrlEnd    = 0x02;  // end of utterance
constexpr uint8_t kCtrlCancel = 0x03;  // cancel / discard utterance

// CONTROL opcodes, phone -> medallion (write with response)
constexpr uint8_t kCtrlThinking        = 0x10;  // pulse LED while the brain works
constexpr uint8_t kCtrlReplyDelivered  = 0x11;  // short haptic, ends the LED pulse
constexpr uint8_t kCtrlNeedsAttention  = 0x12;  // double haptic

// AUDIO framing: [seq:uint8][PCM16 LE, 16 kHz mono ...], at most 240 bytes per notification
// INCLUDING the sequence byte (MedallionProtocol.MAX_AUDIO_CHUNK). The phone requests MTU 247
// (MedallionProtocol.DESIRED_MTU) so a 240-byte notification fits (ATT notify header = 3 bytes).
constexpr size_t   kMaxAudioPacket = 240;
constexpr uint16_t kDesiredMtu     = 247;
constexpr size_t   kAttNotifyHeader = 3;
constexpr uint32_t kSampleRateHz   = 16000;
constexpr size_t   kBytesPerSample = 2;

// UtteranceAssembler on the phone caps an utterance at 30 s of audio and flags anything beyond as
// "truncated"; the firmware stops a little earlier so the phone never truncates.
constexpr uint32_t kPhoneMaxUtteranceMs = 30000;

// Phone finalises an utterance if no AUDIO/CONTROL arrives for this long (UTTERANCE_IDLE_MS).
constexpr uint32_t kPhoneUtteranceIdleMs = 3000;

enum class ControlCommand : uint8_t {
  Unknown = 0,
  Thinking,
  ReplyDelivered,
  NeedsAttention,
};

// Decodes a phone -> medallion CONTROL write. Only the first byte is significant; anything
// else (empty writes, medallion -> phone opcodes echoed back, unknown values) is Unknown.
inline ControlCommand decodeControlWrite(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0) return ControlCommand::Unknown;
  switch (data[0]) {
    case kCtrlThinking:       return ControlCommand::Thinking;
    case kCtrlReplyDelivered: return ControlCommand::ReplyDelivered;
    case kCtrlNeedsAttention: return ControlCommand::NeedsAttention;
    default:                  return ControlCommand::Unknown;
  }
}

}  // namespace proto
}  // namespace sidekiqq
