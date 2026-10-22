// BLE peripheral: the SideKiqq GATT service (protocol.h), advertising and reconnect.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace ble {

void begin(uint8_t initialBatteryPct);

// Call every loop: restarts advertising after a disconnect, switches fast -> slow advertising.
void loop(uint32_t nowMs);

bool connected();
// Connected AND the phone enabled notifications on AUDIO and CONTROL (MedallionService does
// this right after service discovery). Only then is it worth starting an utterance.
bool readyForAudio();
uint16_t mtu();

// Non-blocking. Returns false when the controller is out of buffers (retry later) or the link
// is gone; the caller keeps the packet and retries.
bool sendAudio(const uint8_t* pkt, size_t len);

// Sends a medallion -> phone CONTROL opcode, retrying briefly if buffers are full.
bool sendControl(uint8_t op);

// Updates the BATTERY value (always readable); notifies if subscribed and `notify`.
void setBattery(uint8_t pct, bool notify);

// Request short connection intervals while streaming audio, long ones while idle.
void requestFastLink(bool fast);

// Phone -> medallion CONTROL writes are queued from the BLE host task; drain them on the loop.
bool pollControl(uint8_t* op);

// Increments on every connect and disconnect, so the main loop notices transitions (even a
// quick drop-and-reconnect) between two polls.
uint32_t linkEpoch();

}  // namespace ble
