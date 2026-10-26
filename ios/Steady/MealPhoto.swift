import CoreTransferable
import UIKit
import UniformTypeIdentifiers

/// Downscales a meal photo the same way the site does.
/// The estimate uses a 1024px JPEG. The meal keeps a smaller JPEG, at most 120,000 characters.
enum MealPhoto {
  static let aiEdge: CGFloat = 1024
  static let aiQuality: CGFloat = 0.8
  static let thumbEdge: CGFloat = 480
  static let thumbQuality: CGFloat = 0.6
  static let tightEdge: CGFloat = 360
  static let tightQuality: CGFloat = 0.5
  static let maxThumbCharacters = 120_000
  static let maxEstimateCharacters = 4_000_000
  static let jpegPrefix = "data:image/jpeg;base64,"

  struct Prepared {
    var preview: String?
    var estimate: String
    var droppedPreview: Bool
  }

  static func prepare(_ image: UIImage) -> Prepared? {
    guard let estimate = jpegDataURL(image, maxEdge: aiEdge, quality: aiQuality),
          estimate.count <= maxEstimateCharacters else { return nil }
    guard let wide = jpegDataURL(image, maxEdge: thumbEdge, quality: thumbQuality) else { return nil }
    var preview: String? = wide.count <= maxThumbCharacters ? wide : nil
    if preview == nil,
       let tight = jpegDataURL(image, maxEdge: tightEdge, quality: tightQuality),
       tight.count <= maxThumbCharacters {
      preview = tight
    }
    return Prepared(preview: preview, estimate: estimate, droppedPreview: preview == nil)
  }

  static func image(from dataURL: String) -> UIImage? {
    guard let range = dataURL.range(of: ",") else { return nil }
    let payload = String(dataURL[range.upperBound...])
    guard let data = Data(base64Encoded: payload) else { return nil }
    return UIImage(data: data)
  }

  static func jpegDataURL(_ image: UIImage, maxEdge: CGFloat, quality: CGFloat) -> String? {
    let scaled = scaled(image, maxEdge: maxEdge)
    guard let data = scaled.jpegData(compressionQuality: quality) else { return nil }
    return jpegPrefix + data.base64EncodedString()
  }

  static func scaled(_ image: UIImage, maxEdge: CGFloat) -> UIImage {
    let widthPx = max(image.size.width, 1) * image.scale
    let heightPx = max(image.size.height, 1) * image.scale
    let longest = max(widthPx, heightPx)
    let ratio = min(1, maxEdge / longest)
    let width = max(1, (widthPx * ratio).rounded())
    let height = max(1, (heightPx * ratio).rounded())
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
    return renderer.image { _ in
      UIColor.white.setFill()
      UIBezierPath(rect: CGRect(x: 0, y: 0, width: width, height: height)).fill()
      image.draw(in: CGRect(x: 0, y: 0, width: width, height: height))
    }
  }
}

struct MealLibraryPhoto: Transferable {
  let data: Data

  var image: UIImage? { UIImage(data: data) }

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(importedContentType: .image) { data in
      MealLibraryPhoto(data: data)
    }
  }
}
