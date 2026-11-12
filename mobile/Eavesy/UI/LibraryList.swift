import EavesyKit
import SwiftUI

/// What a row opens.
enum Detail: Hashable {
    case local(UUID)
    case session(id: String, title: String)
    case capture(id: String, title: String, isNote: Bool)
}

/// Everything kept, from every device, grouped by day. The date groups are the structure.
struct LibraryList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let groups = Dictionary(grouping: model.library) { Calendar.current.startOfDay(for: $0.date) }
        if groups.isEmpty {
            VStack(spacing: 14) {
                Mascot(size: 72)
                SpeechBubble(text: "It's quiet in here. Tap Record and talk, or jot something down.")
            }
            .padding(.top, 36)
        } else {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(groups.keys.sorted(by: >), id: \.self) { day in
                    Text(Self.heading(day))
                        .font(Ev.group)
                        .foregroundStyle(Ev.ink3)
                        .textCase(.uppercase)
                        .padding(.top, 10)
                        .padding(.leading, 4)
                    ForEach(groups[day] ?? []) { entry in
                        NavigationLink(value: detail(entry)) { EntryRow(entry: entry) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func detail(_ entry: LibraryEntry) -> Detail {
        switch entry {
        case .local(let item): .local(item.id)
        case .session(let session): .session(id: session.id, title: session.title ?? "Recording")
        case .capture(let capture): .capture(id: capture.id, title: capture.title, isNote: capture.kind == "note")
        }
    }

    private static func heading(_ day: Date) -> String {
        if Calendar.current.isDateInToday(day) { return "Today" }
        if Calendar.current.isDateInYesterday(day) { return "Yesterday" }
        return day.formatted(.dateTime.weekday(.wide).month().day())
    }
}

private struct EntryRow: View {
    let entry: LibraryEntry

    var body: some View {
        let look = Look(entry)
        HStack(spacing: 12) {
            Image(systemName: look.symbol)
                .font(.callout)
                .foregroundStyle(look.ink)
                .frame(width: 38, height: 38)
                .background(look.wash, in: RoundedRectangle(cornerRadius: Ev.rMedia, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(look.title).font(Ev.head).foregroundStyle(Ev.ink).lineLimit(1)
                HStack(spacing: 6) {
                    Text(entry.date, style: .time)
                    if let detail = look.detail { Text("·"); Text(detail).lineLimit(1) }
                }
                .font(.caption)
                .foregroundStyle(Ev.ink3)
            }
            Spacer(minLength: 4)
            if let status = look.status {
                Label(status.text, systemImage: status.symbol)
                    .labelStyle(.iconOnly)
                    .font(.footnote)
                    .foregroundStyle(status.tint)
                    .accessibilityLabel(status.text)
            }
        }
        .padding(10)
        .background(Ev.raised, in: RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous).stroke(Ev.line))
        .contentShape(Rectangle())
    }
}

/// How one entry reads in a row: its kind's ink, its title and where it stands.
private struct Look {
    struct Status { let text: String; let symbol: String; let tint: Color }

    var title: String
    var symbol: String
    var ink: Color
    var wash: Color
    var detail: String?
    var status: Status?

    init(_ entry: LibraryEntry) {
        switch entry {
        case .local(let item):
            title = item.title
            switch item.kind {
            case .recording:
                (symbol, ink, wash) = ("waveform", Ev.voice, Ev.voiceSoft)
                detail = Self.length(Double(item.durationMs) / 1_000)
            case .note:
                (symbol, ink, wash) = ("note.text", Ev.note, Ev.noteSoft)
                detail = item.text.flatMap(Self.secondLine)
            case .photo:
                (symbol, ink, wash) = ("camera.fill", Ev.screen, Ev.screenSoft)
            case .screenshot:
                (symbol, ink, wash) = ("iphone.gen3", Ev.screen, Ev.screenSoft)
            }
            switch item.state {
            case .recording: status = Status(text: "Recording", symbol: "circle.fill", tint: Ev.rec)
            case .pending: status = Status(text: "On this iPhone, waiting to sync", symbol: "arrow.up.circle", tint: Ev.ink3)
            case .processing: status = Status(text: "Writing it down", symbol: "ellipsis.circle", tint: Ev.ink3)
            case .failed: status = Status(text: item.lastError ?? "Couldn't sync", symbol: "exclamationmark.circle", tint: Ev.warnInk)
            case .synced: status = nil
            }
        case .session(let session):
            title = session.title ?? "Recording"
            let meeting = session.source == "bot" || (session.durationSec ?? 0) > 20 * 60
            (symbol, ink, wash) = meeting ? ("person.2.fill", Ev.meeting, Ev.meetingSoft) : ("waveform", Ev.voice, Ev.voiceSoft)
            detail = [session.durationSec.flatMap(Self.length), session.thisDevice == true ? nil : session.deviceName]
                .compactMap { $0 }.joined(separator: " · ")
            if detail?.isEmpty == true { detail = nil }
        case .capture(let capture):
            title = capture.title
            (symbol, ink, wash) = capture.kind == "note" ? ("note.text", Ev.note, Ev.noteSoft) : ("photo", Ev.screen, Ev.screenSoft)
            detail = capture.deviceName
        }
    }

    private static func length(_ seconds: Double) -> String? {
        guard seconds >= 1 else { return nil }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow, maximumUnitCount: 2))
    }

    private static func secondLine(_ text: String) -> String? {
        let lines = text.split(whereSeparator: \.isNewline)
        return lines.count > 1 ? String(lines[1]) : nil
    }
}
