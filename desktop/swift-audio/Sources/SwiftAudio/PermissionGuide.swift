import AppKit
import Foundation

/// `--permission-guide <pane> --app <Eavesy.app>`: a small floating card beside System Settings
/// that holds Eavesy's icon, so the person can drag the app straight into a Privacy & Security
/// list (Accessibility, Screen Recording, Input Monitoring) instead of hunting through the "+"
/// file picker.
///
/// The card follows the System Settings window and closes on its own when Settings closes. The
/// app writes `granted` on stdin once the permission is on: the card shows a check, then quits.
/// It also quits when stdin closes, so it never outlives the app.
enum PermissionGuide {
    struct Pane: Equatable {
        let id: String
        let name: String
        /// The list's name, short enough for the card's title.
        let list: String
        let reason: String
    }

    static func pane(_ id: String) -> Pane? {
        switch id {
        case "accessibility":
            return Pane(id: id, name: "Accessibility", list: "Accessibility", reason: "so Eavesy can paste what you dictate")
        case "screen":
            // macOS 15 renamed the list from "Screen Recording".
            let name = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15
                ? "Screen & System Audio Recording" : "Screen Recording"
            return Pane(id: id, name: name, list: name, reason: "so Eavesy can record meetings and your screen")
        case "input_monitoring":
            return Pane(id: id, name: "Input Monitoring", list: "Input Monitoring", reason: "so the Fn key shortcut works")
        default:
            return nil
        }
    }

    static func run(arguments: [String]) -> Never {
        guard let index = arguments.firstIndex(of: "--permission-guide"), index + 1 < arguments.count,
              let pane = pane(arguments[index + 1]),
              let appIndex = arguments.firstIndex(of: "--app"), appIndex + 1 < arguments.count else {
            fail("usage: --permission-guide accessibility|screen|input_monitoring --app /path/to/Eavesy.app")
        }
        let appURL = URL(fileURLWithPath: arguments[appIndex + 1])
        // How long to wait for System Settings to open before giving up: longer when a macOS
        // prompt, not Eavesy, will open it.
        let wait = arguments.firstIndex(of: "--wait").flatMap { $0 + 1 < arguments.count ? Double(arguments[$0 + 1]) : nil } ?? 8
        guard FileManager.default.fileExists(atPath: appURL.path) else { fail("no app at \(appURL.path)") }

        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = GuideController(pane: pane, appURL: appURL, wait: wait)
        controller.start()

        DispatchQueue.global().async {
            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespaces) == "granted" {
                    DispatchQueue.main.async { controller.showGranted() }
                }
            }
            // stdin closed: the app quit or no longer wants the card. Let a check finish showing.
            DispatchQueue.main.async { controller.finish(after: controller.granted ? 1.4 : 0) }
        }
        application.run()
        exit(0)
    }

    // MARK: Placement

    /// Where the card goes, in Cocoa screen coordinates (origin bottom-left): under the Settings
    /// window's right edge when there's room, else beside it on the right, else inside its
    /// bottom-right corner.
    static func origin(card: CGSize, settings: CGRect, visible: CGRect, gap: CGFloat = 12) -> CGPoint {
        let alignedRight = min(max(settings.maxX - card.width, visible.minX + gap), visible.maxX - card.width - gap)
        let below = settings.minY - gap - card.height
        if below >= visible.minY + gap {
            return CGPoint(x: alignedRight, y: below)
        }
        let right = settings.maxX + gap
        if right + card.width <= visible.maxX - gap {
            return CGPoint(x: right, y: max(settings.minY, visible.minY + gap))
        }
        let insideRight = min(max(settings.maxX - card.width - gap, visible.minX + gap), visible.maxX - card.width - gap)
        return CGPoint(x: insideRight, y: max(settings.minY + gap, visible.minY + gap))
    }

    /// Converts a CoreGraphics window bound (origin top-left of the main display) to Cocoa.
    static func cocoaRect(fromCG rect: CGRect, mainScreenHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: mainScreenHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    /// Whether System Settings is still running.
    static func settingsRunning() -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").isEmpty
    }

    /// The front System Settings window, in CoreGraphics coordinates.
    static func settingsWindowCG() -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] else { return nil }
        for info in list {
            guard let owner = info[kCGWindowOwnerName as String] as? String,
                  owner == "System Settings" || owner == "System Preferences",
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  bounds.width > 200, bounds.height > 200 else { continue }
            return bounds
        }
        return nil
    }
}

