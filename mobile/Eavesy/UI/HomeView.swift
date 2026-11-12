import EavesyKit
import PhotosUI
import SwiftUI

/// The whole app on one screen: the capture pad on top, everything you've
/// kept below it. Starting a capture never moves you somewhere else.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showingSettings = false
    @State private var screenshot: PhotosPickerItem?
    @State private var libraryPhoto: PhotosPickerItem?
    @State private var pickingPhoto = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    CapturePad()
                    if !model.signedIn { SignInRow() }
                    LibraryList()
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .background(Ev.paper)
            .refreshable { await model.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Wordmark() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingSettings = true } label: { Image(systemName: "person.crop.circle") }
                        .accessibilityLabel("Account")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Detail.self) { DetailView(detail: $0) }
        }
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .sheet(isPresented: $model.composingNote) { NoteComposer() }
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

private struct Wordmark: View {
    var body: some View {
        HStack(spacing: 6) {
            Mascot(size: 22)
            (Text("eavesy").foregroundStyle(Ev.ink) + Text(".").foregroundStyle(Ev.rec))
                .font(.system(size: 19, weight: .bold, design: .rounded))
        }
        .fixedSize()
        .accessibilityElement()
        .accessibilityLabel("Eavesy")
    }
}

/// Record, and the three things you can keep with one tap.
private struct CapturePad: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 12) {
            if let since = model.recordingSince {
                RecordingCard(since: since)
            } else {
                Button {
                    Task { await model.startRecording() }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "mic.fill").font(.title2)
                        Text("Record").font(Ev.title(22))
                    }
                    .foregroundStyle(Ev.onCoat)
                    .frame(maxWidth: .infinity, minHeight: 92)
                    .background(Ev.coat, in: RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Starts a voice note")
            }
            HStack(spacing: 12) {
                CaptureTile(title: "Note", symbol: "square.and.pencil", ink: Ev.note, wash: Ev.noteSoft) { model.run(.note) }
                CaptureTile(title: "Picture", symbol: "camera.fill", ink: Ev.screen, wash: Ev.screenSoft) { model.run(.photo) }
                CaptureTile(title: "Screenshot", symbol: "iphone.gen3", ink: Ev.screen, wash: Ev.screenSoft) { model.run(.screenshot) }
            }
        }
        .padding(.top, 8)
        .animation(.easeOut(duration: 0.2), value: model.isRecording)
    }
}

private struct CaptureTile: View {
    let title: String
    let symbol: String
    let ink: Color
    let wash: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: symbol).font(.title3).foregroundStyle(ink)
                Text(title).font(Ev.ui).foregroundStyle(Ev.ink)
            }
            .frame(maxWidth: .infinity, minHeight: 76)
            .background(wash, in: RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

/// While the mic is live: the hat is up, the lens is out, and Stop is the only button.
private struct RecordingCard: View {
    @Environment(AppModel.self) private var model
    let since: Date

    var body: some View {
        HStack(spacing: 14) {
            Mascot(pose: .listening, recording: true, level: model.level, size: 64)
            VStack(alignment: .leading, spacing: 2) {
                Text("Listening").font(Ev.head).foregroundStyle(Ev.ink)
                Text(since, style: .timer)
                    .font(.system(size: 28, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Ev.ink)
            }
            Spacer()
            Button {
                model.stopRecording()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.title2)
                    .foregroundStyle(.white)
                    .frame(width: 60, height: 60)
                    .background(Ev.rec, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop recording")
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 92)
        .background(Ev.recSoft, in: RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous).stroke(Ev.rec.opacity(0.35)))
    }
}

/// Signed out is not a lesser mode: captures are kept on the phone and say so.
private struct SignInRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "iphone").foregroundStyle(Ev.ink2)
            Text("Saved on this iPhone. Sign in to get transcripts and sync.")
                .font(.footnote)
                .foregroundStyle(Ev.ink2)
            Spacer(minLength: 4)
            Button("Sign in") { model.beginSignIn() }
                .buttonStyle(WellButtonStyle())
        }
        .padding(12)
        .background(Ev.raised, in: RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous).stroke(Ev.line))
        .sheet(isPresented: Binding(get: { model.signIn != .idle }, set: { if !$0 { model.cancelSignIn() } })) {
            SignInSheet()
        }
    }
}
