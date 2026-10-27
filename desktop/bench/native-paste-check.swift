import AppKit
import Foundation
NSApplication.shared.setActivationPolicy(.prohibited)
let text = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
let board = NSPasteboard.withUniqueName()
board.declareTypes([.string], owner: nil)
guard board.setString(text, forType: .string) else { fatalError("pasteboard write failed") }
let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
guard editor.readSelection(from: board, type: .string) else { fatalError("native text paste failed") }
guard editor.string == text else { fatalError("native paste truncated or changed the message") }
print("Native isolated paste verified: \(text.split(whereSeparator: { $0.isWhitespace }).count) words; exact text match")
