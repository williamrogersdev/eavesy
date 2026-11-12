import EavesyKit
import PhotosUI
import SwiftUI

/// The whole app on one screen. Everything you've kept is the page; the
/// capture dock floats at the bottom, under your thumb. Starting a capture
/// never moves you somewhere else.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showingSettings = false
    @State private var screenshot: PhotosPickerItem?
    @State private var libraryPhoto: PhotosPickerItem?
    @State private var pickingPhoto = false
    @State private var filter: EvKind?
    @State private var query = ""
    @State private var searching = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !model.signedIn { SignInRow().padding(.top, 10) }
                    LibraryList(filter: filter, query: query.trimmingCharacters(in: .whitespaces))
                }
                .padding(.horizontal, Ev.gutter)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.immediately)
            .background(Ev.paper)
            .refreshable { await model.refresh() }
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 10) {
                    TitleBar(showingSettings: $showingSettings)
                    if !model.library.isEmpty {
                        ListBar(filter: $filter, query: $query, searching: $searching)
                    }
                }
                .padding(.horizontal, Ev.gutter)
                .padding(.top, 6)
                .padding(.bottom, 10)
                .background(Ev.paper)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !searching { CaptureDock() }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Detail.self) { DetailView(detail: $0) }
        }
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .sheet(isPresented: $model.composingNote) { NoteComposer() }
        .sheet(isPresented: Binding(get: { model.signIn != .idle }, set: { if !$0 { model.cancelSignIn() } })) {
            SignInSheet()
        }
        .fullScreenCover(isPresented: Binding(get: { model.takingPhoto && CameraPicker.available }, set: { model.takingPhoto = $0 })) {
            CameraPicker { image in
                model.takingPhoto = false
                if let data = image?.jpegData(compressionQuality: 0.85) { model.saveImage(data, kind: .photo) }
            }
            .ignoresSafeArea()
        }
        // No camera (a simulator, or a restricted phone): pick a photo instead.
        .onChange(of: model.takingPhoto) { _, taking in
            if taking && !CameraPicker.available {
                model.takingPhoto = false
                pickingPhoto = true
            }
        }
        .photosPicker(isPresented: $pickingPhoto, selection: $libraryPhoto, matching: .images)
        .photosPicker(isPresented: $model.pickingScreenshot, selection: $screenshot, matching: .screenshots)
        .onChange(of: screenshot) { _, picked in keep(picked, as: .screenshot) { screenshot = nil } }
        .onChange(of: libraryPhoto) { _, picked in keep(picked, as: .photo) { libraryPhoto = nil } }
        .alert("Eavesy", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
    }

    private func keep(_ picked: PhotosPickerItem?, as kind: OutboxItem.Kind, then clear: @escaping () -> Void) {
        guard let picked else { return }
        Task {
            if let data = try? await picked.loadTransferable(type: Data.self) { model.saveImage(data, kind: kind) }
            clear()
        }
    }
}

/// The one mascot, the wordmark, and the way to your account. While the mic
/// is live the mascot carries it: hat up, lens out.
private struct TitleBar: View {
    @Environment(AppModel.self) private var model
    @Binding var showingSettings: Bool

