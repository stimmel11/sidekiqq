import CoreBluetooth
import Foundation
import Observation
import SideKiqqKit
import UIKit

/** What the Settings screen shows about the medallion. Updated on the main actor. */
@MainActor
@Observable
final class MedallionStatus {
    enum Phase: String {
        case off = "Off"
        case bluetoothOff = "Bluetooth is off"
        case unauthorized = "Bluetooth permission needed"
        case scanning = "Looking for your medallion"
        case connecting = "Connecting"
        case connected = "Connected"
        case listening = "Listening"
        case thinking = "Thinking"
        case speaking = "Speaking"
    }

    var phase: Phase = .off
    var deviceName: String?
    var battery: Int?
    /** Largest notification payload iOS negotiated (ATT MTU - 3). */
    var maxPacket: Int?
    var lastTranscript: String?
    var lastReply: String?
    var lastAudioWarning: String?
}

/**
 * CoreBluetooth relay for the SideKiqq medallion. Same GATT protocol and flow as
 * android/phone MedallionService.kt:
 *
 * scan for SERVICE -> connect -> notify on AUDIO, CONTROL, BATTERY -> CONTROL 0x01 starts an utterance,
 * AUDIO packets are reassembled (UtteranceAssembler), CONTROL 0x02 ends it -> WAV -> /api/transcribe ->
 * /api/ask(device: medallion), with CONTROL 0x10 written while thinking -> speak `spoken` on the
 * current route (AirPods / glasses / speaker) -> CONTROL 0x11. HIGH/CRITICAL alerts write 0x12.
 *
 * iPhone specifics:
 *  - MTU: iOS negotiates it (no request API). The firmware asks for 247 and sizes packets to what it gets.
 *  - Background: `bluetooth-central` background mode + state restoration (restore identifier), so iOS
 *    relaunches the app when the medallion sends a notification. A pending `connect` never times out,
 *    so after a drop we just call `connect` again and iOS reconnects when the medallion is back in range.
 *
 * All CoreBluetooth work happens on `queue`; mutable state is only touched there.
 */
