import SwiftUI
import UIKit

/// The `--ev-*` tokens from `web/src/components/launcher/ui/tokens.css`, for
/// SwiftUI. The standard is `desktop/DESIGN.md`: cream paper, charcoal ink,
/// and coral only while something is recording.
enum Ev {
    // surfaces
    static let paper = dyn(0xFBF7F0, 0x1C1B1A)
    static let well = dyn(0xF2EBDF, 0x232220)
    static let raised = dyn(0xFFFDF8, 0x282725)
    static let line = dyn(0xE6DDCF, 0x353331)
    static let lineStrong = dyn(0xD3C7B6, 0x46433F)
    // ink
    static let ink = dyn(0x211C1A, 0xF2EFEA)
    static let ink2 = dyn(0x5F5751, 0xAEA9A2)
    static let ink3 = dyn(0x968D85, 0x7C7771)
    // brand
    static let coat = dyn(0x2B2523, 0xF2EFEA)
    static let coatSoft = dyn(0xECE6DF, 0x302E2C)
    static let onCoat = dyn(0xFBF7F0, 0x1C1B1A)
    static let manila = dyn(0xE2B866, 0xF0C879)
    static let manilaSoft = dyn(0xF6E8CC, 0x3A2F1C)
    static let manilaInk = dyn(0x6E4A12, 0xF5D9A0)
    static let mascotBody = dyn(0x2B2523, 0x3B3836)
    static let mascotBand = dyn(0x4A403C, 0x57524E)
    static let mascotEye = dyn(0xFBF7F0, 0xF2EFEA)
    // meaning
    /// The coral light. Recording only.
    static let rec = dyn(0xFF5A3C, 0xFF6A4D)
    static let recSoft = dyn(0xFFE3DA, 0x3A1D16)
    static let leaf = dyn(0x2F8A5B, 0x6FCF97)
    static let leafSoft = dyn(0xDDF1E5, 0x1F3328)
    static let warnInk = dyn(0x9A5B00, 0xFFC870)
    static let warnSoft = dyn(0xFFF0D6, 0x3A2C17)
    // kinds
    static let voice = dyn(0x2A5CB8, 0x86AEF5)
    static let voiceSoft = dyn(0xE3EBFA, 0x1F2A40)
    static let meeting = dyn(0x7A4BB5, 0xBC9AF0)
    static let meetingSoft = dyn(0xECE4F7, 0x2D2440)
    static let screen = dyn(0x0A6772, 0x5FC7D2)
    static let screenSoft = dyn(0xDCF0F1, 0x173236)
    static let note = dyn(0x85580C, 0xF0C879)
    static let noteSoft = dyn(0xF6E8CC, 0x3A2F1C)

    // the live card: the same charcoal in both modes, as on the Mac
    static let hud = Color(UIColor(hex: 0x161312))
    static let hudInk = Color(UIColor(hex: 0xF6EFE4))
    static let hudInk2 = Color(UIColor(hex: 0xF6EFE4)).opacity(0.62)
    static let hudLine = Color(red: 1, green: 0.94, blue: 0.86).opacity(0.14)
    /// Shadows are charcoal-tinted, never neutral grey.
    static let shade = Color(UIColor { UIColor(hex: 0x211C1A).withAlphaComponent($0.userInterfaceStyle == .dark ? 0.6 : 0.3) })

    // radii: they grow with the container
    static let rCtl: CGFloat = 12
    static let rPanel: CGFloat = 18
    static let rMedia: CGFloat = 10
    static let rDock: CGFloat = 28
    /// The page gutter.
    static let gutter: CGFloat = 20

    // type: rounded for UI, text face for reading
    static func title(_ size: CGFloat = 24) -> Font { .system(size: size, weight: .bold, design: .rounded) }
    static let head = Font.system(.headline, design: .rounded).weight(.semibold)
    static let ui = Font.system(.subheadline, design: .rounded).weight(.medium)
    static let small = Font.system(.caption, design: .rounded).weight(.medium)
    static let group = Font.system(.caption, design: .rounded).weight(.bold)
    static let body = Font.system(.body)
    /// Long text: notes and transcripts.
    static let reading = Font.system(size: 17)

    private static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// The primary action: the coat.
struct CoatButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Ev.head)
            .foregroundStyle(Ev.onCoat)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Ev.coat, in: RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// A quiet secondary action on the well.
struct WellButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Ev.ui)
            .foregroundStyle(Ev.ink)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Ev.well, in: RoundedRectangle(cornerRadius: Ev.rCtl, style: .continuous))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// The four kinds of thing Eavesy keeps. Each has one ink, worn only by its
/// index tab and its filter dot (`desktop/DESIGN.md` §4).
enum EvKind: String, CaseIterable, Identifiable {
    case voice, meeting, screen, note

    var id: String { rawValue }

    var ink: Color {
        switch self {
        case .voice: Ev.voice
        case .meeting: Ev.meeting
        case .screen: Ev.screen
        case .note: Ev.note
        }
    }

    var soft: Color {
        switch self {
        case .voice: Ev.voiceSoft
        case .meeting: Ev.meetingSoft
        case .screen: Ev.screenSoft
        case .note: Ev.noteSoft
        }
    }

    /// The filter's name for the kind.
    var plural: String {
        switch self {
        case .voice: "Voice"
        case .meeting: "Meetings"
        case .screen: "Pictures"
        case .note: "Notes"
        }
    }
}

/// A kind's index tab: its icon on its soft tint.
struct KindTab: View {
    let kind: EvKind
    let symbol: String
    var size: CGFloat = 34

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.44, weight: .medium))
            .foregroundStyle(kind.ink)
            .frame(width: size, height: size)
            .background(kind.soft, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityHidden(true)
    }
}

extension View {
    /// Menus, thumbnails, cards that sit just above the paper.
    func evLift() -> some View {
        shadow(color: Ev.shade.opacity(0.35), radius: 7, y: 4)
    }

    /// The dock and the live card: the one thing floating over the page.
    func evFloat() -> some View {
        shadow(color: Ev.shade.opacity(0.75), radius: 22, y: 12)
    }
}
