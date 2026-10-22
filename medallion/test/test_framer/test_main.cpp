// AUDIO framing tests: packet layout must match UtteranceAssembler.kt / MedallionProtocol.kt.
#include <string.h>
#include <unity.h>

#include <vector>

#include "audio_framer.h"
#include "protocol.h"

using namespace sidekiqq;

namespace {
std::vector<std::vector<uint8_t>> g_pkts;

void collect(const uint8_t* p, size_t n, void*) { g_pkts.emplace_back(p, p + n); }

std::vector<int16_t> ramp(size_t n, int16_t start = 0) {
  std::vector<int16_t> v(n);
  for (size_t i = 0; i < n; ++i) v[i] = static_cast<int16_t>(start + static_cast<int16_t>(i));
  return v;
}
}  // namespace

void setUp() { g_pkts.clear(); }
void tearDown() {}

void test_protocol_constants_match_kotlin() {
  TEST_ASSERT_EQUAL_STRING("5a1d0001-5e1d-4b1a-9e1d-51de4b1a0001", proto::kServiceUuid);
  TEST_ASSERT_EQUAL_STRING("5a1d0002-5e1d-4b1a-9e1d-51de4b1a0001", proto::kAudioUuid);
  TEST_ASSERT_EQUAL_STRING("5a1d0003-5e1d-4b1a-9e1d-51de4b1a0001", proto::kControlUuid);
  TEST_ASSERT_EQUAL_STRING("5a1d0004-5e1d-4b1a-9e1d-51de4b1a0001", proto::kBatteryUuid);
  TEST_ASSERT_EQUAL_HEX8(0x01, proto::kCtrlStart);
  TEST_ASSERT_EQUAL_HEX8(0x02, proto::kCtrlEnd);
  TEST_ASSERT_EQUAL_HEX8(0x03, proto::kCtrlCancel);
  TEST_ASSERT_EQUAL_HEX8(0x10, proto::kCtrlThinking);
  TEST_ASSERT_EQUAL_HEX8(0x11, proto::kCtrlReplyDelivered);
  TEST_ASSERT_EQUAL_HEX8(0x12, proto::kCtrlNeedsAttention);
  TEST_ASSERT_EQUAL(240, proto::kMaxAudioPacket);
  TEST_ASSERT_EQUAL(247, proto::kDesiredMtu);
}

void test_packet_size_for_mtu() {
  // MTU 247 -> 244 usable -> capped at 240 incl. seq -> 239 payload -> rounded to 238 (even).
  TEST_ASSERT_EQUAL(239, AudioFramer::packetSizeForMtu(247));
  TEST_ASSERT_EQUAL(239, AudioFramer::packetSizeForMtu(517));
  // Default ATT MTU 23 -> 20 usable -> 19 payload -> 18.
  TEST_ASSERT_EQUAL(19, AudioFramer::packetSizeForMtu(23));
  TEST_ASSERT_EQUAL(3, AudioFramer::packetSizeForMtu(0));
  for (uint16_t mtu = 23; mtu < 600; ++mtu) {
    const size_t pkt = AudioFramer::packetSizeForMtu(mtu);
    TEST_ASSERT_TRUE(pkt <= proto::kMaxAudioPacket);
    TEST_ASSERT_TRUE(pkt + proto::kAttNotifyHeader <= mtu);
    TEST_ASSERT_EQUAL(0, (pkt - 1) % 2);  // whole samples only
  }
}

void test_full_packets_are_seq_plus_le_pcm() {
  AudioFramer f(AudioFramer::packetSizeForMtu(247));
  TEST_ASSERT_EQUAL(238, f.payloadBytes());
  auto s = ramp(119 * 2, -100);
  s[0] = 0x1234;
  TEST_ASSERT_EQUAL(2, f.push(s.data(), s.size(), collect, nullptr));
  TEST_ASSERT_EQUAL(2, g_pkts.size());
  TEST_ASSERT_EQUAL(239, g_pkts[0].size());
  TEST_ASSERT_EQUAL_HEX8(0, g_pkts[0][0]);
  TEST_ASSERT_EQUAL_HEX8(1, g_pkts[1][0]);
  // Little-endian first sample.
  TEST_ASSERT_EQUAL_HEX8(0x34, g_pkts[0][1]);
  TEST_ASSERT_EQUAL_HEX8(0x12, g_pkts[0][2]);
  // Negative sample -99 = 0xFF9D.
  TEST_ASSERT_EQUAL_HEX8(0x9D, g_pkts[0][3]);
  TEST_ASSERT_EQUAL_HEX8(0xFF, g_pkts[0][4]);
  // Second packet continues where the first ended.
  const int16_t first2 = static_cast<int16_t>(g_pkts[1][1] | (g_pkts[1][2] << 8));
  TEST_ASSERT_EQUAL(s[119], first2);
}

