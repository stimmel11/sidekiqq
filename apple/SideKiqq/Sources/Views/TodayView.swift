import SideKiqqKit
import SwiftUI

/** Today: Top 5 actions plus the generated brief (daily / end of day / weekly). */
@MainActor
struct TodayView: View {
    @Environment(AppModel.self) private var model
    @State private var top5 = LoadState<Top5Response>()
    @State private var brief = LoadState<Brief>()
    @State private var kind: BriefKind = .daily
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let items = top5.value?.items, !items.isEmpty {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            TopItemRow(rank: index + 1, item: item)
                        }
                    } else if top5.loading {
                        ProgressView().accessibilityLabel("Loading top five")
                    } else if top5.error == nil {
                        Text("Nothing needs you right now.").font(SKFont.body)
                    }
                    if let e = top5.error { ErrorBanner(message: e) { Task { await loadTop5() } } }
                } header: {
                    Text("Top 5")
                } footer: {
                    if let at = top5.value?.updatedAt { Text("Updated \(DateText.relative(at))") }
                }

                Section {
                    Picker("Brief", selection: $kind) {
                        Text("Daily").tag(BriefKind.daily)
                        Text("End of day").tag(BriefKind.eod)
                        Text("Weekly").tag(BriefKind.weekly)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("Brief type")
                    if brief.loading {
                        ProgressView("Writing your brief…")
                    }
                    if let e = brief.error { ErrorBanner(message: e) { Task { await loadBrief() } } }
                }
                if let b = brief.value, !brief.loading {
                    ForEach(b.sections, id: \.title) { section in
                        Section(section.title.capitalized) {
                            if section.items.isEmpty {
                                Text("Nothing here.").font(SKFont.small).foregroundStyle(SideKiqqTheme.Palette.textMuted)
                            }
                            ForEach(Array(section.items.enumerated()), id: \.offset) { _, line in
                                Text(line).font(SKFont.body)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Today")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .refreshable { await reload() }
            .task { await reload() }
            .onChange(of: kind) { _, _ in Task { await loadBrief() } }
        }
    }

    private func reload() async {
        await loadTop5()
        await loadBrief()
    }

    private func loadTop5() async {
        guard let client = model.client else { return }
        top5.loading = true
        defer { top5.loading = false }
        do {
            top5.value = try await client.top5()
            top5.error = nil
        } catch {
            top5.error = error.friendly
        }
    }

    private func loadBrief() async {
        guard let client = model.client else { return }
        let requested = kind
        brief.loading = true
        defer { brief.loading = false }
        do {
            let b = try await client.brief(kind: requested)
            if requested == kind { brief.value = b }
            brief.error = nil
        } catch {
            brief.error = error.friendly
        }
    }
}

private struct TopItemRow: View {
    let rank: Int
    let item: TopItem

    var body: some View {
        HStack(alignment: .top, spacing: SideKiqqTheme.Space.s3) {
            ImportanceRule(importance: item.importance)
            VStack(alignment: .leading, spacing: SideKiqqTheme.Space.s1) {
                HStack {
                    Text("\(rank). \(item.title)").font(SKFont.h3)
                    Spacer(minLength: 0)
                    ImportanceBadge(importance: item.importance)
                }
                Text(item.why).font(SKFont.small).foregroundStyle(SideKiqqTheme.Palette.textMuted)
                if let due = DateText.short(item.dueAt) {
                    Text("Due \(due)").font(SKFont.data).foregroundStyle(SideKiqqTheme.Palette.textMuted)
                }
            }
        }
        .padding(.vertical, SideKiqqTheme.Space.s1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var s = "\(rank). \(item.title). \(item.importance.label) importance. \(item.why)"
        if let due = DateText.spoken(item.dueAt) { s += ". Due \(due)" }
        return s
    }
}
