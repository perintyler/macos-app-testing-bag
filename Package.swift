// swift-tools-version: 6.0

import PackageDescription

// Built once into .build/ rather than compiled ad-hoc per run: the prototype
// this generalizes ran `swiftc -o /tmp/barry-axprobe qa/axprobe.swift` on every
// invocation, which paid a full compile per assertion.
let package = Package(
    name: "axprobe",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "axprobe", targets: ["axprobe"])
    ],
    targets: [
        .executableTarget(
            name: "axprobe",
            path: "src/axprobe",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
