import SwiftUI
import UIKit

struct CameraPicker: UIViewControllerRepresentable {
  var onImage: (UIImage) -> Void
  var onCancel: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.cameraCaptureMode = .photo
    picker.allowsEditing = false
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {
    context.coordinator.parent = self
  }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    var parent: CameraPicker
    init(_ parent: CameraPicker) { self.parent = parent }

    func imagePickerController(
      _ picker: UIImagePickerController,
      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      if let image = info[.originalImage] as? UIImage {
        parent.onImage(image)
      } else {
        parent.onCancel()
      }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
      parent.onCancel()
    }
  }
}
