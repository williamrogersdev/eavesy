import SafariServices
import SwiftUI

/// A note is typed, saved and gone: the keyboard is up before the sheet settles.
struct NoteComposer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .focused($focused)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 12)
                .background(Ev.paper)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Jot a note…").foregroundStyle(Ev.ink3).padding(.horizontal, 17).padding(.top, 8).allowsHitTesting(false)
                    }
                }
                .navigationTitle("Note")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            model.saveNote(text)
                            dismiss()
                        }
                        .fontWeight(.semibold)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
        }
        .onAppear { focused = true }
    }
}

/// Sign-in happens at eavesy.com, in a browser sheet; the app waits for the answer.
struct SignInSheet: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.signIn {
        case .waiting(let url):
            SafariView(url: url).ignoresSafeArea()
        case .failed(let message):
            VStack(spacing: 16) {
                Mascot(pose: .confused, size: 72)
                Text(message).font(Ev.head).foregroundStyle(Ev.ink).multilineTextAlignment(.center)
                Button("Try again") { model.beginSignIn() }.buttonStyle(CoatButtonStyle())
                Button("Stay local for now") { model.cancelSignIn() }.font(Ev.ui).foregroundStyle(Ev.ink2)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Ev.paper)
        default:
            VStack(spacing: 16) {
                Mascot(pose: .thinking, size: 72)
                ProgressView()
                Text("Opening eavesy.com…").font(Ev.ui).foregroundStyle(Ev.ink2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Ev.paper)
        }
    }
}

private struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let safari = SFSafariViewController(url: url)
        safari.dismissButtonStyle = .cancel
        return safari
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    if model.signedIn {
                        LabeledContent("Signed in", value: model.account?.email ?? "This iPhone is connected")
                        Button("Sign out", role: .destructive) { model.signOut() }
                    } else {
                        Text("Captures are saved on this iPhone. Sign in to get transcripts and see them on your other devices.")
                            .font(.footnote)
                            .foregroundStyle(Ev.ink2)
                        Button("Sign in at eavesy.com") {
                            dismiss()
                            model.beginSignIn()
                        }
                    }
                }
                Section {
                    LabeledContent("Waiting to sync", value: "\(model.waitingToSync)")
                } header: {
                    Text("Sync")
                } footer: {
                    Text("Everything is written to this iPhone first, then sent when there's a connection.")
                }
                Section {
                    Label("Long-press the Eavesy icon for Record, Note, Picture and Screenshot.", systemImage: "hand.tap")
                    Label("Put \"Record a voice note\" on the Action button in Settings.", systemImage: "button.programmable")
                    Label("Share a screenshot to Eavesy from its preview.", systemImage: "square.and.arrow.up")
                } header: {
                    Text("Faster ways in")
                }
                .font(.footnote)
                .foregroundStyle(Ev.ink2)
            }
            .navigationTitle("Eavesy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
