import SideKiqqKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.isPaired {
            MainTabView()
        } else {
            PairingView()
        }
    }
}

struct MainTabView: View {
    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Today", systemImage: "sun.max") }
            FollowUpsView()
                .tabItem { Label("Follow-ups", systemImage: "person.2.wave.2") }
            TalkView()
                .tabItem { Label("Talk", systemImage: "mic.circle") }
            CommitmentsView()
                .tabItem { Label("Commitments", systemImage: "checklist") }
            DraftsView()
                .tabItem { Label("Drafts", systemImage: "envelope") }
        }
    }
}

@MainActor
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("pairing.lastURL") private var urlText = ""
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case url, code }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: SideKiqqTheme.Space.s2) {
                        Text("SideKiqq")
                            .font(SKFont.h1)
                            .foregroundStyle(SideKiqqTheme.Palette.text)
                        Text(SideKiqqTheme.tagline)
                            .font(SKFont.body)
                            .foregroundStyle(SideKiqqTheme.Palette.textMuted)
                    }
                    .accessibilityElement(children: .combine)
                    .listRowBackground(Color.clear)
                }
                Section {
                    TextField("sidekiqq.vercel.app", text: $urlText)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .url)
                        .submitLabel(.next)
                        .onSubmit { focus = .code }
                        .accessibilityLabel("Brain address")
                } header: {
                    Text("Brain address")
                } footer: {
                    Text("The web address of your SideKiqq brain on Vercel.")
                }
                Section {
                    TextField("123456", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(SKFont.h2.monospacedDigit())
                        .focused($focus, equals: .code)
                        .accessibilityLabel("Pairing code, 6 digits")
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("On the dashboard, open Devices and generate a code. It works once and expires in a few minutes.")
                }
                if let error {
                    Section { ErrorBanner(message: error) }
                }
                Section {
                    Button {
                        pair()
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("Pair this iPhone").fontWeight(.semibold) }
                            Spacer()
                        }
                        .frame(minHeight: SideKiqqTheme.Layout.touchTarget)
                    }
                    .disabled(busy || SideKiqqClient.normalizePairingCode(code) == nil || urlText.isEmpty)
                }
            }
            .navigationTitle("Pair")
        }
    }

    private func pair() {
        busy = true
        error = nil
        Task {
            do {
                try await model.pair(urlText: urlText, code: code)
                code = ""
            } catch {
                self.error = error.friendly
            }
            busy = false
        }
    }
}
