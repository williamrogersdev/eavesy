import EavesyKit
import ImageIO
import SwiftUI

/// What a row opens: the entry, by its id in the library.
struct Detail: Hashable {
    let entryId: String
}

/// Everything kept, from every device, grouped by day. The date groups are
/// the structure: there is no title, and rows sit on the paper like lines in
/// a case file rather than in boxes of their own.
struct LibraryList: View {
    @Environment(AppModel.self) private var model
    let filter: EvKind?
    let query: String

    var body: some View {
        let all = model.library
        let looks = all.map { ($0, EntryLook($0, signedIn: model.signedIn, store: model.store)) }
        let shown = looks.filter { _, look in
            (filter == nil || look.kind == filter) && (query.isEmpty || look.matches(query))
        }
        if all.isEmpty {
            VStack(spacing: 14) {
                Mascot(size: 72)
                SpeechBubble(text: "It's quiet in here. Tap Record and talk, or jot something down.")
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 72)
        } else if shown.isEmpty {
            Text(query.isEmpty ? "Nothing here yet." : "No captures match \u{201C}\(query)\u{201D}.")
                .font(Ev.ui)
                .foregroundStyle(Ev.ink3)
                .frame(maxWidth: .infinity)
                .padding(.top, 56)
        } else {
            let groups = Dictionary(grouping: shown) { Calendar.current.startOfDay(for: $0.0.date) }
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(groups.keys.sorted(by: >), id: \.self) { day in
                    Text(Self.heading(day))
                        .font(.system(.subheadline, design: .rounded).weight(.bold))
                        .foregroundStyle(Ev.ink2)
                        .padding(.top, 22)
                        .padding(.bottom, 2)
                        .accessibilityAddTraits(.isHeader)
                    let rows = groups[day] ?? []
                    ForEach(Array(rows.enumerated()), id: \.element.0.id) { index, row in
                        NavigationLink(value: Detail(entryId: row.0.id)) {
                            EntryRow(date: row.0.date, look: row.1, last: index == rows.count - 1)
                        }
                        .buttonStyle(RowButtonStyle())
                    }
                }
            }
        }
    }

    private static func heading(_ day: Date) -> String {
        if Calendar.current.isDateInToday(day) { return "Today" }
        if Calendar.current.isDateInYesterday(day) { return "Yesterday" }
        return day.formatted(.dateTime.weekday(.wide).month().day())
    }
}

/// A row dims a little under the finger; nothing else moves.
private struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.55 : 1)
    }
}

private struct EntryRow: View {
    let date: Date
    let look: EntryLook
    let last: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            KindTab(kind: look.kind, symbol: look.symbol)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    // A voice note not yet named is called "Voice note" once, by its title.
                    let named = look.title != look.kindLabel
                    if named { Text(look.kindLabel).foregroundStyle(look.kind.ink) }
                    ForEach(Array(look.bits.enumerated()), id: \.offset) { index, bit in
                        if named || index > 0 { Text("·").foregroundStyle(Ev.ink3) }
                        Text(bit).foregroundStyle(Ev.ink3).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Text(date, style: .time).foregroundStyle(Ev.ink3)
                }
                .font(Ev.small)
                .monospacedDigit()

                Text(look.title)
                    .font(Ev.head)
                    .foregroundStyle(Ev.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                if let preview = look.preview {
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(Ev.ink2)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                if let image = look.image {
                    Thumbnail(source: image)
                }
                if let status = look.status {
                    StatusLine(status: status).padding(.top, 2)
                }
            }
        }
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Ev.line).frame(height: 1).padding(.leading, 46) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Where a capture stands, in words: a glyph alone doesn't say enough.
struct StatusLine: View {
    let status: EntryLook.Status

    var body: some View {
        HStack(spacing: 5) {
            if status.live {
                Circle().fill(Ev.rec).frame(width: 7, height: 7)
            } else {
                Image(systemName: status.symbol).font(.system(size: 11, weight: .semibold))
            }
            Text(status.text).lineLimit(2).multilineTextAlignment(.leading)
        }
        .font(Ev.small)
        .foregroundStyle(status.warn ? Ev.warnInk : Ev.ink3)
    }
}

/// How one entry reads, in a row and on its own page: its kind, its title,
/// a line or picture of what is inside, and where it stands.
struct EntryLook {
    struct Status {
        let text: String
        let symbol: String
        var warn = false
        /// The mic is live for this one right now.
        var live = false
    }

    var kind: EvKind
    var kindLabel: String
    var symbol: String
    var title: String
    /// Small facts beside the kind: how long, which device.
    var bits: [String] = []
    var preview: String?
    var image: ImageSource?
    var status: Status?
    /// A note's whole text, when this phone has it.
    var text: String?