    var body: some View {
        HStack(spacing: 8) {
            Mascot(pose: model.isRecording ? .listening : .idle, recording: model.isRecording, level: model.level, size: 34)
            (Text("eavesy").foregroundStyle(Ev.ink) + Text(".").foregroundStyle(Ev.rec))
                .font(.system(size: 27, weight: .bold, design: .rounded))
                .accessibilityLabel("Eavesy")
            Spacer()
            if model.signedIn, model.waitingToSync > 0 {
                Label("\(model.waitingToSync) waiting", systemImage: "arrow.up")
                    .font(Ev.small)
                    .foregroundStyle(Ev.ink3)
                    .accessibilityLabel("\(model.waitingToSync) waiting to sync")
            }
            Button { showingSettings = true } label: {
                Group {
                    if let initial = model.account?.name?.first ?? model.account?.email?.first {
                        Text(String(initial).uppercased()).font(.system(size: 15, weight: .bold, design: .rounded))
                    } else {
                        Image(systemName: "person").font(.system(size: 15, weight: .semibold))
                    }
                }
                .foregroundStyle(Ev.ink2)
                .frame(width: 36, height: 36)
                .background(Ev.well, in: Circle())
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Account and settings")
        }
    }
}

/// Narrows the list: a pill per kind, and search, which is an icon until used.
private struct ListBar: View {
    @Binding var filter: EvKind?
    @Binding var query: String
    @Binding var searching: Bool
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            if searching {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14, weight: .semibold)).foregroundStyle(Ev.ink3)
                    TextField("Search", text: $query)
                        .font(Ev.ui)
                        .foregroundStyle(Ev.ink)
                        .focused($focused)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                }
                .padding(.horizontal, 12)
                .frame(height: 36)
                .background(Ev.well, in: Capsule())
                Button("Cancel") {
                    query = ""
                    searching = false
                }
                .font(Ev.ui)
                .foregroundStyle(Ev.ink2)
                .padding(.leading, 6)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        pill("All", kind: nil)
                        ForEach(EvKind.allCases) { pill($0.plural, kind: $0) }
                    }
                    .padding(.trailing, 18)
                }
                // The row runs off the edge softly, so it reads as more to come.
                .mask(LinearGradient(stops: [.init(color: .black, location: 0.9), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
                Button {
                    searching = true
                    focused = true
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Ev.ink2)
                        .frame(width: 44, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Search")
            }
        }
        .animation(.easeOut(duration: 0.16), value: searching)
    }

    private func pill(_ title: String, kind: EvKind?) -> some View {
        let chosen = filter == kind
        return Button {
            filter = kind
        } label: {
            HStack(spacing: 6) {
                if let kind { Circle().fill(kind.ink).frame(width: 7, height: 7) }
                Text(title).font(Ev.ui).foregroundStyle(chosen ? Ev.ink : Ev.ink2)
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(chosen ? (kind?.soft ?? Ev.coatSoft) : .clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// Record, and the three things you can keep with one tap. While the mic is
/// live the dock becomes the live card, in place.
private struct CaptureDock: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let since = model.recordingSince {
                LiveCard(since: since)
            } else {
                HStack(spacing: 4) {
                    Button {
                        Task { await model.startRecording() }
                    } label: {
                        HStack(spacing: 9) {
                            Image(systemName: "mic").font(.system(size: 19, weight: .semibold))
                            Text("Record").font(.system(size: 19, weight: .bold, design: .rounded))
                        }
                        .foregroundStyle(Ev.onCoat)
                        .frame(maxWidth: .infinity)
                        .frame(height: 60)
                        .background(Ev.coat, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityHint("Starts a voice note")
                    .padding(.trailing, 4)

                    DockTile(title: "Note", symbol: "square.and.pencil") { model.run(.note) }
                    DockTile(title: "Picture", symbol: "camera") { model.run(.photo) }
                    DockTile(title: "Screenshot", symbol: "camera.viewfinder") { model.run(.screenshot) }
                }
                .padding(8)
                .background(Ev.raised, in: RoundedRectangle(cornerRadius: Ev.rDock, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Ev.rDock, style: .continuous).stroke(Ev.line))
            }
        }
        .evFloat()
        .padding(.horizontal, 12)
        .padding(.top, 14)
        .padding(.bottom, 6)
        // The list fades out under the dock instead of being cut by it.
        .background(
            LinearGradient(colors: [Ev.paper.opacity(0), Ev.paper], startPoint: .top, endPoint: .center)
                .padding(.top, -36)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
        )
        .animation(.easeOut(duration: 0.24), value: model.isRecording)
    }
}

private struct DockTile: View {
    let title: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 20, weight: .regular)).foregroundStyle(Ev.ink)
                Text(title)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(Ev.ink2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .frame(width: 68, height: 60)
            .contentShape(Rectangle())
        }
        .buttonStyle(TileStyle())
    }
}

private struct TileStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Ev.well : .clear, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

private struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.86 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.09), value: configuration.isPressed)
    }
}

/// While the mic is live: the charcoal card with the one coral light, the
/// time, what the mic hears, and Stop.
private struct LiveCard: View {
    @Environment(AppModel.self) private var model
    let since: Date
    @State private var levels = Array(repeating: 0.0, count: 22)

    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(Ev.rec).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 0) {
                Text("Listening").font(Ev.small).foregroundStyle(Ev.hudInk2)
                Text(since, style: .timer)
                    .font(.system(size: 24, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Ev.hudInk)
            }
            .fixedSize()
            HStack(alignment: .center, spacing: 3) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                    Capsule().fill(Ev.hudInk.opacity(0.3 + level * 0.7)).frame(width: 3, height: 4 + level * 30)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: 36)
            .clipped()
            .accessibilityHidden(true)
            Button {
                model.stopRecording()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.white)
                    .frame(width: 56, height: 56)
                    .background(Ev.rec, in: Circle())
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel("Stop recording")
        }
        .padding(.leading, 20)
        .padding(.trailing, 10)
        .frame(height: 76)
        .background(Ev.hud, in: RoundedRectangle(cornerRadius: Ev.rDock, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Ev.rDock, style: .continuous).stroke(Ev.hudLine))
        .onChange(of: model.level) { _, level in
            levels.removeFirst()
            levels.append(level)
        }
    }
}

/// Signed out is not a lesser mode: captures are kept on the phone and say so.
private struct SignInRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 12) {
            Text("Saved on this iPhone. Sign in to get a transcript.")
                .font(.footnote)
                .foregroundStyle(Ev.ink2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Sign in") { model.beginSignIn() }
                .buttonStyle(WellButtonStyle())
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(Ev.raised, in: RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous).stroke(Ev.line))
    }
}
