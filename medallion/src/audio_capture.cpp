#include "audio_capture.h"

#include <Arduino.h>
#include <driver/i2s.h>
#include <string.h>

#include "audio_dsp.h"
#include "audio_framer.h"
#include "config.h"

using namespace sidekiqq;

namespace audio {
namespace {

constexpr i2s_port_t kPort = I2S_NUM_0;  // PDM RX is only available on I2S0

enum CmdType : uint8_t { kCmdStart, kCmdStopFlush, kCmdStopDiscard };
struct Cmd {
  uint8_t type;
  uint16_t packetSize;
};

QueueHandle_t g_cmds = nullptr;
QueueHandle_t g_packets = nullptr;
SemaphoreHandle_t g_ack = nullptr;
TaskHandle_t g_task = nullptr;
volatile bool g_capturing = false;
volatile uint32_t g_dropped = 0;

AudioFramer g_framer;
DcBlockGain g_dsp(MIC_GAIN_Q8);
int16_t g_pcm[AUDIO_DMA_FRAMES];
#if MIC_TYPE == MIC_TYPE_I2S
int32_t g_raw[AUDIO_DMA_FRAMES];
#endif

void emitPacket(const uint8_t* pkt, size_t len, void*) {
  Packet p;
  p.len = static_cast<uint8_t>(len);
  memcpy(p.data, pkt, len);
  if (xQueueSend(g_packets, &p, 0) != pdTRUE) g_dropped = g_dropped + 1;
}

bool installDriver() {
  i2s_config_t cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.sample_rate = proto::kSampleRateHz;
  cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 6;
  cfg.dma_buf_len = AUDIO_DMA_FRAMES;
  cfg.use_apll = false;

  i2s_pin_config_t pins;
  memset(&pins, 0, sizeof(pins));
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  pins.data_out_num = I2S_PIN_NO_CHANGE;

#if MIC_TYPE == MIC_TYPE_PDM
  cfg.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM);
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  pins.bck_io_num = I2S_PIN_NO_CHANGE;
  pins.ws_io_num = PIN_PDM_CLK;
  pins.data_in_num = PIN_PDM_DATA;
#else
  cfg.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX);
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  pins.bck_io_num = PIN_I2S_BCLK;
  pins.ws_io_num = PIN_I2S_WS;
  pins.data_in_num = PIN_I2S_DIN;
#endif

  esp_err_t err = i2s_driver_install(kPort, &cfg, 0, nullptr);
  if (err != ESP_OK) {
    log_e("i2s_driver_install: %d", err);
    return false;
  }
  err = i2s_set_pin(kPort, &pins);
  if (err != ESP_OK) {
    log_e("i2s_set_pin: %d", err);
    return false;
  }
  i2s_stop(kPort);  // the driver starts the clock on install; keep the mic asleep until PTT
  return true;
}

// Reads one DMA block into g_pcm. Returns samples read.
size_t readBlock() {
  size_t bytes = 0;
#if MIC_TYPE == MIC_TYPE_PDM
  i2s_read(kPort, g_pcm, sizeof(g_pcm), &bytes, pdMS_TO_TICKS(100));
  return bytes / sizeof(int16_t);
#else
  i2s_read(kPort, g_raw, sizeof(g_raw), &bytes, pdMS_TO_TICKS(100));
  const size_t n = bytes / sizeof(int32_t);
  for (size_t i = 0; i < n; ++i) g_pcm[i] = i2s32ToPcm16(g_raw[i], I2S_SAMPLE_SHIFT);
  return n;
#endif
}

void handle(const Cmd& c, uint32_t* warmupSamples) {
  switch (c.type) {
    case kCmdStart:
      xQueueReset(g_packets);
      g_dropped = 0;
      g_framer.begin(c.packetSize);
      g_dsp.reset();
      i2s_zero_dma_buffer(kPort);
      i2s_start(kPort);
      *warmupSamples = (proto::kSampleRateHz / 1000) * MIC_WARMUP_MS;
      g_capturing = true;
      break;
    case kCmdStopFlush:
      if (g_capturing) {
        i2s_stop(kPort);
        g_framer.flush(emitPacket, nullptr);
      }
      g_capturing = false;
      xSemaphoreGive(g_ack);
      break;
    case kCmdStopDiscard:
      if (g_capturing) i2s_stop(kPort);
      g_capturing = false;
      xQueueReset(g_packets);
      xSemaphoreGive(g_ack);
      break;
  }
}

void captureTask(void*) {
  uint32_t warmup = 0;
  Cmd cmd;
  for (;;) {
    if (!g_capturing) {
      if (xQueueReceive(g_cmds, &cmd, portMAX_DELAY) == pdTRUE) handle(cmd, &warmup);
      continue;
    }
    if (xQueueReceive(g_cmds, &cmd, 0) == pdTRUE) {
      handle(cmd, &warmup);
      continue;
    }
    size_t n = readBlock();
    if (n == 0) continue;
    int16_t* s = g_pcm;
    if (warmup > 0) {
      const size_t skip = warmup < n ? warmup : n;
      warmup -= skip;
      s += skip;
      n -= skip;
      if (n == 0) continue;
    }
    g_dsp.process(s, n);
    g_framer.push(s, n, emitPacket, nullptr);
  }
}

}  // namespace

bool begin() {
  g_cmds = xQueueCreate(4, sizeof(Cmd));
  g_packets = xQueueCreate(AUDIO_PACKET_QUEUE, sizeof(Packet));
  g_ack = xSemaphoreCreateBinary();
  if (g_cmds == nullptr || g_packets == nullptr || g_ack == nullptr) {
    log_e("audio: out of memory");
    return false;
  }
  if (!installDriver()) return false;
  // Core 1 next to the Arduino loop; the NimBLE host runs on core 0.
  return xTaskCreatePinnedToCore(captureTask, "mic", 4096, nullptr, 5, &g_task, 1) == pdPASS;
}

void start(size_t packetSize) {
  if (g_cmds == nullptr) return;
  Cmd c{kCmdStart, static_cast<uint16_t>(packetSize)};
  xQueueSend(g_cmds, &c, pdMS_TO_TICKS(50));
}

void stop(bool flush) {
  if (g_cmds == nullptr) return;
  xSemaphoreTake(g_ack, 0);  // clear a stale ack
  Cmd c{static_cast<uint8_t>(flush ? kCmdStopFlush : kCmdStopDiscard), 0};
  if (xQueueSend(g_cmds, &c, pdMS_TO_TICKS(50)) == pdTRUE) {
    xSemaphoreTake(g_ack, pdMS_TO_TICKS(250));  // one i2s_read is at most ~100 ms
  }
}

bool capturing() { return g_capturing; }

bool peek(Packet* out) { return g_packets != nullptr && xQueuePeek(g_packets, out, 0) == pdTRUE; }

void pop() {
  Packet tmp;
  if (g_packets != nullptr) xQueueReceive(g_packets, &tmp, 0);
}

size_t queued() { return g_packets == nullptr ? 0 : uxQueueMessagesWaiting(g_packets); }

uint32_t dropped() { return g_dropped; }

}  // namespace audio