    init(_ entry: LibraryEntry, signedIn: Bool, store: OutboxStore) {
        switch entry {
        case .local(let item):
            title = item.title
            switch item.kind {
            case .recording:
                (kind, kindLabel, symbol) = (.voice, "Voice note", "waveform")
                if let length = Self.length(Double(item.durationMs) / 1_000) { bits.append(length) }
            case .note:
                (kind, kindLabel, symbol) = (.note, "Note", "note.text")
                text = item.text
                preview = item.text.flatMap(Self.afterFirstLine)
            case .photo:
                (kind, kindLabel, symbol) = (.screen, "Picture", "camera")
                image = store.fileURL(item).map(ImageSource.file)
            case .screenshot:
                (kind, kindLabel, symbol) = (.screen, "Screenshot", "camera.viewfinder")
                image = store.fileURL(item).map(ImageSource.file)
            }
            switch item.state {
            case .recording:
                status = Status(text: "Listening", symbol: "circle.fill", live: true)
            case .pending:
                status = signedIn
                    ? Status(text: item.lastError ?? "Waiting to sync", symbol: "arrow.up", warn: item.lastError != nil)
                    : Status(text: "On this iPhone", symbol: "iphone")
            case .processing:
                status = Status(text: "Writing it down…", symbol: "pencil.line")
            case .failed:
                status = Status(text: item.lastError ?? "Couldn't sync", symbol: "exclamationmark.triangle", warn: true)
            case .synced:
                status = nil
            }
        case .session(let session):
            title = session.title ?? "Recording"
            let meeting = session.source == "bot" || (session.durationSec ?? 0) > 20 * 60
            (kind, kindLabel, symbol) = meeting ? (.meeting, "Meeting", "person.2") : (.voice, "Voice note", "waveform")
            if let length = session.durationSec.flatMap(Self.length) { bits.append(length) }
            if session.thisDevice != true, let device = session.deviceName { bits.append(device) }
        case .capture(let capture):
            title = capture.title
            if capture.kind == "note" {
                (kind, kindLabel, symbol) = (.note, "Note", "note.text")
            } else {
                (kind, kindLabel, symbol) = (.screen, capture.kind == "screenshot" ? "Screenshot" : "Picture", "photo")
                image = .remote(capture.id)
                preview = capture.transcript.flatMap(Self.oneLine)
            }
            if let device = capture.deviceName { bits.append(device) }
        }
    }

    func matches(_ query: String) -> Bool {
        [title, kindLabel, preview ?? "", text ?? ""].contains { $0.localizedCaseInsensitiveContains(query) }
    }

    private static func length(_ seconds: Double) -> String? {
        guard seconds >= 1 else { return nil }
        return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow, maximumUnitCount: 2))
    }

    /// A note's title is its first line; the preview is what follows.
    private static func afterFirstLine(_ text: String) -> String? {
        let lines = text.split(whereSeparator: \.isNewline).dropFirst()
        let rest = lines.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? nil : rest
    }

    private static func oneLine(_ text: String) -> String? {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.isEmpty ? nil : flat
    }
}

/// Where a picture comes from: a file on this phone, or a capture in the account.
enum ImageSource: Hashable {
    case file(URL)
    case remote(String)

    var key: String {
        switch self {
        case .file(let url): url.path
        case .remote(let id): "remote-\(id)"
        }
    }
}

/// Row pictures, decoded small and kept while the app is open.
enum Pictures {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 80
        return cache
    }()

    static func cached(_ source: ImageSource) -> UIImage? {
        cache.object(forKey: source.key as NSString)
    }

    /// Throws only what the server said, so a rejected token can sign the phone out.
    static func load(_ source: ImageSource, api: EavesyAPI) async throws -> UIImage? {
        if let hit = cached(source) { return hit }
        let image: UIImage?
        switch source {
        case .file(let url):
            image = await Task.detached { shrink(CGImageSourceCreateWithURL(url as CFURL, nil)) }.value
        case .remote(let id):
            let data = try await api.captureContent(id: id)
            image = await Task.detached { shrink(CGImageSourceCreateWithData(data as CFData, nil)) }.value
        }
        if let image { cache.setObject(image, forKey: source.key as NSString) }
        return image
    }

    private static func shrink(_ source: CGImageSource?) -> UIImage? {
        guard let source else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 1_100,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map(UIImage.init(cgImage:))
    }
}

/// A picture in a row: the top of it, in a frame, like a print clipped to the page.
struct Thumbnail: View {
    @Environment(AppModel.self) private var model
    let source: ImageSource
    var height: CGFloat = 148
    @State private var image: UIImage?
    @State private var missing = false

    var body: some View {
        // A picture that can't be had leaves no empty frame behind.
        if !missing {
            Ev.well
                .frame(height: height)
                .overlay(alignment: .top) {
                    if let image = image ?? Pictures.cached(source) {
                        Image(uiImage: image).resizable().scaledToFill()
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Ev.rMedia, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Ev.rMedia, style: .continuous).stroke(Ev.line))
                .padding(.top, 4)
                .task(id: source) {
                    do {
                        image = try await Pictures.load(source, api: model.api)
                    } catch {
                        model.loadFailed(error)
                    }
                    missing = image == nil
                }
        }
    }
}
