import SideKiqqKit
import SwiftUI

@MainActor
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var medallionOn = false
    @State private var brainVoice = false
    @State private var confirmUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                Section("This iPhone") {
                    LabeledContent("Brain", value: model.credentials?.baseURL ?? "Not paired")
                    LabeledContent("Paired as", value: model.credentials?.device?.rawValue ?? DeviceKind.thisIPhone.rawValue)
                    LabeledContent("Audio output", value: AudioRouting.currentOutputName)
                }

                Section {
                    Toggle("Use SideKiqq's voice", isOn: $brainVoice)
                        .onChange(of: brainVoice) { _, on in model.speaker.useBrainVoice = on }
                } header: {
                    Text("Spoken replies")
                } footer: {
                    Text("Off: the iPhone's own voice (instant, works offline). On: the brain's voice, the same one Reachy uses.")
                }

                Section {
                    Toggle("Medallion", isOn: $medallionOn)
                        .onChange(of: medallionOn) { _, on in on ? model.medallion.start() : model.medallion.stop() }
                    if medallionOn { MedallionStatusRows(status: model.medallionStatus) }
                } header: {
                    Text("Medallion")
                } footer: {
                    Text("Press and hold the medallion to talk. Replies play on your AirPods or the iPhone speaker.")
                }

                Section {
                    Button("Unpair this iPhone", role: .destructive) { confirmUnpair = true }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear {
                medallionOn = model.medallion.isEnabled
                brainVoice = model.speaker.useBrainVoice
            }
            .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    model.unpair()
                    dismiss()
                }
            } message: {
                Text("You'll need a new pairing code from the dashboard. Revoke the old token there too.")
            }
        }
    }
}

private struct MedallionStatusRows: View {
    let status: MedallionStatus

    var body: some View {
        LabeledContent("Status", value: status.phase.rawValue)
        if let name = status.deviceName { LabeledContent("Device", value: name) }
        if let b = status.battery { LabeledContent("Battery", value: "\(b)%") }
        if let p = status.maxPacket { LabeledContent("Packet size", value: "\(p) bytes") }
        if let w = status.lastAudioWarning {
            Text(w).font(SKFont.small).foregroundStyle(SideKiqqTheme.Palette.dangerInk)
        }
        if let t = status.lastTranscript {
            LabeledContent("Last heard", value: t)
        }
    }
}
