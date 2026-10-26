import SideKiqqKit
import SwiftUI

// MARK: - Follow-ups

@MainActor
struct FollowUpsView: View {
    @Environment(AppModel.self) private var model
    @State private var state = LoadState<[FollowUp]>()
    @State private var reviewing: DraftRef?

    var body: some View {
        NavigationStack {
            List {
                if let e = state.error { ErrorBanner(message: e) { Task { await load() } } }
                ForEach(state.value ?? []) { f in
                    FollowUpRow(followUp: f) { reviewing = DraftRef(id: $0) }
                }
            }
            .overlay {
                if state.value?.isEmpty == true {
                    EmptyStateView(title: "No follow-ups", message: "Nobody is waiting on you right now.",
                                   systemImage: "checkmark.circle")
                } else if state.value == nil && state.loading {
                    ProgressView()
                }
            }
            .navigationTitle("Follow-ups")
            .refreshable { await load() }
            .task { await load() }
            .sheet(item: $reviewing) { ref in
                DraftLoaderSheet(ref: ref) { _ in Task { await load() } }
            }
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        state.loading = true
        defer { state.loading = false }
        do {
            state.value = try await client.followUps()
            state.error = nil
        } catch {
            state.error = error.friendly
        }
    }
}

private struct FollowUpRow: View {
    let followUp: FollowUp
    let review: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: SideKiqqTheme.Space.s3) {
            ImportanceRule(importance: followUp.importance)
            VStack(alignment: .leading, spacing: SideKiqqTheme.Space.s1) {
                HStack {
                    Text(followUp.person).font(SKFont.h3)
                    Spacer(minLength: 0)
                    ImportanceBadge(importance: followUp.importance)
                }
                .accessibilityElement(children: .combine)
                if let client = followUp.client {
                    Text(client).font(SKFont.data).foregroundStyle(SideKiqqTheme.Palette.textMuted)
                }
                Text(followUp.reason).font(SKFont.body)
                if let days = followUp.daysQuiet {
                    Text("Quiet for \(days) day\(days == 1 ? "" : "s")")
                        .font(SKFont.data).foregroundStyle(SideKiqqTheme.Palette.textMuted)
                }
                if let draftId = followUp.draftId {
                    Button("Review and send draft") { review(draftId) }
                        .buttonStyle(.borderedProminent)
                        .frame(minHeight: SideKiqqTheme.Layout.touchTarget)
                        .accessibilityHint("Shows the draft. Nothing is sent until you tap Send.")
                } else {
                    Text("Follow-up recommended. No draft yet.")
                        .font(SKFont.small).foregroundStyle(SideKiqqTheme.Palette.textMuted)
                }
            }
        }
        .padding(.vertical, SideKiqqTheme.Space.s1)
    }
}

// MARK: - Commitments

@MainActor
struct CommitmentsView: View {
    @Environment(AppModel.self) private var model
    @State private var filter: CommitmentFilter = .open
    @State private var state = LoadState<[Commitment]>()
    @State private var confirmDone: Commitment?

