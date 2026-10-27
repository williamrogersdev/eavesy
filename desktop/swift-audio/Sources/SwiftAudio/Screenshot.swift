import AppKit
import Foundation
import ScreenCaptureKit

enum Screenshot {
    static func run(outPath: String) -> Never {
        guard #available(macOS 14.0, *) else { fail("Screenshots require macOS 14 or later.") }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            if let error { fail("Screenshot failed: \(error.localizedDescription)") }
            guard let content, let display = captureDisplay(content) else { fail("No display is available.") }
            let excluded = content.applications.filter { $0.bundleIdentifier == "com.eavesy.desktop" }
            let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            let config = SCStreamConfiguration()
            let scale = CGFloat(filter.pointPixelScale)
            config.width = Int((filter.contentRect.width * scale).rounded())
            config.height = Int((filter.contentRect.height * scale).rounded())
            config.showsCursor = false
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                if let error { fail("Screenshot failed: \(error.localizedDescription)") }
                guard let image, let bytes = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { fail("Could not encode screenshot.") }
                do { try bytes.write(to: URL(fileURLWithPath: outPath), options: .atomic) }
                catch { fail("Could not save screenshot: \(error.localizedDescription)") }
                exit(0)
            }
        }
        RunLoop.main.run()
        exit(1)
    }
}

func captureDisplay(_ content: SCShareableContent) -> SCDisplay? {
    if !Thread.isMainThread { return DispatchQueue.main.sync { captureDisplay(content) } }
    let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) }
    let id = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    return content.displays.first { $0.displayID == id } ?? content.displays.first
}