/// A borderless panel that never takes focus from System Settings.
private final class GuidePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class GuideController {
    let pane: PermissionGuide.Pane
    let appURL: URL
    private(set) var granted = false
    private var panel: GuidePanel?
    private var content: GuideView?
    private var timer: Timer?
    private var lastSettings: CGRect?
    private var seenSettings = false
    private var missingSince: Date?
    private let started = Date()
    private let wait: TimeInterval

    init(pane: PermissionGuide.Pane, appURL: URL, wait: TimeInterval) {
        self.pane = pane
        self.appURL = appURL
        self.wait = wait
    }

    func start() {
        let view = GuideView(pane: pane, appURL: appURL, onClose: { [weak self] in self?.finish(after: 0) })
        let size = view.fittingSize
        let panel = GuidePanel(contentRect: CGRect(origin: .zero, size: size),
                               styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.contentView = view
        self.panel = panel
        self.content = view
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func tick() {
        guard let panel else { return }
        if Date().timeIntervalSince(started) > 15 * 60 { finish(after: 0); return }
        guard let cg = PermissionGuide.settingsWindowCG() else {
            // Not on screen: not open yet, closed, or on another Space, minimized or behind a
            // full-screen app. Hide meanwhile, and quit only once System Settings has quit
            // (closing its window quits it) or never showed up.
            if seenSettings { panel.orderOut(nil) }
            let since = missingSince ?? Date()
            missingSince = since
            let gone = seenSettings
                ? !PermissionGuide.settingsRunning() && Date().timeIntervalSince(since) > 1
                : Date().timeIntervalSince(since) > wait
            if gone {
                if !seenSettings {
                    FileHandle.standardError.write(Data("permission guide: System Settings didn't open within \(Int(wait)) s\n".utf8))
                }
                finish(after: 0)
            }
            return
        }
        missingSince = nil
        seenSettings = true
        guard cg != lastSettings || !panel.isVisible else { return }
        lastSettings = cg
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let settings = PermissionGuide.cocoaRect(fromCG: cg, mainScreenHeight: mainHeight)
        let center = CGPoint(x: settings.midX, y: settings.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(center) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? settings
        let origin = PermissionGuide.origin(card: panel.frame.size, settings: settings, visible: visible)
        let firstShow = !panel.isVisible
        panel.setFrameOrigin(origin)
        if firstShow {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.2
                panel.animator().alphaValue = 1
            }
        }
    }

    func showGranted() {
        guard !granted else { return }
        granted = true
        content?.showGranted()
        finish(after: 1.6)
    }

    func finish(after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.timer?.invalidate()
            guard let panel = self?.panel, panel.isVisible else { exit(0) }
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.18
                panel.animator().alphaValue = 0
            }, completionHandler: { exit(0) })
        }
    }
}

// MARK: Views

private final class GuideView: NSVisualEffectView {
    private let pane: PermissionGuide.Pane
    private let arrow = NSImageView()
    private let title = NSTextField(wrappingLabelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let hint = NSTextField(wrappingLabelWithString: "")
    private let dragRow: DragRow
    private let onClose: () -> Void

    init(pane: PermissionGuide.Pane, appURL: URL, onClose: @escaping () -> Void) {
        self.pane = pane
        self.onClose = onClose
        self.dragRow = DragRow(appURL: appURL)
        super.init(frame: CGRect(x: 0, y: 0, width: 340, height: 10))
        material = .popover
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.masksToBounds = true
        layer?.borderWidth = 0.5
        layer?.borderColor = NSColor.separatorColor.cgColor

        arrow.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 17, weight: .semibold))
        arrow.contentTintColor = .controlAccentColor
        arrow.wantsLayer = true

        title.stringValue = "Drag Eavesy into the \(pane.list) list"
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        detail.stringValue = "Turns on \(pane.name), \(pane.reason)."
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        hint.stringValue = "Or click + under the list and choose Eavesy."
        hint.font = .systemFont(ofSize: 11)
        hint.textColor = .tertiaryLabelColor
        for label in [title, detail, hint] { label.preferredMaxLayoutWidth = 260 }

        let close = NSButton(image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")!,
                             target: nil, action: nil)
        close.isBordered = false
        close.contentTintColor = .secondaryLabelColor
        close.target = self
        close.action = #selector(closeClicked)

        let texts = NSStackView(views: [title, detail])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 3
        let header = NSStackView(views: [arrow, texts, close])
        header.alignment = .top
        header.spacing = 10
        arrow.setContentHuggingPriority(.required, for: .horizontal)
        close.setContentHuggingPriority(.required, for: .horizontal)

