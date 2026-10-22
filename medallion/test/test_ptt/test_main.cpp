// Push-to-talk state machine tests.
#include <unity.h>

#include "ptt_button.h"

using namespace sidekiqq;

namespace {
PttButton b;
uint32_t t = 0;

PttConfig cfg(PttMode mode) {
  PttConfig c;
  c.mode = mode;
  c.debounceMs = 20;
  c.minTalkMs = 250;
  c.longPressMs = 1000;
  c.maxUtteranceMs = 5000;
  return c;
}

// Holds `level` for `ms`, stepping 5 ms at a time; returns the first non-None event (if any).
PttEvent hold(bool level, uint32_t ms) {
  PttEvent first = PttEvent::None;
  for (uint32_t i = 0; i < ms; i += 5) {
    t += 5;
    PttEvent e = b.update(level, t);
    if (first == PttEvent::None) first = e;
    else TEST_ASSERT_TRUE_MESSAGE(e == PttEvent::None, "more than one event in one hold()");
  }
  return first;
}

void startHold(bool pressedAtBoot = false) {
  t = 1000;
  b.begin(cfg(PttMode::Hold), pressedAtBoot, t);
}
void startToggle() {
  t = 1000;
  b.begin(cfg(PttMode::Toggle), false, t);
}
}  // namespace

void setUp() {}
void tearDown() {}

// ------------------------------------------------------------------ Hold mode

void test_hold_press_starts_release_ends() {
  startHold();
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::Start);
  TEST_ASSERT_TRUE(b.talking());
  TEST_ASSERT_TRUE(hold(true, 1000) == PttEvent::None);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::End);
  TEST_ASSERT_FALSE(b.talking());
}

void test_hold_bounce_is_filtered() {
  startHold();
  // 10 ms glitches shorter than the 20 ms debounce never start anything.
  for (int i = 0; i < 10; ++i) {
    TEST_ASSERT_TRUE(hold(true, 10) == PttEvent::None);
    TEST_ASSERT_TRUE(hold(false, 10) == PttEvent::None);
  }
  // Bouncy press: glitches, then a stable press -> exactly one Start.
  hold(true, 5);
  hold(false, 5);
  TEST_ASSERT_TRUE(hold(true, 300) == PttEvent::Start);
  // Bouncy release -> exactly one End.
  hold(false, 5);
  hold(true, 5);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::End);
}

void test_hold_short_tap_cancels() {
  startHold();
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::Start);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::Cancel);
}

void test_hold_max_utterance_ends_then_waits_for_release() {
  startHold();
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::Start);
  TEST_ASSERT_TRUE(hold(true, 6000) == PttEvent::End);
  TEST_ASSERT_TRUE(b.state() == PttButton::State::WaitRelease);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::None);  // no second End on release
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::Start);   // usable again
}

void test_button_held_at_boot_is_ignored_until_release() {
  startHold(/*pressedAtBoot=*/true);
  TEST_ASSERT_TRUE(hold(true, 2000) == PttEvent::None);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::None);
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::Start);
}

void test_abort_while_held_waits_for_release() {
  startHold();
  TEST_ASSERT_TRUE(hold(true, 300) == PttEvent::Start);
  b.abort();  // link dropped
  TEST_ASSERT_FALSE(b.talking());
  TEST_ASSERT_TRUE(hold(true, 500) == PttEvent::None);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::None);  // no End after abort
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::Start);
}

void test_millis_wraparound() {
  t = 0xFFFFFF00u;
  b.begin(cfg(PttMode::Hold), false, t);
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::Start);
  TEST_ASSERT_TRUE(hold(true, 600) == PttEvent::None);  // crosses 2^32
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::End);  // not Cancel, not a bogus max-utterance
}

// ------------------------------------------------------------------ Toggle mode

void test_toggle_tap_starts_tap_ends() {
  startToggle();
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::None);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::Start);
  TEST_ASSERT_TRUE(hold(false, 2000) == PttEvent::None);
  TEST_ASSERT_TRUE(hold(true, 100) == PttEvent::None);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::End);
  TEST_ASSERT_FALSE(b.talking());
}

void test_toggle_long_press_while_talking_cancels() {
  startToggle();
  hold(true, 100);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::Start);
  TEST_ASSERT_TRUE(hold(true, 1200) == PttEvent::Cancel);  // fires while still held
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::None);
  TEST_ASSERT_TRUE(b.state() == PttButton::State::Idle);
}

void test_toggle_long_press_idle_is_status() {
  startToggle();
  TEST_ASSERT_TRUE(hold(true, 1500) == PttEvent::Status);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::None);
  TEST_ASSERT_FALSE(b.talking());
}

void test_toggle_max_utterance_ends() {
  startToggle();
  hold(true, 100);
  TEST_ASSERT_TRUE(hold(false, 100) == PttEvent::Start);
  TEST_ASSERT_TRUE(hold(false, 6000) == PttEvent::End);
  TEST_ASSERT_TRUE(b.state() == PttButton::State::Idle);
}

void test_event_names() {
  TEST_ASSERT_EQUAL_STRING("start", pttEventName(PttEvent::Start));
  TEST_ASSERT_EQUAL_STRING("cancel", pttEventName(PttEvent::Cancel));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_hold_press_starts_release_ends);
  RUN_TEST(test_hold_bounce_is_filtered);
  RUN_TEST(test_hold_short_tap_cancels);
  RUN_TEST(test_hold_max_utterance_ends_then_waits_for_release);
  RUN_TEST(test_button_held_at_boot_is_ignored_until_release);
  RUN_TEST(test_abort_while_held_waits_for_release);
  RUN_TEST(test_millis_wraparound);
  RUN_TEST(test_toggle_tap_starts_tap_ends);
  RUN_TEST(test_toggle_long_press_while_talking_cancels);
  RUN_TEST(test_toggle_long_press_idle_is_status);
  RUN_TEST(test_toggle_max_utterance_ends);
  RUN_TEST(test_event_names);
  return UNITY_END();
}
