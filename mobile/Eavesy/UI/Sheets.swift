import SafariServices
import SwiftUI

/// A note is typed, saved and gone: the keyboard is up before the sheet
/// settles, and the page is nothing but paper and what you write.
struct NoteComposer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel") { dismiss() }
                    .font(Ev.ui)
                    .foregroundStyle(Ev.ink2)
                    .frame(height: 44)
                Spacer()
                HStack(spacing: 6) {
                    Circle().fill(Ev.note).frame(width: 7, height: 7)
                    Text("Note").font(Ev.ui).foregroundStyle(Ev.ink2)
                }
                Spacer()
                Button {
                    model.saveNote(text)
                    dismiss()
                } label: {
                    Text("Save")
                        .font(Ev.ui.weight(.bold))
                        .foregroundStyle(empty ? Ev.ink3 : Ev.onCoat)
                        .padding(.horizontal, 16)
                        .frame(height: 36)
                        .background(empty ? Ev.coatSoft : Ev.coat, in: Capsule())
                }
                .disabled(empty)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, Ev.gutter)
            .padding(.top, 10)

            TextEditor(text: $text)
                .focused($focused)
                .font(Ev.reading)
                .lineSpacing(5)
                .foregroundStyle(Ev.ink)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, Ev.gutter - 5)
                .padding(.top, 6)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Jot a note…")
                            .font(Ev.reading)
                            .foregroundStyle(Ev.ink3)
                            .padding(.horizontal, Ev.gutter)
                            .padding(.top, 14)
                            .allowsHitTesting(false)
                    }
                }
        }
        .background(Ev.paper)
        .presentationBackground(Ev.paper)
        .presentationCornerRadius(Ev.rDock)
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
            VStack(spacing: 18) {
                Spacer()
                Mascot(pose: .confused, size: 96)
                Text(message)
                    .font(Ev.head)
                    .foregroundStyle(Ev.ink)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Try again") { model.beginSignIn() }.buttonStyle(CoatButtonStyle())
                Button("Stay local for now") { model.cancelSignIn() }
                    .font(Ev.ui)
                    .foregroundStyle(Ev.ink2)
                    .frame(height: 44)
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Ev.paper)
        default:
            VStack(spacing: 16) {
                Mascot(pose: .thinking, size: 96)
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

/// Who is signed in, where things stand, and the faster ways in.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    Spacer()
                    Button("Done") { dismiss() }
                        .font(Ev.ui.weight(.bold))
                        .foregroundStyle(Ev.ink)
                        .padding(.horizontal, 16)
                        .frame(height: 36)
                        .background(Ev.well, in: Capsule())
                        .buttonStyle(.plain)
                }

                account

                VStack(alignment: .leading, spacing: 10) {
                    Text("Faster ways in")
                        .font(.system(.subheadline, design: .rounded).weight(.bold))
                        .foregroundStyle(Ev.ink2)
                    VStack(spacing: 0) {
                        way(.voice, "hand.tap", "Long-press the Eavesy icon", "Record, Note, Picture and Screenshot are one press away.")
                        rule
                        way(.meeting, "button.programmable", "Use the Action button", "In Settings, set it to the shortcut \u{201C}Record a voice note\u{201D}.")
                        rule
                        way(.screen, "square.and.arrow.up", "Share to Eavesy", "From a screenshot's preview, or any picture or text.")
                        rule
                        way(.note, "mic", "Ask Siri", "\u{201C}Record with Eavesy.\u{201D}")
                    }
                    .background(Ev.raised, in: RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Ev.rPanel, style: .continuous).stroke(Ev.line))
                }

                Text("Everything is written to this iPhone first, then sent when there's a connection.")
                    .font(.footnote)
                    .foregroundStyle(Ev.ink3)
                    .fixedSize(horizontal: false, vertical: true)

                if model.signedIn {
                    Button("Sign out") {
                        model.signOut()
                        dismiss()
                    }
                    .font(Ev.ui)
                    .foregroundStyle(Ev.ink2)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Ev.well, in: RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous))
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Ev.gutter)
            .padding(.top, 14)
            .padding(.bottom, 32)
        }
        .background(Ev.paper)
        .presentationBackground(Ev.paper)
        .presentationCornerRadius(Ev.rDock)
    }

    @ViewBuilder
    private var account: some View {
        if model.signedIn {
            HStack(spacing: 14) {
                Mascot(size: 56)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.account?.name ?? model.account?.email ?? "This iPhone is connected")
                        .font(Ev.title(20))
                        .foregroundStyle(Ev.ink)
                        .lineLimit(1)
                    if model.account?.name != nil, let email = model.account?.email {
                        Text(email).font(Ev.small).foregroundStyle(Ev.ink3).lineLimit(1)
                    }
                    HStack(spacing: 6) {
                        Circle().fill(model.waitingToSync == 0 ? Ev.leaf : Ev.ink3).frame(width: 7, height: 7)
                        Text(model.waitingToSync == 0 ? "Syncing to eavesy.com" : "\(model.waitingToSync) waiting to sync")
                            .font(Ev.small)
                            .foregroundStyle(Ev.ink2)
                    }
                    .padding(.top, 2)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 14) {
                    Mascot(size: 56)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Saved on this iPhone").font(Ev.title(20)).foregroundStyle(Ev.ink)
                        Text("Sign in to get transcripts and summaries, and to see everything on your other devices.")
                            .font(.subheadline)
                            .foregroundStyle(Ev.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Button("Sign in at eavesy.com") {
                    dismiss()
                    model.beginSignIn()
                }
                .buttonStyle(CoatButtonStyle())
            }
        }
    }

    private var rule: some View {
        Rectangle().fill(Ev.line).frame(height: 1).padding(.leading, 60)
    }

    private func way(_ kind: EvKind, _ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            KindTab(kind: kind, symbol: symbol)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Ev.ui).foregroundStyle(Ev.ink)
                Text(detail).font(.footnote).foregroundStyle(Ev.ink2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}
