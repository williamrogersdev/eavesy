import EavesyKit
import SwiftUI

/// One item, opened: a note's text, an image, or a recording's summary and transcript.
struct DetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let detail: Detail

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch detail {
                case .local(let id):
                    if let item = model.items.first(where: { $0.id == id }) { local(item) }
                case .session(let id, _):
                    RecordingBody(meetingId: id)
                case .capture(let id, _, let isNote):
                    RemoteCaptureBody(id: id, isNote: isNote)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(Ev.paper)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var title: String {
        switch detail {
        case .local(let id): model.items.first { $0.id == id }?.title ?? ""
        case .session(_, let title), .capture(_, let title, _): title
        }
    }

    @ViewBuilder
    private func local(_ item: OutboxItem) -> some View {
        if item.state == .failed || item.state == .pending, let error = item.lastError {
            VStack(alignment: .leading, spacing: 10) {
                Text(error).font(.footnote).foregroundStyle(Ev.warnInk)
                HStack {
                    Button("Try again") { model.retry(item) }.buttonStyle(WellButtonStyle())
                    Button("Discard", role: .destructive) {
                        model.discard(item)
                        dismiss()
                    }
                    .font(Ev.ui)
                    .padding(.leading, 8)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Ev.warnSoft, in: RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous))
        }
        switch item.kind {
        case .note:
            Text(item.text ?? "").font(.body).foregroundStyle(Ev.ink).textSelection(.enabled)
        case .photo, .screenshot:
            if let url = model.store.fileURL(item), let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: Ev.rMedia))
            }
        case .recording:
            if let meetingId = item.remoteId, item.finalized {
                RecordingBody(meetingId: meetingId)
            } else {
                Label(
                    model.signedIn ? "Saved on this iPhone. It will be written down once it has synced." : "Saved on this iPhone. Sign in to get a transcript.",
                    systemImage: "iphone"
                )
                .font(.footnote)
                .foregroundStyle(Ev.ink2)
            }
        }
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
                if let tldr = result.summary?.tldr, !tldr.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Summary").font(Ev.group).foregroundStyle(Ev.manilaInk).textCase(.uppercase)
                        Text(tldr).font(.body).foregroundStyle(Ev.ink)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Ev.manilaSoft, in: RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous))
                }
                if result.transcript.isEmpty {
                    HStack(spacing: 10) {
                        if !result.isFinal { ProgressView() }
                        Text(result.isFinal ? "Didn't hear any words in this one." : "Writing it down…")
                            .font(.footnote)
                            .foregroundStyle(Ev.ink2)
                    }
                } else {
                    ForEach(Array(result.transcript.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(Self.clock(line.startMs)).font(.caption.monospacedDigit()).foregroundStyle(Ev.ink3)
                            Text(line.speaker.map { "\($0): \(line.text)" } ?? line.text)
                                .font(.body)
                                .foregroundStyle(Ev.ink)
                                .textSelection(.enabled)
                        }
                    }
                }
            } else if failed {
                Text("Couldn't load this one. Pull down on the list to try again.").font(.footnote).foregroundStyle(Ev.ink2)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task(id: meetingId) {
            while !Task.isCancelled {
                do {
                    let latest = try await model.api.result(meetingId: meetingId)
                    result = latest
                    if latest.isFinal { return }
                } catch {
                    if result == nil { failed = true }
                    return
                }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    private static func clock(_ ms: Int) -> String {
        String(format: "%d:%02d", ms / 60_000, (ms / 1_000) % 60)
    }
}

/// A note or image another device saved, fetched when opened.
private struct RemoteCaptureBody: View {
    @Environment(AppModel.self) private var model
    let id: String
    let isNote: Bool
    @State private var data: Data?
    @State private var failed = false

    var body: some View {
        Group {
            if let data {
                if isNote {
                    Text(String(decoding: data, as: UTF8.self)).font(.body).foregroundStyle(Ev.ink).textSelection(.enabled)
                } else if let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: Ev.rMedia))
                }
            } else if failed {
                Text("Couldn't load this one. Check your connection.").font(.footnote).foregroundStyle(Ev.ink2)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task(id: id) {
            do {
                data = try await model.api.captureContent(id: id)
            } catch {
                failed = true
            }
        }
    }
}
