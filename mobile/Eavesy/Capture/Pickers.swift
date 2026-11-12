import SwiftUI
import UIKit

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage?) -> Void

    static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onImage: onImage) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImage: (UIImage?) -> Void

        init(onImage: @escaping (UIImage?) -> Void) {
            self.onImage = onImage
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onImage(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onImage(nil)
        }
    }
}

enum ImageBytes {
    /// The media type the server files these bytes under.
    static func contentType(_ data: Data) -> String {
        let head = [UInt8](data.prefix(12))
        if head.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if head.starts(with: [0x47, 0x49, 0x46]) { return "image/gif" }
        if head.count == 12, head[4...7].elementsEqual([0x66, 0x74, 0x79, 0x70]) { return "image/heic" }
        if head.count == 12, head[8...11].elementsEqual([0x57, 0x45, 0x42, 0x50]) { return "image/webp" }
        return "image/jpeg"
    }
}
