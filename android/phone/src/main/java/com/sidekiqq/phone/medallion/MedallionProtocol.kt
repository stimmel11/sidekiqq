package com.sidekiqq.phone.medallion

import java.util.UUID

/** Medallion GATT protocol — binding definition in ARCHITECTURE.md. */
object MedallionProtocol {
    val SERVICE: UUID = UUID.fromString("5a1d0001-5e1d-4b1a-9e1d-51de4b1a0001")
    /** notify: [seq:uint8][PCM16 LE, 16 kHz mono ...] up to 240 bytes per notification */
    val AUDIO: UUID = UUID.fromString("5a1d0002-5e1d-4b1a-9e1d-51de4b1a0001")
    /** write/notify: single opcode byte */
    val CONTROL: UUID = UUID.fromString("5a1d0003-5e1d-4b1a-9e1d-51de4b1a0001")
    /** read/notify: uint8 percent */
    val BATTERY: UUID = UUID.fromString("5a1d0004-5e1d-4b1a-9e1d-51de4b1a0001")

    /** Standard Client Characteristic Configuration Descriptor. */
    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    // medallion -> phone
    const val CTRL_START: Byte = 0x01
    const val CTRL_END: Byte = 0x02
    const val CTRL_CANCEL: Byte = 0x03

    // phone -> medallion
    const val CTRL_THINKING: Byte = 0x10
    const val CTRL_REPLY_DELIVERED: Byte = 0x11
    const val CTRL_NEEDS_ATTENTION: Byte = 0x12

    /** Max bytes per AUDIO notification (incl. seq byte), so request MTU >= 240 + 3 ATT header. */
    const val MAX_AUDIO_CHUNK = 240
    const val DESIRED_MTU = 247
}