    var body: some View {
        NavigationStack {
            List {
                Picker("Show", selection: $filter) {
                    Text("Open").tag(CommitmentFilter.open)
                    Text("Overdue").tag(CommitmentFilter.overdue)
                    Text("All").tag(CommitmentFilter.all)
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Which commitments to show")
                if let e = state.error { ErrorBanner(message: e) { Task { await load() } } }
                ForEach(state.value ?? []) { c in
                    CommitmentRow(commitment: c) { confirmDone = c }
                }
            }
            .overlay {
                if state.value?.isEmpty == true {
                    EmptyStateView(title: "Nothing here", message: "No \(filter == .all ? "" : filter.rawValue + " ")commitments.",
                                   systemImage: "checklist")
                }
            }
            .navigationTitle("Commitments")
            .refreshable { await load() }
            .task(id: filter) { await load() }
            .confirmationDialog("Mark this commitment done?", isPresented: Binding(
                get: { confirmDone != nil }, set: { if !$0 { confirmDone = nil } }
            ), titleVisibility: .visible, presenting: confirmDone) { c in
                Button("Mark done") { Task { await complete(c) } }
                Button("Cancel", role: .cancel) { confirmDone = nil }
            } message: { c in
                Text("\(c.who): \(c.what)")
            }
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        let requested = filter
        state.loading = true
        defer { state.loading = false }
        do {
            let items = try await client.commitments(status: requested)
            if requested == filter { state.value = items }
            state.error = nil
        } catch {
            state.error = error.friendly
        }
    }

    private func complete(_ c: Commitment) async {
        confirmDone = nil
        do {
            try await model.client?.completeCommitment(id: c.id)
            await load()
        } catch {
            state.error = error.friendly
        }
    }
}

private struct CommitmentRow: View {
    let commitment: Commitment
    let markDone: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: SideKiqqTheme.Space.s1) {
            Text(commitment.what).font(SKFont.h3)
            Text(commitment.who + (commitment.client.map { " · \($0)" } ?? ""))
                .font(SKFont.small).foregroundStyle(SideKiqqTheme.Palette.textMuted)
            HStack(spacing: SideKiqqTheme.Space.s2) {
                if let due = DateText.short(commitment.dueAt) {
                    Text("Due \(due)").font(SKFont.data)
                        .foregroundStyle(commitment.status == .overdue ? SideKiqqTheme.Palette.dangerInk : SideKiqqTheme.Palette.textMuted)
                }
                if commitment.isInferred { InferredTag() }
                if commitment.status == .overdue {
                    Text("Overdue").font(SKFont.data).foregroundStyle(SideKiqqTheme.Palette.dangerInk)
                }
                if commitment.status == .done {
                    Text("Done").font(SKFont.data).foregroundStyle(SideKiqqTheme.Palette.successInk)
                }
            }
            if commitment.status != .done {
                Button("Done", action: markDone)
                    .buttonStyle(.bordered)
                    .frame(minHeight: SideKiqqTheme.Layout.touchTarget)
                    .accessibilityLabel("Mark done: \(commitment.what)")
            }
        }
        .padding(.vertical, SideKiqqTheme.Space.s1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(spokenSummary)
    }

    /** Inferred dates are spoken as "inferred" (ARCHITECTURE.md). */
    private var spokenSummary: String {
        var s = "\(commitment.who) committed to \(commitment.what)"
        if let client = commitment.client { s += " for \(client)" }
        if let due = DateText.spoken(commitment.dueAt) {
            s += ". Due \(due)" + (commitment.dueInferred ? ", inferred" : "")
        }
        if commitment.confidence == .inferred && !commitment.dueInferred { s += ". Inferred" }
        if commitment.status == .overdue { s += ". Overdue" }
        return s
    }
}

// MARK: - Drafts

@MainActor
struct DraftsView: View {
    @Environment(AppModel.self) private var model
    @State private var state = LoadState<[Draft]>()
    @State private var reviewing: Draft?
    @State private var discarding: Draft?

    var body: some View {
        NavigationStack {
            List {
                if let e = state.error { ErrorBanner(message: e) { Task { await load() } } }
                ForEach(state.value ?? []) { d in
                    Button { reviewing = d } label: { DraftRow(draft: d) }
                        .accessibilityHint("Opens the draft to review and send.")
                        .swipeActions {
                            Button("Discard", role: .destructive) { discarding = d }
                        }
                }
            }
            .overlay {
                if state.value?.isEmpty == true {
                    EmptyStateView(title: "No drafts waiting", message: "Drafts SideKiqq writes for you appear here for approval.",
                                   systemImage: "envelope.open")
                }
            }
            .navigationTitle("Drafts")
            .refreshable { await load() }
            .task { await load() }
            .sheet(item: $reviewing) { d in
                DraftConfirmSheet(draft: d) { _ in Task { await load() } }
            }
            .confirmationDialog("Discard this draft?", isPresented: Binding(
                get: { discarding != nil }, set: { if !$0 { discarding = nil } }
            ), titleVisibility: .visible, presenting: discarding) { d in
                Button("Discard", role: .destructive) { Task { await discard(d) } }
                Button("Cancel", role: .cancel) { discarding = nil }
            } message: { _ in
                Text("It won't be sent. The copy in Gmail is left alone.")
            }
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        state.loading = true
        defer { state.loading = false }
        do {
            state.value = try await client.pendingDrafts()
            state.error = nil
        } catch {
            state.error = error.friendly
        }
    }

    private func discard(_ d: Draft) async {
        discarding = nil
        do {
            try await model.client?.discardDraft(id: d.id)
            await load()
        } catch {
            state.error = error.friendly
        }
    }
}

private struct DraftRow: View {
    let draft: Draft

    var body: some View {
        VStack(alignment: .leading, spacing: SideKiqqTheme.Space.s1) {
            Text(draft.subject.isEmpty ? "(no subject)" : draft.subject).font(SKFont.h3)
                .foregroundStyle(SideKiqqTheme.Palette.text)
            Text("To \(draft.to.joined(separator: ", "))").font(SKFont.small)
                .foregroundStyle(SideKiqqTheme.Palette.textMuted)
            Text(DraftConfirmation.bodySummary(draft.body)).font(SKFont.body).lineLimit(2)
                .foregroundStyle(SideKiqqTheme.Palette.text)
        }
        .padding(.vertical, SideKiqqTheme.Space.s1)
        .accessibilityElement(children: .combine)
    }
}
