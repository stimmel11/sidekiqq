#include "ptt_button.h"

namespace sidekiqq {

void PttButton::begin(const PttConfig& cfg, bool pressedNow, uint32_t nowMs) {
  cfg_ = cfg;
  stable_ = pressedNow;
  rawLast_ = pressedNow;
  rawChangedAt_ = nowMs;
  pressAt_ = nowMs;
  talkStart_ = 0;
  state_ = pressedNow ? State::WaitRelease : State::Idle;
}

void PttButton::abort() { state_ = stable_ ? State::WaitRelease : State::Idle; }

PttButton::Edge PttButton::debounce(bool raw, uint32_t now) {
  if (raw != rawLast_) {
    rawLast_ = raw;
    rawChangedAt_ = now;
  }
  if (raw != stable_ && static_cast<uint32_t>(now - rawChangedAt_) >= cfg_.debounceMs) {
    stable_ = raw;
    return raw ? Edge::Press : Edge::Release;
  }
  return Edge::None;
}

PttEvent PttButton::update(bool rawPressed, uint32_t nowMs) {
  const Edge e = debounce(rawPressed, nowMs);
  if (state_ == State::WaitRelease) {
    if (e == Edge::Release) state_ = State::Idle;
    return PttEvent::None;
  }
  return cfg_.mode == PttMode::Toggle ? updateToggle(e, nowMs) : updateHold(e, nowMs);
}

PttEvent PttButton::updateHold(Edge e, uint32_t now) {
  switch (state_) {
    case State::Idle:
    case State::IdlePressed:  // not used in Hold mode
      if (e == Edge::Press) {
        state_ = State::Talking;
        talkStart_ = now;
        return PttEvent::Start;
      }
      state_ = State::Idle;
      return PttEvent::None;

    case State::Talking:
    case State::TalkingPressed: {
      const uint32_t held = now - talkStart_;
      if (e == Edge::Release) {
        state_ = State::Idle;
        return held < cfg_.minTalkMs ? PttEvent::Cancel : PttEvent::End;
      }
      if (held >= cfg_.maxUtteranceMs) {
        state_ = State::WaitRelease;
        return PttEvent::End;
      }
      return PttEvent::None;
    }

    case State::WaitRelease:
      break;
  }
  return PttEvent::None;
}

PttEvent PttButton::updateToggle(Edge e, uint32_t now) {
  switch (state_) {
    case State::Idle:
      if (e == Edge::Press) {
        state_ = State::IdlePressed;
        pressAt_ = now;
      }
      return PttEvent::None;

    case State::IdlePressed:
      if (e == Edge::Release) {
        state_ = State::Talking;
        talkStart_ = now;
        return PttEvent::Start;
      }
      if (static_cast<uint32_t>(now - pressAt_) >= cfg_.longPressMs) {
        state_ = State::WaitRelease;
        return PttEvent::Status;
      }
      return PttEvent::None;

    case State::Talking:
      if (static_cast<uint32_t>(now - talkStart_) >= cfg_.maxUtteranceMs) {
        state_ = (e == Edge::Press) ? State::WaitRelease : State::Idle;
        return PttEvent::End;
      }
      if (e == Edge::Press) {
        state_ = State::TalkingPressed;
        pressAt_ = now;
      }
      return PttEvent::None;

    case State::TalkingPressed:
      if (static_cast<uint32_t>(now - pressAt_) >= cfg_.longPressMs) {
        state_ = State::WaitRelease;
        return PttEvent::Cancel;
      }
      if (e == Edge::Release) {
        state_ = State::Idle;
        return PttEvent::End;
      }
      if (static_cast<uint32_t>(now - talkStart_) >= cfg_.maxUtteranceMs) {
        state_ = State::WaitRelease;
        return PttEvent::End;
      }
      return PttEvent::None;

    case State::WaitRelease:
      break;
  }
  return PttEvent::None;
}

const char* pttEventName(PttEvent e) {
  switch (e) {
    case PttEvent::None:   return "none";
    case PttEvent::Start:  return "start";
    case PttEvent::End:    return "end";
    case PttEvent::Cancel: return "cancel";
    case PttEvent::Status: return "status";
  }
  return "?";
}

}  // namespace sidekiqq
