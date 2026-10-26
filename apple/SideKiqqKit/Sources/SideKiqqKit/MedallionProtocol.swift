import Foundation

/**
 * Medallion GATT protocol. Binding definition in ARCHITECTURE.md; mirrors
 * android/phone MedallionProtocol.kt and medallion/src firmware.
 *
 * UUIDs are strings so this file has no CoreBluetooth dependency; the app wraps them in `CBUUID`.
 */
public enum MedallionProtocol {
    public static let serviceUUID = "5A1D0001-5E1D-4B1A-9E1D-51DE4B1A0001"
    /** notify: [seq:uint8][PCM16 LE, 16 kHz mono ...] up to 240 bytes per notification. */
    public static let audioUUID = "5A1D0002-5E1D-4B1A-9E1D-51DE4B1A0001"
    /** write/notify: a single opcode byte. */
    public static let controlUUID = "5A1D0003-5E1D-4B1A-9E1D-51DE4B1A0001"
    /** read/notify: uint8 percent. */
    public static let batteryUUID = "5A1D0004-5E1D-4B1A-9E1D-51DE4B1A0001"

    /** CONTROL opcodes. medallion -> phone: 0x01-0x03. phone -> medallion: 0x10-0x12. */
    public enum Control: UInt8, Sendable, CaseIterable {
        case startOfUtterance = 0x01
        case endOfUtterance = 0x02
        case cancel = 0x03
        /** Pulse the LED while the brain thinks. */
        case thinking = 0x10
        /** Short haptic: reply delivered (ends the LED pulse). */
        case replyDelivered = 0x11
        /** Double haptic: something needs attention (HIGH/CRITICAL alert). */
        case needsAttention = 0x12

        public var isFromMedallion: Bool { rawValue < 0x10 }
    }

    /** Max bytes per AUDIO notification including the seq byte. Needs an ATT MTU of at least 243. */
    public static let maxAudioChunk = 240
    /**
     * The MTU the Android phone requests. iOS negotiates MTU itself (usually 185 or 247+); the
     * firmware sizes chunks to the negotiated MTU, so this is informational on iPhone.
     */
    public static let desiredMTU = 247

    /** Battery percent from a BATTERY value (first byte, capped at 100). */
    public static func batteryPercent(_ value: Data) -> Int? {
        guard let b = value.first else { return nil }
        return min(Int(b), 100)
    }
}
