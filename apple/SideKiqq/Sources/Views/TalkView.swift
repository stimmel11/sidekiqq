import SideKiqqKit
import SwiftUI

/**
 * Talk: one big button (tap to talk, tap again to send), the answer, and drafts to review.
 * When a draft was read back, a banner counts down the 30 s in which a spoken "send it" confirms.
 */
@MainActor
struct TalkView: View {
    @Environment(AppModel.self) private var model
    @State private var typed = ""
    @State private var reviewing: DraftRef?
    @FocusState private var typing: Bool

    private var voice: VoiceSession { model.voice }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: SideKiqqTheme.Space.s6) {
                    talkButton
                    Text(voice.phase.label)
                        .font(SKFont.h3)
                        .foregroundStyle(SideKiqqTheme.Palette.textMuted)
                        .accessibilityHidden(true)

                    if let deadline = voice.confirmDeadline, voice.pendingDraftId != nil {
                        ConfirmCountdown(deadline: deadline) {
                            Task { await voice.cancelPendingDraft() }
                        }
                    }
                    if let e = voice.errorMessage { ErrorBanner(message: e) }

                    if let t = voice.lastTranscript {
                        bubble(title: "You said", text: t)
                    }
                    if let a = voice.lastAnswer {
                        bubble(title: "SideKiqq", text: a.reply)
                        ForEach(a.draftActions) { action in
                            Button {
                                reviewing = DraftRef(id: action.id)
                            } label: {
                                Label("Review and send: \(action.summary)", systemImage: "envelope")
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.bordered)
                            .frame(minHeight: SideKiqqTheme.Layout.touchTarget)
                            .accessibilityHint("Shows the draft. Nothing is sent until you tap Send.")
                        }
                    }
                }
                .padding(SideKiqqTheme.Space.s4)
            }
            .safeAreaInset(edge: .bottom) { typeBar }
            .background(SideKiqqTheme.Palette.bg)
            .navigationTitle("Talk")
            .sheet(item: $reviewing) { ref in
                DraftLoaderSheet(ref: ref) { id in
                    voice.draftHandled(id)
                }
            }
        }
    }

    private var talkButton: some View {
        let listening = voice.phase == .listening
        let speaking = voice.phase == .speaking
        let busy = voice.phase == .thinking
        return Button {
            voice.toggle()
        } label: {
            ZStack {
                Circle()
                    .fill(listening ? SideKiqqTheme.Palette.danger : SideKiqqTheme.Palette.accent)
                    .frame(width: 160, height: 160)
                if busy {
                    ProgressView().tint(SideKiqqTheme.Palette.accentText).scaleEffect(1.6)
                } else {
                    Image(systemName: listening ? "stop.fill" : speaking ? "speaker.slash.fill" : "mic.fill")
                        .font(.system(size: 56, weight: .semibold))
                        .foregroundStyle(listening ? SideKiqqTheme.Palette.dangerText : SideKiqqTheme.Palette.accentText)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .padding(.top, SideKiqqTheme.Space.s8)
        .accessibilityLabel(listening ? "Stop and send" : speaking ? "Stop speaking" : "Talk to SideKiqq")
        .accessibilityValue(voice.phase.label)
        .accessibilityHint(listening ? "Sends what you said." : speaking ? "Stops the reply." : "Starts listening. Tap again when you're done.")
        .accessibilityAddTraits(.startsMediaSession)
    }

    private var typeBar: some View {
        HStack(spacing: SideKiqqTheme.Space.s2) {
            TextField("Or type a question", text: $typed, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .focused($typing)
                .submitLabel(.send)
                .onSubmit(sendTyped)
            Button(action: sendTyped) {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty || voice.phase != .idle)
            .frame(minWidth: SideKiqqTheme.Layout.touchTarget, minHeight: SideKiqqTheme.Layout.touchTarget)
            .accessibilityLabel("Ask")
        }
        .padding(SideKiqqTheme.Space.s3)
        .background(.bar)
    }

    private func sendTyped() {
        let text = typed
        typed = ""
        typing = false
        Task { await voice.ask(text) }
    }

    private func bubble(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: SideKiqqTheme.Space.s1) {
            Text(title.uppercased()).font(SKFont.data).foregroundStyle(SideKiqqTheme.Palette.textMuted)
            Text(text).font(SKFont.body).foregroundStyle(SideKiqqTheme.Palette.text).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SideKiqqTheme.Space.s3)
        .background(SideKiqqTheme.Palette.surface, in: RoundedRectangle(cornerRadius: SideKiqqTheme.Radius.lg))
        .accessibilityElement(children: .combine)
    }
}

/** "Say 'send it' within N s" banner. Purely informational: the voice actor enforces the window. */
private struct ConfirmCountdown: View {
    let deadline: Date
    let cancel: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, Int(deadline.timeIntervalSince(context.date).rounded(.up)))
            HStack(spacing: SideKiqqTheme.Space.s3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(left > 0 ? "Tap Talk and say \"send it\"" : "Not sent").font(SKFont.h3)
                    Text(left > 0 ? "\(left) s left. Anything else cancels." : "The draft is saved in Drafts.")
                        .font(SKFont.small)
                }
                Spacer()
                if left > 0 {
                    Button("Cancel", action: cancel)
                        .frame(minHeight: SideKiqqTheme.Layout.touchTarget)
                        .accessibilityLabel("Cancel sending")
                }
            }
            .padding(SideKiqqTheme.Space.s3)
            .background(SideKiqqTheme.importance("HIGH").bg, in: RoundedRectangle(cornerRadius: SideKiqqTheme.Radius.md))
            .accessibilityElement(children: .combine)
        }
    }
}
