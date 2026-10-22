#include "ble_link.h"

#include <Arduino.h>
#include <NimBLEDevice.h>

#include "config.h"
#include "protocol.h"

using namespace sidekiqq;

namespace ble {
namespace {

constexpr uint16_t kNoConn = 0xFFFF;  // BLE_HS_CONN_HANDLE_NONE

NimBLEServer* g_server = nullptr;
NimBLECharacteristic* g_audio = nullptr;
NimBLECharacteristic* g_control = nullptr;
NimBLECharacteristic* g_battery = nullptr;
QueueHandle_t g_ctrlQueue = nullptr;

volatile uint16_t g_conn = kNoConn;
volatile uint16_t g_mtu = 23;
volatile uint32_t g_epoch = 0;
volatile uint32_t g_linkChangedAt = 0;
bool g_fastAdv = true;
int8_t g_linkMode = -1;  // -1 = whatever the phone chose, 0 = idle params, 1 = fast params

uint16_t msToAdvUnits(uint32_t ms) { return static_cast<uint16_t>((ms * 1000UL) / 625UL); }

void configureAdvertising(bool fast) {
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  const uint16_t units = msToAdvUnits(fast ? ADV_FAST_INTERVAL_MS : ADV_SLOW_INTERVAL_MS);
  adv->setMinInterval(units);
  adv->setMaxInterval(units + (fast ? 16 : 160));
  g_fastAdv = fast;
}

void startAdvertising(bool fast) {
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  if (adv->isAdvertising()) adv->stop();
  configureAdvertising(fast);
  adv->start();
  log_i("advertising (%s)", fast ? "fast" : "slow");
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, ble_gap_conn_desc* desc) override {
    g_conn = desc->conn_handle;
    g_mtu = 23;
    g_linkMode = -1;
    g_epoch = g_epoch + 1;
    g_linkChangedAt = millis();
    // Data Length Extension: lets one 240-byte notification ride in a single LL packet.
    server->setDataLen(desc->conn_handle, 251);
    // 2M PHY doubles air throughput and halves radio-on time; the phone may refuse, that's fine.
    ble_gap_set_prefered_le_phy(desc->conn_handle, BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_2M_MASK,
                                BLE_GAP_LE_PHY_CODED_ANY);
    log_i("connected (handle %u)", desc->conn_handle);
  }

  void onDisconnect(NimBLEServer*, ble_gap_conn_desc*) override {
    log_i("disconnected");
    g_conn = kNoConn;
    g_mtu = 23;
    g_epoch = g_epoch + 1;
    g_linkChangedAt = millis();
    // Advertising restarts from ble::loop (fast first, so the phone's autoConnect finds us quickly).
  }

  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    g_mtu = mtu;
    log_i("MTU %u -> audio packet %u bytes", mtu, (unsigned)(mtu > 3 ? mtu - 3 : 0));
  }
};

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    NimBLEAttValue v = c->getValue();
    if (v.length() == 0 || g_ctrlQueue == nullptr) return;
    const uint8_t op = v.data()[0];
    xQueueSend(g_ctrlQueue, &op, 0);
  }
};

ServerCallbacks g_serverCallbacks;
ControlCallbacks g_controlCallbacks;

// Notification with real back-pressure: NimBLECharacteristic::notify() silently drops when the
// host is out of mbufs; ble_gattc_notify_custom reports it so we can retry.
bool notifyRaw(NimBLECharacteristic* c, const uint8_t* data, size_t len) {
  const uint16_t conn = g_conn;
  if (conn == kNoConn || c == nullptr) return false;
  os_mbuf* om = ble_hs_mbuf_from_flat(data, static_cast<uint16_t>(len));
  if (om == nullptr) return false;
  // The host consumes `om` whether or not the call succeeds.
  return ble_gattc_notify_custom(conn, c->getHandle(), om) == 0;
}

}  // namespace

