import UIKit
import UniformTypeIdentifiers

/// "Save to Eavesy" in the share sheet: the quick way to keep a screenshot
/// (share it from its preview) or any image, text or link. It only writes the
/// item into the app group's inbox; the app files and syncs it.
final class ShareViewController: UIViewController {
    private static let group = "group.com.eavesy.mobile"

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task {
            let saved = await saveAll()
            await show(saved > 0 ? "Saved to Eavesy" : "Couldn't save that")
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private func saveAll() async -> Int {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group) else { return 0 }
        let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)

        var saved = 0
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                guard let data = await image(provider) else { continue }
                saved += write(data, to: inbox, ext: "img")
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                guard let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL else { continue }
                saved += write(Data(url.absoluteString.utf8), to: inbox, ext: "txt")
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                guard let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String else { continue }
                saved += write(Data(text.utf8), to: inbox, ext: "txt")
            }
        }
        return saved
    }

    /// A shared image arrives as a file, as bytes or as a UIImage, depending on the app.
    private func image(_ provider: NSItemProvider) async -> Data? {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) else { return nil }
        if let url = item as? URL { return try? Data(contentsOf: url) }
        if let data = item as? Data { return data }
        return (item as? UIImage)?.pngData()
    }

    private func write(_ data: Data, to inbox: URL, ext: String) -> Int {
        let file = inbox.appendingPathComponent("\(UUID().uuidString).\(ext)")
        return (try? data.write(to: file, options: .atomic)) == nil ? 0 : 1
    }

    private func show(_ message: String) async {
        let label = UILabel()
        label.text = message
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.textColor = .white
        label.textAlignment = .center
        label.backgroundColor = UIColor(red: 0.17, green: 0.145, blue: 0.137, alpha: 0.96)
        label.layer.cornerRadius = 18
        label.layer.masksToBounds = true
        label.frame = CGRect(x: 0, y: 0, width: 200, height: 44)
        label.center = view.center
        view.addSubview(label)
        try? await Task.sleep(for: .milliseconds(700))
    }
}
