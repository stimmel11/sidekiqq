// Push-to-talk button state machine (debounce + gestures). Pure C++, unit-tested natively.
//
// Two gesture modes (PTT_MODE in config.h):
//
//  Hold (default, walkie-talkie):
//    press            -> Start  (CONTROL 0x01, audio streams while held)
//    release          -> End    (CONTROL 0x02)
//    release < minTalkMs (accidental tap)          -> Cancel (CONTROL 0x03)
//    held >= maxUtteranceMs                         -> End, then ignored until released
//
//  Toggle (hands-free, long-press cancel):
//    short press (< longPressMs) while idle         -> Start on release
//    short press while talking                      -> End
//    long press while talking                       -> Cancel (fires while still held)
//    long press while idle                          -> Status (show battery / link on the LED)
//    talking for maxUtteranceMs                     -> End
//
// "Long-press = cancel" from the spec only makes sense in Toggle mode: in Hold mode a long
// press IS the utterance. Hold mode therefore cancels on an accidental short tap instead.
#pragma once

#include <stdint.h>

namespace sidekiqq {

enum class PttMode : uint8_t { Hold = 0, Toggle = 1 };

enum class PttEvent : uint8_t { None = 0, Start, End, Cancel, Status };

struct PttConfig {
  PttMode mode = PttMode::Hold;
  uint32_t debounceMs = 25;
  uint32_t minTalkMs = 250;        // Hold: shorter presses are treated as accidental -> Cancel
  uint32_t longPressMs = 1200;     // Toggle: long-press threshold
  uint32_t maxUtteranceMs = 29000; // both: auto End (phone caps an utterance at 30 s)
};

class PttButton {
 public:
  enum class State : uint8_t { Idle, IdlePressed, Talking, TalkingPressed, WaitRelease };

  // `pressedNow`: level at boot. A button held at boot (e.g. the press that woke the chip from
  // deep sleep) is ignored until it is released.
  void begin(const PttConfig& cfg, bool pressedNow, uint32_t nowMs);

  // Feed the raw (undebounced) level every loop. Returns at most one event per call.
  PttEvent update(bool rawPressed, uint32_t nowMs);

  // Drops any utterance in progress without an event (e.g. the BLE link dropped).
  void abort();

  State state() const { return state_; }
  bool talking() const { return state_ == State::Talking || state_ == State::TalkingPressed; }
  bool pressed() const { return stable_; }
  uint32_t talkStartedMs() const { return talkStart_; }

 private:
  enum class Edge : uint8_t { None, Press, Release };
  Edge debounce(bool raw, uint32_t now);
  PttEvent updateHold(Edge e, uint32_t now);
  PttEvent updateToggle(Edge e, uint32_t now);

  PttConfig cfg_{};
  State state_ = State::Idle;
  bool stable_ = false;
  bool rawLast_ = false;
  uint32_t rawChangedAt_ = 0;
  uint32_t pressAt_ = 0;
  uint32_t talkStart_ = 0;
};

const char* pttEventName(PttEvent e);

}  // namespace sidekiqq