final class MedallionManager: NSObject, @unchecked Sendable, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let restoreIdentifier = "com.sidekiqq.medallion.central"
    private static let enabledKey = "medallion.enabled"
    private static let peripheralKey = "medallion.peripheral"
    private static let utteranceIdle: TimeInterval = 3

    private let serviceUUID = CBUUID(string: MedallionProtocol.serviceUUID)
    private let audioUUID = CBUUID(string: MedallionProtocol.audioUUID)
    private let controlUUID = CBUUID(string: MedallionProtocol.controlUUID)
    private let batteryUUID = CBUUID(string: MedallionProtocol.batteryUUID)

    private let queue = DispatchQueue(label: "com.sidekiqq.medallion.ble")
    private let assistant: VoiceAssistant
    private let speaker: Speaker
    private let status: MedallionStatus

    // queue-confined
    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var control: CBCharacteristic?
    private var assembler = UtteranceAssembler()
    /** When the current utterance began (CONTROL 0x01 or the first AUDIO packet). */
    private var utteranceStartedAt: Date?
    private var idleTimer: DispatchWorkItem?
    private var wantsConnection = false

    private struct Captured: Sendable {
        let utterance: UtteranceAssembler.Utterance
        let startedAt: Date
    }

    private let utterances: AsyncStream<Captured>
    private let utteranceSink: AsyncStream<Captured>.Continuation

    init(assistant: VoiceAssistant, speaker: Speaker, status: MedallionStatus) {
        self.assistant = assistant
        self.speaker = speaker
        self.status = status
        // Like Android's Channel(capacity = 2): if the pipeline is busy, keep at most two queued utterances.
        (utterances, utteranceSink) = AsyncStream.makeStream(of: Captured.self, bufferingPolicy: .bufferingOldest(2))
        super.init()
        Task { [weak self] in
            guard let stream = self?.utterances else { return }
            for await u in stream { await self?.process(u) }
        }
    }

    var isEnabled: Bool { UserDefaults.standard.bool(forKey: Self.enabledKey) }

    // MARK: - Public (any thread)

    /** Turns the medallion link on. Creating the central shows the Bluetooth permission prompt the first time. */
    func start() {
        UserDefaults.standard.set(true, forKey: Self.enabledKey)
        queue.async {
            self.wantsConnection = true
            if let central = self.central {
                if central.state == .poweredOn { self.connectOrScan() }
            } else {
                self.central = CBCentralManager(delegate: self, queue: self.queue, options: [
                    CBCentralManagerOptionRestoreIdentifierKey: Self.restoreIdentifier,
                    CBCentralManagerOptionShowPowerAlertKey: true,
                ])
            }
        }
    }

    /** Turns it off and forgets nothing but the "enabled" flag (the paired peripheral id is kept). */
    func stop() {
        UserDefaults.standard.set(false, forKey: Self.enabledKey)
        queue.async {
            self.wantsConnection = false
            self.central?.stopScan()
            if let p = self.peripheral { self.central?.cancelPeripheralConnection(p) }
            self.peripheral = nil
            self.control = nil
            self.assembler.cancel()
            self.idleTimer?.cancel()
            self.setPhase(.off)
            self.updateStatus { $0.battery = nil; $0.deviceName = nil }
        }
    }

    /** Forget the remembered medallion so the next start scans for a new one. */
    func forgetMedallion() {
        UserDefaults.standard.removeObject(forKey: Self.peripheralKey)
    }

    /** CONTROL 0x12 (double haptic). No-op when no medallion is connected. */
    func signalNeedsAttention() {
        writeControl(.needsAttention)
    }

    // MARK: - Connection (queue)

    private func connectOrScan() {
        guard let central, wantsConnection, central.state == .poweredOn else { return }
        if let p = peripheral, p.state == .connected || p.state == .connecting { return }
        if let idString = UserDefaults.standard.string(forKey: Self.peripheralKey), let id = UUID(uuidString: idString),
           let known = central.retrievePeripherals(withIdentifiers: [id]).first {
            connect(known)
            return
        }
        if let already = central.retrieveConnectedPeripherals(withServices: [serviceUUID]).first {
            connect(already)
            return
        }
        setPhase(.scanning)
        // A service-UUID filter is required for scanning in the background.
        central.scanForPeripherals(withServices: [serviceUUID], options: nil)
    }

    private func connect(_ p: CBPeripheral) {
        peripheral = p
        p.delegate = self
        setPhase(.connecting)
        let name = p.name
        updateStatus { $0.deviceName = name ?? "SideKiqq medallion" }
        central?.connect(p, options: nil)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if wantsConnection { connectOrScan() }
        case .poweredOff:
            setPhase(.bluetoothOff)
        case .unauthorized:
            setPhase(.unauthorized)
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        // iOS relaunched us for the medallion: pick the connection back up.
        wantsConnection = UserDefaults.standard.bool(forKey: Self.enabledKey)
        guard let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first else { return }
        peripheral = restored
        restored.delegate = self
        if restored.state == .connected { discover(restored) }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        central.stopScan()
        UserDefaults.standard.set(peripheral.identifier.uuidString, forKey: Self.peripheralKey)
        connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        UserDefaults.standard.set(peripheral.identifier.uuidString, forKey: Self.peripheralKey)
        discover(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        reconnectLater(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        control = nil
        if assembler.isActive { assembler.cancel() }
        idleTimer?.cancel()
        updateStatus { $0.battery = nil }
        reconnectLater(peripheral)
    }

    private func reconnectLater(_ p: CBPeripheral) {
        guard wantsConnection else { setPhase(.off); return }
        setPhase(.connecting)
        // A pending connect has no timeout: iOS completes it whenever the medallion comes back.
        central?.connect(p, options: nil)
    }

    private func discover(_ p: CBPeripheral) {
        if let svc = p.services?.first(where: { $0.uuid == serviceUUID }) {
            p.discoverCharacteristics([audioUUID, controlUUID, batteryUUID], for: svc)
        } else {
            p.discoverServices([serviceUUID])
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            central?.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([audioUUID, controlUUID, batteryUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for c in service.characteristics ?? [] {
            switch c.uuid {
            case controlUUID:
                control = c
                peripheral.setNotifyValue(true, for: c)
            case audioUUID:
                peripheral.setNotifyValue(true, for: c)
            case batteryUUID:
                peripheral.setNotifyValue(true, for: c)
                peripheral.readValue(for: c)
            default:
                break
            }
        }
        let maxPacket = peripheral.maximumWriteValueLength(for: .withoutResponse)
        updateStatus { $0.maxPacket = maxPacket }
        setPhase(.connected)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let value = characteristic.value else { return }
        switch characteristic.uuid {
        case audioUUID:
            onAudio(value)
        case controlUUID:
            if let op = value.first { onControl(op) }
        case batteryUUID:
            let pct = MedallionProtocol.batteryPercent(value)
            updateStatus { $0.battery = pct }
        default:
            break
        }
    }

    // MARK: - Protocol (queue)

    private func onControl(_ byte: UInt8) {
        switch MedallionProtocol.Control(rawValue: byte) {
        case .startOfUtterance:
            assembler.start()
            utteranceStartedAt = Date()
            // Barge-in: the owner is talking again, stop any reply still playing.
            Task { @MainActor [speaker] in speaker.stop() }
            setPhase(.listening)
            armIdleTimer()
        case .endOfUtterance:
            finishUtterance()
        case .cancel:
            assembler.cancel()
            idleTimer?.cancel()
            setPhase(.connected)
        default:
            break // phone->medallion opcodes echoed back, or unknown: ignore
        }
    }

    private func onAudio(_ packet: Data) {
        if !assembler.isActive {
            // Tolerate a lost START notification: begin capturing at the first audio packet.
            assembler.start()
            utteranceStartedAt = Date()
            setPhase(.listening)
        }
        assembler.onAudio(packet)
        armIdleTimer()
    }

    private func armIdleTimer() {
        idleTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.finishUtterance() }
        idleTimer = item
        queue.asyncAfter(deadline: .now() + Self.utteranceIdle, execute: item)
    }

    private func finishUtterance() {
        idleTimer?.cancel()
        guard let u = assembler.finish() else { return }
        let startedAt = utteranceStartedAt ?? Date()
        utteranceStartedAt = nil
        let warning = u.stats.warning
        updateStatus { $0.lastAudioWarning = warning }
        // startedAt lets VoiceAssistant reject a "send it" that was spoken over (or queued behind) a read-back.
        if case .dropped(_) = utteranceSink.yield(Captured(utterance: u, startedAt: startedAt)) {
            setPhase(.connected) // pipeline busy; drop like Android
        }
    }

    private func writeControl(_ op: MedallionProtocol.Control) {
        queue.async {
            guard let p = self.peripheral, p.state == .connected, let c = self.control else { return }
            let type: CBCharacteristicWriteType = c.properties.contains(.write) ? .withResponse : .withoutResponse
            p.writeValue(Data([op.rawValue]), for: c, type: type)
        }
    }

    // MARK: - Pipeline

    private func process(_ captured: Captured) async {
        let bg = await BackgroundActivity.begin("medallion-utterance")
        setPhase(.thinking)
        writeControl(.thinking)
        let outcome = await assistant.handleUtterance(pcm: captured.utterance.pcm, device: .medallion,
                                                      output: MedallionOutput(manager: self),
                                                      startedAt: captured.startedAt)
        if case let .answered(transcript, response, _) = outcome {
            updateStatus { $0.lastTranscript = transcript; $0.lastReply = response.reply }
        }
        // 0x11 ends the LED pulse with a short haptic, whatever the outcome.
        writeControl(.replyDelivered)
        queue.async { self.setPhase(self.control != nil ? .connected : .connecting) }
        await BackgroundActivity.end(bg)
    }

    fileprivate func speak(_ text: String) async -> Bool {
        setPhase(.speaking)
        let completed = await speaker.speak(text)
        setPhase(.thinking)
        return completed
    }

    // MARK: - Status

    private func setPhase(_ p: MedallionStatus.Phase) {
        Task { @MainActor [status] in status.phase = p }
    }

    private func updateStatus(_ change: @escaping @MainActor @Sendable (MedallionStatus) -> Void) {
        Task { @MainActor [status] in change(status) }
    }
}

private struct MedallionOutput: VoiceOutput {
    let manager: MedallionManager
    @discardableResult
    func speak(_ text: String) async -> Bool { await manager.speak(text) }
}

/** Asks iOS for extra time when an utterance arrives while the app is in the background. */
@MainActor
enum BackgroundActivity {
    final class Token: @unchecked Sendable {
        fileprivate var id: UIBackgroundTaskIdentifier = .invalid
    }

    static func begin(_ name: String) -> Token {
        let token = Token()
        token.id = UIApplication.shared.beginBackgroundTask(withName: name) {
            // Expired (called on the main thread): end it now so iOS doesn't kill the app.
            MainActor.assumeIsolated { end(token) }
        }
        return token
    }

    static func end(_ token: Token) {
        guard token.id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(token.id)
        token.id = .invalid
    }
}
