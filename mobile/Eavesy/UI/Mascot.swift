import SwiftUI

/// Eavesy, the Little Snoop (`desktop/DESIGN.md` §3). The hat is up only
/// while the mic is live, and the coral lens shows only while recording.
struct Mascot: View {
    enum Pose { case idle, listening, thinking, happy, confused, sleeping }

    var pose: Pose = .idle
    var recording = false
    /// Mic level 0...1; lifts the hat while listening.
    var level: Double = 0
    var size: CGFloat = 72

    var body: some View {
        Canvas { ctx, canvasSize in
            // Geometry is in a 64-unit box, shifted so the raised hat fits.
            let u = canvasSize.width / 72
            ctx.translateBy(x: 4 * u, y: 8 * u)
            ctx.scaleBy(x: u, y: u)
            draw(&ctx)
        }
        .frame(width: size, height: size)
        .animation(.linear(duration: 0.08), value: level)
        .animation(.easeOut(duration: 0.26), value: pose)
        .accessibilityHidden(true)
    }

    private func draw(_ ctx: inout GraphicsContext) {
        let body = GraphicsContext.Shading.color(Ev.mascotBody)
        let eye = GraphicsContext.Shading.color(Ev.mascotEye)
        let listening = pose == .listening
        let lift = listening ? 2 + level * 4 : (pose == .sleeping ? -2.5 : 0)
        let bob = listening ? -2.5 * level : 0

        if size >= 40 {
            ctx.fill(Path(ellipseIn: CGRect(x: 15, y: 58.8, width: 34, height: 4.4)), with: .color(Ev.mascotBody.opacity(0.12)))
        }

        var head = ctx
        head.translateBy(x: 0, y: bob)
        if pose == .confused { Self.rotate(&head, -6, around: CGPoint(x: 32, y: 41)) }
        head.fill(Path(ellipseIn: CGRect(x: 11, y: 24, width: 42, height: 34)), with: body)
        drawEyes(&head, eye)

        var hat = head
        hat.translateBy(x: 0, y: -lift)
        if listening { Self.rotate(&hat, -3, around: CGPoint(x: 32, y: 27)) }
        hat.fill(Path(ellipseIn: CGRect(x: 2, y: 22, width: 60, height: 10)), with: body)
        let crown = crownPath()
        hat.fill(crown, with: body)
        var band = hat
        band.clip(to: crown)
        band.fill(Path(CGRect(x: 10, y: 20, width: 44, height: 4.6)), with: .color(Ev.mascotBand))

        if recording {
            var handle = Path()
            handle.move(to: CGPoint(x: 53, y: 56))
            handle.addLine(to: CGPoint(x: 59, y: 63))
            ctx.stroke(handle, with: .color(Ev.mascotBand), style: StrokeStyle(lineWidth: 3.4, lineCap: .round))
            ctx.fill(Path(ellipseIn: CGRect(x: 41.9, y: 43.9, width: 15.2, height: 15.2)), with: body)
            ctx.fill(Path(ellipseIn: CGRect(x: 44.5, y: 46.5, width: 10, height: 10)), with: .color(Ev.rec))
            ctx.fill(Path(ellipseIn: CGRect(x: 46.5, y: 48.5, width: 2.6, height: 2.6)), with: .color(.white.opacity(0.7)))
        }
    }

    private func drawEyes(_ ctx: inout GraphicsContext, _ eye: GraphicsContext.Shading) {
        switch pose {
        case .happy, .sleeping:
            // Closed: arcs up when happy, dashes down when asleep.
            for x in [25.0, 39.0] {
                var arc = Path()
                let up = pose == .happy
                arc.move(to: CGPoint(x: x - 3.6, y: 43))
                arc.addQuadCurve(to: CGPoint(x: x + 3.6, y: 43), control: CGPoint(x: x, y: up ? 37.5 : 45.5))
                ctx.stroke(arc, with: eye, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
        case .confused:
            ctx.fill(Path(ellipseIn: CGRect(x: 21.2, y: 36.6, width: 7.6, height: 10.8)), with: eye)
            ctx.fill(Path(ellipseIn: CGRect(x: 34.4, y: 35, width: 9.2, height: 13)), with: eye)
        default:
            let dy: CGFloat = pose == .thinking ? -1.6 : 0
            let grow: CGFloat = pose == .listening ? 0.5 : 0
            for x in [25.0, 39.0] {
                ctx.fill(
                    Path(ellipseIn: CGRect(x: x - 3.8 - grow, y: 36.6 + dy - grow, width: 7.6 + grow * 2, height: 10.8 + grow * 2)),
                    with: eye
                )
            }
        }
    }

    private static func rotate(_ ctx: inout GraphicsContext, _ degrees: Double, around point: CGPoint) {
        ctx.translateBy(x: point.x, y: point.y)
        ctx.rotate(by: .degrees(degrees))
        ctx.translateBy(x: -point.x, y: -point.y)
    }

    private func crownPath() -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 13.5, y: 27))
        p.addCurve(to: CGPoint(x: 26.5, y: 8.5), control1: CGPoint(x: 13.8, y: 16.5), control2: CGPoint(x: 19.5, y: 8.5))
        p.addQuadCurve(to: CGPoint(x: 37.5, y: 8.5), control: CGPoint(x: 32, y: 11.5))
        p.addCurve(to: CGPoint(x: 50.5, y: 27), control1: CGPoint(x: 44.5, y: 8.5), control2: CGPoint(x: 50.2, y: 16.5))
        p.closeSubpath()
        return p
    }
}

/// Eavesy's own voice: only in empty states and onboarding, two sentences at most.
struct SpeechBubble: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(.callout, design: .rounded))
            .foregroundStyle(Ev.ink)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Ev.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Ev.line))
    }
}