void begin(uint8_t initialBatteryPct) {
  g_ctrlQueue = xQueueCreate(8, sizeof(uint8_t));

  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setPower(BLE_TX_POWER);
  NimBLEDevice::setMTU(proto::kDesiredMtu);
  // No pairing/bonding: MedallionService.kt connects without createBond(). See HARDWARE.md.
  NimBLEDevice::setSecurityAuth(false, false, false);

  g_server = NimBLEDevice::createServer();
  g_server->setCallbacks(&g_serverCallbacks, false);
  g_server->advertiseOnDisconnect(false);

  NimBLEService* svc = g_server->createService(proto::kServiceUuid);
  g_audio = svc->createCharacteristic(proto::kAudioUuid, NIMBLE_PROPERTY::NOTIFY);
  g_control = svc->createCharacteristic(
      proto::kControlUuid, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::NOTIFY);
  g_control->setCallbacks(&g_controlCallbacks);
  g_battery = svc->createCharacteristic(proto::kBatteryUuid, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  g_battery->setValue(&initialBatteryPct, 1);
  svc->start();

  // Advertisement: flags + complete 128-bit service UUID (21 of 31 bytes). The phone's
  // ScanFilter matches on this UUID, so it must be in the primary advertisement, not only in
  // the scan response. The name goes in the scan response.
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  NimBLEAdvertisementData advData;
  advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  advData.setCompleteServices(NimBLEUUID(proto::kServiceUuid));
  NimBLEAdvertisementData scanData;
  scanData.setName(DEVICE_NAME);
  adv->setAdvertisementData(advData);
  adv->setScanResponseData(scanData);
  adv->setScanResponse(true);

  g_linkChangedAt = millis();
  startAdvertising(true);
}

void loop(uint32_t nowMs) {
  if (g_conn != kNoConn) {
    // MedallionService asks for CONNECTION_PRIORITY_HIGH on connect; once service discovery and
    // CCCD writes are done, drop to the idle interval so an idle-but-connected medallion sleeps.
    if (g_linkMode < 0 && (nowMs - g_linkChangedAt) > 5000) requestFastLink(false);
    return;
  }
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  const bool wantFast = (nowMs - g_linkChangedAt) < ADV_FAST_WINDOW_MS;
  if (!adv->isAdvertising()) {
    startAdvertising(wantFast);
  } else if (g_fastAdv && !wantFast) {
    startAdvertising(false);
  }
}

bool connected() { return g_conn != kNoConn; }

bool readyForAudio() {
  return connected() && g_audio->getSubscribedCount() > 0 && g_control->getSubscribedCount() > 0;
}

uint16_t mtu() { return g_mtu; }

bool sendAudio(const uint8_t* pkt, size_t len) { return notifyRaw(g_audio, pkt, len); }

bool sendControl(uint8_t op) {
  g_control->setValue(&op, 1);
  for (int attempt = 0; attempt < 50; ++attempt) {  // up to ~250 ms
    if (!connected()) return false;
    if (notifyRaw(g_control, &op, 1)) return true;
    delay(5);
  }
  log_w("CONTROL 0x%02x not sent (no buffers)", op);
  return false;
}

void setBattery(uint8_t pct, bool notify) {
  g_battery->setValue(&pct, 1);
  if (notify && connected() && g_battery->getSubscribedCount() > 0) notifyRaw(g_battery, &pct, 1);
}

void requestFastLink(bool fast) {
  const uint16_t conn = g_conn;
  const int8_t mode = fast ? 1 : 0;
  if (conn == kNoConn || mode == g_linkMode) return;
  g_linkMode = mode;
  if (fast) {
    g_server->updateConnParams(conn, CONN_FAST_MIN, CONN_FAST_MAX, CONN_FAST_LATENCY, CONN_TIMEOUT);
  } else {
    g_server->updateConnParams(conn, CONN_IDLE_MIN, CONN_IDLE_MAX, CONN_IDLE_LATENCY, CONN_TIMEOUT);
  }
}

bool pollControl(uint8_t* op) {
  return g_ctrlQueue != nullptr && xQueueReceive(g_ctrlQueue, op, 0) == pdTRUE;
}

uint32_t linkEpoch() { return g_epoch; }

}  // namespace ble
