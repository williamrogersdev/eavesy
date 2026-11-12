// swift-tools-version: 5.10

import PackageDescription

// The phone app's sync core: the API client, the offline outbox and the upload
// engine. No UIKit, so `swift test` runs it on a Mac (and in CI).
let package = Package(
    name: "EavesyKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "EavesyKit", targets: ["EavesyKit"])],
    targets: [
        .target(name: "EavesyKit", path: "Sources/EavesyKit"),
        .testTarget(name: "EavesyKitTests", dependencies: ["EavesyKit"], path: "Tests/EavesyKitTests"),
    ]
)