        let stack = NSStackView(views: [header, dragRow, hint])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 14, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            widthAnchor.constraint(equalToConstant: 340),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -30),
            dragRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -30),
        ])
        dragRow.onDropped = { [weak self] in self?.showDropped() }
        layoutSubtreeIfNeeded()
    }

    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        bounceArrow()
    }

    private func bounceArrow() {
        guard let layer = arrow.layer else { return }
        let bounce = CABasicAnimation(keyPath: "transform.translation.y")
        bounce.fromValue = 0
        bounce.toValue = 4
        bounce.duration = 0.55
        bounce.autoreverses = true
        bounce.repeatCount = .infinity
        bounce.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(bounce, forKey: "bounce")
    }

    @objc private func closeClicked() { onClose() }

    /// The drop landed: macOS usually asks for the Mac's password next.
    private func showDropped() {
        title.stringValue = "Almost there"
        detail.stringValue = pane.id == "screen"
            ? "Enter your Mac password if asked and switch Eavesy on. If macOS offers Quit & Reopen, choose it: Eavesy needs a restart to record."
            : "If macOS asks, enter your Mac password, then make sure Eavesy is switched on."
    }

    func showGranted() {
        arrow.layer?.removeAllAnimations()
        arrow.image = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 17, weight: .semibold))
        arrow.contentTintColor = .systemGreen
        title.stringValue = "\(pane.name) is on"
        detail.stringValue = "You can close System Settings."
        dragRow.isHidden = true
        hint.isHidden = true
        layoutSubtreeIfNeeded()
        if let window {
            var frame = window.frame
            let height = fittingSize.height
            frame.origin.y += frame.height - height
            frame.size.height = height
            window.setFrame(frame, display: true, animate: true)
        }
    }
}

/// The row holding Eavesy's icon. Dragging it hands System Settings the app bundle's file URL,
/// the same thing dragging the app from Finder does.
private final class DragRow: NSView, NSDraggingSource {
    private let appURL: URL
    private let icon: NSImage
    private var mouseDownAt: NSPoint?
    private var hovering = false { didSet { updateLook() } }
    var onDropped: (() -> Void)?

    init(appURL: URL) {
        self.appURL = appURL
        self.icon = NSWorkspace.shared.icon(forFile: appURL.path)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 1

        let iconView = NSImageView(image: icon)
        iconView.imageScaling = .scaleProportionallyUpOrDown
        let name = NSTextField(labelWithString: FileManager.default.displayName(atPath: appURL.path)
            .replacingOccurrences(of: ".app", with: ""))
        name.font = .systemFont(ofSize: 14, weight: .medium)
        let grip = NSImageView(image: NSImage(systemSymbolName: "line.3.horizontal", accessibilityDescription: nil)!)
        grip.contentTintColor = .tertiaryLabelColor
        let row = NSStackView(views: [iconView, name, NSView(), grip])
        row.spacing = 10
        row.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 28),
            iconView.heightAnchor.constraint(equalToConstant: 28),
        ])
        setAccessibilityRole(.button)
        setAccessibilityLabel("Drag Eavesy to System Settings")
        updateLook()
    }

    required init?(coder: NSCoder) { nil }

    private func updateLook() {
        layer?.backgroundColor = (hovering ? NSColor.controlAccentColor.withAlphaComponent(0.14)
                                           : NSColor.labelColor.withAlphaComponent(0.06)).cgColor
        layer?.borderColor = (hovering ? NSColor.controlAccentColor.withAlphaComponent(0.6)
                                       : NSColor.separatorColor).cgColor
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .cursorUpdate, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func cursorUpdate(with event: NSEvent) { NSCursor.openHand.set() }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func mouseDown(with event: NSEvent) {
        mouseDownAt = convert(event.locationInWindow, from: nil)
        NSCursor.closedHand.set()
    }

    override func mouseUp(with event: NSEvent) {
        mouseDownAt = nil
        NSCursor.openHand.set()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = mouseDownAt else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - start.x, point.y - start.y) > 3 else { return }
        mouseDownAt = nil
        let item = NSDraggingItem(pasteboardWriter: appURL as NSURL)
        let size = CGSize(width: 48, height: 48)
        item.setDraggingFrame(CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                                     width: size.width, height: size.height), contents: icon)
        let session = beginDraggingSession(with: [item], event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? [.copy, .link, .generic] : []
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        if !operation.isEmpty { onDropped?() }
    }
}
