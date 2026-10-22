import SideKiqqKit
import SwiftUI

/**
 * The confirm-to-send sheet: the ONLY UI that can send a draft. It shows the recipients, subject and
 * full body; nothing is sent until the owner taps Send. Cancel is the default (Escape / swipe down).
 */
@MainActor
struct DraftConfirmSheet: View {
    let draft: Draft
    /** Called after a successful send, with the draft id. */
    var onSent: (String) -> Void = { _ in }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SideKiqqTheme.Space.s4) {
                    field("To", draft.to.joined(separator: ", "))
                    if !draft.cc.isEmpty { field("Cc", draft.cc.joined(separator: ", ")) }
                    field("Subject", draft.subject.isEmpty ? "(no subject)" : draft.subject)
                    if let client = draft.client { field("Client", client) }
                    Divider()
                    Text(draft.body)
                        .font(SKFont.body)
                        .foregroundStyle(SideKiqqTheme.Palette.text)
                        .textSelection(.enabled)
                        .accessibilityLabel("Message: \(draft.body)")
                    Text("Nothing is sent until you tap Send.")
                        .font(SKFont.small)
                        .foregroundStyle(SideKiqqTheme.Palette.textMuted)
                    if let error { ErrorBanner(message: error) }
                }
                .padding(SideKiqqTheme.Space.s4)
            }
            .background(SideKiqqTheme.Palette.bg)
            .navigationTitle("Review and send")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityHint("Closes without sending. The draft stays saved.")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView().accessibilityLabel("Sending")
                    } else {
                        Button("Send") { send() }
                            .fontWeight(.semibold)
                            .accessibilityLabel("Send email to \(DraftConfirmation.spokenRecipients(draft.to))")
                    }
                }
            }
            .interactiveDismissDisabled(sending)
        }
    }

    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(SKFont.data)
                .foregroundStyle(SideKiqqTheme.Palette.textMuted)
            Text(value)
                .font(SKFont.body)
                .foregroundStyle(SideKiqqTheme.Palette.text)
        }
        .accessibilityElement(children: .combine)
    }

    private func send() {
        sending = true
        error = nil
        Task {
            do {
                try await model.approveDraftConfirmed(draft)
                onSent(draft.id)
                dismiss()
            } catch {
                self.error = error.friendly
            }
            sending = false
        }
    }
}

/**
 * Fetches a draft by id (from a follow-up or an answer) and presents the confirm sheet.
 * Use with `.sheet(item:)` on a `DraftRef`.
 */
struct DraftRef: Identifiable, Hashable {
    let id: String
}

@MainActor
struct DraftLoaderSheet: View {
    let ref: DraftRef
    var onSent: (String) -> Void = { _ in }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: Draft?
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        Group {
            if let draft {
                DraftConfirmSheet(draft: draft, onSent: onSent)
            } else if loaded {
                NavigationStack {
                    EmptyStateView(title: "Draft not available",
                                   message: error ?? "It was already sent or discarded.",
                                   systemImage: "envelope.badge")
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                }
            } else {
                ProgressView("Loading draft").accessibilityLabel("Loading draft")
            }
        }
        .task {
            do { draft = try await model.pendingDraft(id: ref.id) } catch { self.error = error.friendly }
            loaded = true
        }
    }
}
