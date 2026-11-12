// The iOS app icon (desktop/DESIGN.md §3): the Little Snoop, lens raised, on a
// full-bleed cream square (iOS rounds the corners itself).
//
//   swift mobile/scripts/gen_icon.swift mobile/Eavesy/Assets.xcassets/AppIcon.appiconset/icon.png
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let n = 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

ctx.setFillColor(color(0xFBF7F0))
ctx.fill(CGRect(x: 0, y: 0, width: n, height: n))

// Mascot units: the figure spans x 2...62, y 7...63. Draw it at 62% width, y down.
let s = CGFloat(n) * 0.62 / 60
ctx.translateBy(x: CGFloat(n) / 2 - 32 * s, y: CGFloat(n) / 2 + 35 * s)
ctx.scaleBy(x: s, y: -s)

func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat, _ fill: CGColor) {
    ctx.setFillColor(fill)
    ctx.fillEllipse(in: CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2))
}

let coat = color(0x2B2523)
ellipse(32, 61, 17, 2.2, color(0x2B2523, 0.12))
ellipse(32, 41, 21, 17, coat)
ellipse(25, 42, 3.8, 5.4, color(0xFBF7F0))
ellipse(39, 42, 3.8, 5.4, color(0xFBF7F0))
ellipse(32, 27, 30, 5, coat)

let crown = CGMutablePath()
crown.move(to: CGPoint(x: 13.5, y: 27))
crown.addCurve(to: CGPoint(x: 26.5, y: 8.5), control1: CGPoint(x: 13.8, y: 16.5), control2: CGPoint(x: 19.5, y: 8.5))
crown.addQuadCurve(to: CGPoint(x: 37.5, y: 8.5), control: CGPoint(x: 32, y: 11.5))
crown.addCurve(to: CGPoint(x: 50.5, y: 27), control1: CGPoint(x: 44.5, y: 8.5), control2: CGPoint(x: 50.2, y: 16.5))
crown.closeSubpath()
ctx.addPath(crown)
ctx.setFillColor(coat)
ctx.fillPath()
ctx.saveGState()
ctx.addPath(crown)
ctx.clip()
ctx.setFillColor(color(0x4A403C))
ctx.fill(CGRect(x: 10, y: 20, width: 44, height: 4.6))
ctx.restoreGState()

ctx.setStrokeColor(color(0x4A403C))
ctx.setLineWidth(3.4)
ctx.setLineCap(.round)
ctx.move(to: CGPoint(x: 53, y: 56))
ctx.addLine(to: CGPoint(x: 59, y: 63))
ctx.strokePath()
ellipse(49.5, 51.5, 7.6, 7.6, coat)
ellipse(49.5, 51.5, 5, 5, color(0xFF5A3C))
ellipse(47.8, 49.8, 1.3, 1.3, color(0xFFFFFF, 0.7))

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
precondition(CGImageDestinationFinalize(dest))