void test_partial_input_accumulates_and_flushes() {
  AudioFramer f(240);
  auto s = ramp(50);
  TEST_ASSERT_EQUAL(0, f.push(s.data(), 50, collect, nullptr));
  TEST_ASSERT_EQUAL(100, f.pendingBytes());
  TEST_ASSERT_EQUAL(0, f.push(s.data(), 50, collect, nullptr));
  TEST_ASSERT_EQUAL(1, f.push(s.data(), 50, collect, nullptr));  // 150 samples = 300 B > 238
  TEST_ASSERT_EQUAL(1, g_pkts.size());
  TEST_ASSERT_EQUAL(300 - 238, f.pendingBytes());
  TEST_ASSERT_EQUAL(1, f.flush(collect, nullptr));
  TEST_ASSERT_EQUAL(2, g_pkts.size());
  TEST_ASSERT_EQUAL(1 + 62, g_pkts[1].size());
  TEST_ASSERT_EQUAL_HEX8(1, g_pkts[1][0]);
  TEST_ASSERT_EQUAL(0, f.flush(collect, nullptr));  // nothing pending
  TEST_ASSERT_EQUAL(2, g_pkts.size());
}

void test_seq_wraps_255_to_0() {
  AudioFramer f(19);  // 9 samples per packet
  auto s = ramp(9 * 300);
  f.push(s.data(), s.size(), collect, nullptr);
  TEST_ASSERT_EQUAL(300, g_pkts.size());
  for (size_t i = 0; i < g_pkts.size(); ++i) TEST_ASSERT_EQUAL_HEX8(i & 0xFF, g_pkts[i][0]);
  TEST_ASSERT_EQUAL_HEX8(255, g_pkts[255][0]);
  TEST_ASSERT_EQUAL_HEX8(0, g_pkts[256][0]);
}

void test_begin_resets_seq_and_pending() {
  AudioFramer f(240);
  auto s = ramp(500);
  f.push(s.data(), s.size(), collect, nullptr);
  TEST_ASSERT_TRUE(f.nextSeq() > 0);
  TEST_ASSERT_TRUE(f.pendingBytes() > 0);
  f.begin(240);
  TEST_ASSERT_EQUAL(0, f.nextSeq());
  TEST_ASSERT_EQUAL(0, f.pendingBytes());
}

void test_seq_advances_even_without_sink() {
  // A packet the caller could not queue still consumes a sequence number, so the phone sees a gap.
  AudioFramer f(19);
  auto s = ramp(18);
  f.push(s.data(), 18, nullptr, nullptr);
  TEST_ASSERT_EQUAL(2, f.nextSeq());
}

void test_odd_max_packet_rounds_payload_down() {
  AudioFramer f(240);
  TEST_ASSERT_EQUAL(238, f.payloadBytes());
  f.begin(241);  // clamped to 240
  TEST_ASSERT_EQUAL(238, f.payloadBytes());
  f.begin(1);  // clamped up to 3 -> one sample
  TEST_ASSERT_EQUAL(2, f.payloadBytes());
}

void test_one_second_of_audio_byte_count() {
  AudioFramer f(240);
  std::vector<int16_t> sec(16000, 7);
  size_t pcmBytes = 0;
  f.push(sec.data(), sec.size(), collect, nullptr);
  f.flush(collect, nullptr);
  for (auto& p : g_pkts) {
    TEST_ASSERT_TRUE(p.size() <= 240);
    pcmBytes += p.size() - 1;
  }
  TEST_ASSERT_EQUAL(32000, pcmBytes);
  TEST_ASSERT_EQUAL(135, g_pkts.size());  // ceil(32000 / 238)
}

void test_decode_control_write() {
  const uint8_t think = 0x10, reply = 0x11, attn = 0x12, start = 0x01, junk = 0x7F;
  const uint8_t multi[] = {0x11, 0xAA};
  TEST_ASSERT_TRUE(proto::decodeControlWrite(&think, 1) == proto::ControlCommand::Thinking);
  TEST_ASSERT_TRUE(proto::decodeControlWrite(&reply, 1) == proto::ControlCommand::ReplyDelivered);
  TEST_ASSERT_TRUE(proto::decodeControlWrite(&attn, 1) == proto::ControlCommand::NeedsAttention);
  TEST_ASSERT_TRUE(proto::decodeControlWrite(multi, 2) == proto::ControlCommand::ReplyDelivered);
  TEST_ASSERT_TRUE(proto::decodeControlWrite(&start, 1) == proto::ControlCommand::Unknown);
  TEST_ASSERT_TRUE(proto::decodeControlWrite(&junk, 1) == proto::ControlCommand::Unknown);
  TEST_ASSERT_TRUE(proto::decodeControlWrite(&think, 0) == proto::ControlCommand::Unknown);
  TEST_ASSERT_TRUE(proto::decodeControlWrite(nullptr, 1) == proto::ControlCommand::Unknown);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_protocol_constants_match_kotlin);
  RUN_TEST(test_packet_size_for_mtu);
  RUN_TEST(test_full_packets_are_seq_plus_le_pcm);
  RUN_TEST(test_partial_input_accumulates_and_flushes);
  RUN_TEST(test_seq_wraps_255_to_0);
  RUN_TEST(test_begin_resets_seq_and_pending);
  RUN_TEST(test_seq_advances_even_without_sink);
  RUN_TEST(test_odd_max_packet_rounds_payload_down);
  RUN_TEST(test_one_second_of_audio_byte_count);
  RUN_TEST(test_decode_control_write);
  return UNITY_END();
}
