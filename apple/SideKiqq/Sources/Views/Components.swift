import SideKiqqKit
import SwiftUI
import UIKit

/** Brand fonts when the TTFs are bundled, otherwise system fonts with the same weights. Both scale with Dynamic Type. */
enum SKFont {
    private static let brandFontsBundled = UIFont(name: "SpaceGrotesk-SemiBold", size: 12) != nil

    static var h1: Font { brandFontsBundled ? SideKiqqTheme.Typography.h1 : SideKiqqTheme.Typography.System.h1 }
    static var h2: Font { brandFontsBundled ? SideKiqqTheme.Typography.h2 : SideKiqqTheme.Typography.System.h2 }
    static var h3: Font { brandFontsBundled ? SideKiqqTheme.Typography.h3 : SideKiqqTheme.Typography.System.h3 }
    static var body: Font { brandFontsBundled ? SideKiqqTheme.Typography.body : SideKiqqTheme.Typography.System.body }
    static var small: Font { brandFontsBundled ? SideKiqqTheme.Typography.small : SideKiqqTheme.Typography.System.small }
    static var data: Font { brandFontsBundled ? SideKiqqTheme.Typography.data : SideKiqqTheme.Typography.System.data }
}

/** Importance is always written out, never color alone (design/README.md). */
struct ImportanceBadge: View {
    let importance: Importance

    var body: some View {
        let style = SideKiqqTheme.importance(importance.rawValue)
        Text(style.label)
            .font(SKFont.data)
            .foregroundStyle(style.fg)
            .padding(.horizontal, SideKiqqTheme.Space.s2)
            .padding(.vertical, 2)
            .background(style.bg, in: RoundedRectangle(cornerRadius: SideKiqqTheme.Radius.sm))
            .accessibilityLabel("Importance: \(style.label)")
    }
}

/** Leading color rule for a row, matching the dashboard's ListRow. Decorative. */
struct ImportanceRule: View {
    let importance: Importance
    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(SideKiqqTheme.importance(importance.rawValue).rule)
            .frame(width: 4)
            .accessibilityHidden(true)
    }
}

/** The "inferred" label required for guessed dates/facts. */
struct InferredTag: View {
    var body: some View {
        Text("inferred")
            .font(SKFont.data)
            .italic()
            .foregroundStyle(SideKiqqTheme.Palette.textMuted)
            .padding(.horizontal, SideKiqqTheme.Space.s1)
            .overlay(RoundedRectangle(cornerRadius: SideKiqqTheme.Radius.sm)
                .stroke(SideKiqqTheme.Palette.lineStrong, lineWidth: 1))
            .accessibilityLabel("inferred")
    }
}

struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: SideKiqqTheme.Space.s2) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(SideKiqqTheme.Palette.dangerInk)
                .accessibilityHidden(true)
            Text(message)
                .font(SKFont.small)
                .foregroundStyle(SideKiqqTheme.Palette.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry)
                    .font(SKFont.small.weight(.semibold))
                    .frame(minHeight: SideKiqqTheme.Layout.touchTarget)
            }
        }
        .padding(SideKiqqTheme.Space.s3)
        .background(SideKiqqTheme.importance("CRITICAL").bg, in: RoundedRectangle(cornerRadius: SideKiqqTheme.Radius.md))
        .accessibilityElement(children: .combine)
    }
}

/** Says what an empty list means and what to do next. */
struct EmptyStateView: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        }
    }
}

enum DateText {
    /** "Fri, Oct 24" (or with time when it isn't midnight UTC). Falls back to the raw string. */
    static func short(_ iso: String?) -> String? {
        guard let iso else { return nil }
        guard let d = SideKiqqDate.parse(iso) else { return iso }
        return d.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    static func spoken(_ iso: String?) -> String? {
        guard let iso, let d = SideKiqqDate.parse(iso) else { return iso }
        return d.formatted(date: .complete, time: .omitted)
    }

    static func relative(_ iso: String) -> String {
        guard let d = SideKiqqDate.parse(iso) else { return iso }
        return d.formatted(.relative(presentation: .named))
    }
}

/** Shared loading/error state for list screens. */
struct LoadState<T> {
    var value: T?
    var loading = false
    var error: String?
}

extension Error {
    /** Owner-friendly message for any brain/client error. */
    var friendly: String {
        if let e = self as? SideKiqqAPIError {
            switch e {
            case let .http(status, _, message, _):
                if status == 401 { return "This iPhone's pairing was revoked. Pair again in Settings." }
                return message ?? "SideKiqq returned an error (\(status))."
            case .transport:
                return "Can't reach SideKiqq. Check your connection."
            case .decoding:
                return "SideKiqq sent something this app doesn't understand. Update the app."
            case let .invalidInput(m):
                return m
            }
        }
        return localizedDescription
    }
}
