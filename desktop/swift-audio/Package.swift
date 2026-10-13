// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "SwiftAudio",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "SwiftAudio", targets: ["SwiftAudio"])
    ],
    targets: [
        .executableTarget(
            name: "SwiftAudio",
            path: "Sources/SwiftAudio",
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "SwiftAudio-Info.plist",
                ])
            ]
        ),
        .testTarget(
            name: "SwiftAudioTests",
            dependencies: ["SwiftAudio"],
            path: "Tests/SwiftAudioTests"
        ),
    ]
)
