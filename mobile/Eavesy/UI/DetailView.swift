import EavesyKit
import SwiftUI

/// One item, opened like a page from the file: its kind's tab, its name,
/// when and where it was kept, then what is inside.
struct DetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let detail: Detail

    var body: some View {
        let entry = model.library.first { $0.id == detail.entryId }
        ScrollView {
            if let entry {
                let look = EntryLook(entry, signedIn: model.signedIn, store: model.store)
                VStack(alignment: .leading, spacing: 20) {
                    header(entry, look)
                    content(entry, look)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Ev.gutter)
                .padding(.top, 8)
                .padding(.bottom, 40)
            }
        }
        .background(Ev.paper)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let entry, case .local(let item) = entry, item.kind == .note, let text = item.text {
                ToolbarItem(placement: .topBarTrailing) { ShareLink(item: text) }
            }
        }
        // Discarded, or gone from the account: there is nothing left to show.
        .onChange(of: entry == nil) { _, gone in if gone { dismiss() } }
    }

    private func header(_ entry: LibraryEntry, _ look: EntryLook) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                KindTab(kind: look.kind, symbol: look.symbol, size: 28)
                Text(look.kindLabel).font(Ev.ui).foregroundStyle(look.kind.ink)
            }
            Text(look.title)
                .font(Ev.title(26))
                .foregroundStyle(Ev.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(([Self.when(entry.date)] + look.bits).joined(separator: "  ·  "))
                .font(Ev.small)
                .foregroundStyle(Ev.ink3)
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private func content(_ entry: LibraryEntry, _ look: EntryLook) -> some View {
        switch entry {
        case .local(let item):
            standing(item, look)
            switch item.kind {
            case .note:
                NoteText(text: Self.body(of: item.text ?? "", titled: item.title))
            case .photo, .screenshot:
                if let image = look.image { Picture(source: image) }
            case .recording:
                if let meetingId = item.remoteId, item.finalized { RecordingBody(meetingId: meetingId) }
            }
        case .session(let session):
            RecordingBody(meetingId: session.id)
        case .capture(let capture):
            if capture.kind == "note" {
                RemoteNote(id: capture.id, title: capture.title)
            } else {
                Picture(source: .remote(capture.id))
                if let words = capture.transcript, !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    SectionLabel("Words in this picture")
                    NoteText(text: words)
                }
            }
        }
    }

    /// Where something on this phone stands, and the one thing to do about it.
    @ViewBuilder
    private func standing(_ item: OutboxItem, _ look: EntryLook) -> some View {
        if let error = item.lastError, item.state == .failed || item.state == .pending {
            VStack(alignment: .leading, spacing: 12) {
                Text(error).font(.subheadline).foregroundStyle(Ev.warnInk).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button("Try again") { model.retry(item) }
                        .font(Ev.ui)
                        .foregroundStyle(Ev.onCoat)
                        .padding(.horizontal, 16)
                        .frame(height: 40)
                        .background(Ev.coat, in: Capsule())
                    Button("Discard") {
                        model.discard(item)
                        dismiss()
                    }
                    .font(Ev.ui)
                    .foregroundStyle(Ev.ink2)
                    .padding(.horizontal, 10)
                    .frame(height: 40)
                }
                .buttonStyle(.plain)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Ev.warnSoft, in: RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous))
        } else if let status = look.status {
            let waitingForWords = item.kind == .recording && !item.finalized && item.state != .recording
            VStack(alignment: .leading, spacing: 4) {
                StatusLine(status: status)
                if waitingForWords {
                    Text(model.signedIn ? "The transcript shows up here once this has synced." : "Sign in to get a transcript. The audio stays on this iPhone until then.")
                        .font(.subheadline)
                        .foregroundStyle(Ev.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private static func when(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(date) { return "Today, \(time)" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday, \(time)" }
        return date.formatted(.dateTime.weekday(.abbreviated).month().day().hour().minute())
    }

    /// A note's first line is already the page's title; don't say it twice.
    fileprivate static func body(of text: String, titled title: String) -> String {
        let lines = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false)
        // A long first line was cut to make the title, so the text keeps all of it.
        guard let first = lines.first, title.count < 80, OutboxStore.noteTitle(String(first)) == title else { return text }
        return lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A day-group style label for the parts of a page.
private struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(.subheadline, design: .rounded).weight(.bold))
            .foregroundStyle(Ev.ink2)
            .padding(.top, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Long text, set to be read.
private struct NoteText: View {
    let text: String

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(Ev.reading)
                .lineSpacing(5)
                .foregroundStyle(Ev.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A picture at full width, framed like a print.
private struct Picture: View {
    @Environment(AppModel.self) private var model
    let source: ImageSource
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image = image ?? Pictures.cached(source) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous).stroke(Ev.line))
                    .evLift()
            } else if failed {
                Unavailable()
            } else {
                RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous)
                    .fill(Ev.well)
                    .frame(height: 260)
                    .overlay(ProgressView())
            }
        }
        .task(id: source) {
            do {
                image = try await Pictures.load(source, api: model.api)
                failed = image == nil
            } catch {
                model.loadFailed(error)
                failed = true
            }
        }
    }
}

private struct Unavailable: View {
    var body: some View {
        Text("Couldn't load this one. Check your connection, then open it again.")
            .font(.subheadline)
            .foregroundStyle(Ev.ink2)
    }
}

/// Summary and transcript from the cloud, refreshed while it is still being written.
private struct RecordingBody: View {
    @Environment(AppModel.self) private var model
    let meetingId: String
    @State private var result: SessionResult?
    @State private var failed = false

    var body: some View {
        Group {
            if let result {
                if let summary = result.summary { SummaryFolder(summary: summary) }
                if result.transcript.isEmpty {
                    HStack(spacing: 10) {
                        Mascot(pose: result.isFinal ? .confused : .thinking, size: 28)
                        Text(result.isFinal ? "Didn't hear any words in this one. The audio is still saved." : "Writing it down…")
                            .font(.subheadline)
                            .foregroundStyle(Ev.ink2)
                    }
                    .padding(.top, 4)
                } else {
                    SectionLabel("Transcript")
                    Transcript(lines: result.transcript)
                }
            } else if failed {
                Unavailable()
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
            }
        }
        .task(id: meetingId) {
            while !Task.isCancelled {
                do {
                    let latest = try await model.api.result(meetingId: meetingId)
                    result = latest
                    if latest.isFinal { return }
                } catch {
                    model.loadFailed(error)
                    if result == nil { failed = true }
                    return
                }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }
}

/// The summary, filed in a manila folder: the overview first, then what was
/// decided and what is left to do.
private struct SummaryFolder: View {
    let summary: SessionResult.Summary

    var body: some View {
        let decisions = Self.items(summary.decisionsJson)
        let actions = Self.items(summary.actionItemsJson)
        let overview = summary.tldr?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !overview.isEmpty || !decisions.isEmpty || !actions.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text("Summary")
                    .font(Ev.small)
                    .foregroundStyle(Ev.manilaInk)
                    .padding(.horizontal, 14)
                    .frame(height: 26)
                    .background(Ev.manilaSoft, in: UnevenRoundedRectangle(topLeadingRadius: 10, topTrailingRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 14) {
                    if !overview.isEmpty {
                        Text(overview).font(Ev.reading).lineSpacing(4).foregroundStyle(Ev.ink).textSelection(.enabled)
                    }
                    list("Decided", decisions, symbol: "checkmark")
                    list("To do", actions, symbol: "circle")
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    Ev.manilaSoft,
                    in: UnevenRoundedRectangle(bottomLeadingRadius: Ev.rPanel, bottomTrailingRadius: Ev.rPanel, topTrailingRadius: Ev.rPanel, style: .continuous)
                )
            }
        }
    }

    @ViewBuilder
    private func list(_ title: String, _ items: [String], symbol: String) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(Ev.small).foregroundStyle(Ev.manilaInk)
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        Image(systemName: symbol).font(.system(size: 11, weight: .bold)).foregroundStyle(Ev.manilaInk)
                        Text(item).font(.subheadline).foregroundStyle(Ev.ink).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    /// The server stores these as JSON lists of `{ text, owner? }`.
    private static func items(_ json: String?) -> [String] {
        guard let data = json?.data(using: .utf8), let list = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        return list.compactMap { entry in
            if let text = entry as? String { return text }
            guard let fields = entry as? [String: Any], let text = fields["text"] as? String ?? fields["title"] as? String else { return nil }
            if let owner = fields["owner"] as? String, !owner.isEmpty { return "\(text) (\(owner))" }
            return text
        }
        .filter { !$0.isEmpty }
    }
}

/// What was said: a speaker's name once per turn, the time beside it, the words set to be read.
private struct Transcript: View {
    let lines: [SessionResult.Line]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                let newTurn = index == 0 || lines[index - 1].speaker != line.speaker
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        if newTurn, let speaker = line.speaker { Text(speaker).foregroundStyle(Ev.ink2).fontWeight(.bold) }
                        Text(Self.clock(line.startMs)).foregroundStyle(Ev.ink3).monospacedDigit()
                    }
                    .font(Ev.small)
                    Text(line.text)
                        .font(Ev.reading)
                        .lineSpacing(4)
                        .foregroundStyle(Ev.ink)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private static func clock(_ ms: Int) -> String {
        String(format: "%d:%02d", ms / 60_000, (ms / 1_000) % 60)
    }
}

/// A note another device saved, fetched when opened.
private struct RemoteNote: View {
    @Environment(AppModel.self) private var model
    let id: String
    let title: String
    @State private var text: String?
    @State private var failed = false

    var body: some View {
        Group {
            if let text {
                NoteText(text: DetailView.body(of: text, titled: title))
            } else if failed {
                Unavailable()
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
            }
        }
        .task(id: id) {
            do {
                text = String(decoding: try await model.api.captureContent(id: id), as: UTF8.self)
            } catch {
                model.loadFailed(error)
                failed = true
            }
        }
    }
}
