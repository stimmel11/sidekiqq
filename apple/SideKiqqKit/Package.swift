// swift-tools-version:5.10
// SideKiqqKit: the shared Swift client for the SideKiqq brain (mirror of android/shared).
// Pure Swift + Foundation so the logic builds and tests on Linux too; Apple-only pieces
// (Keychain) are behind `#if canImport(Security)`.
import PackageDescription

let package = Package(
    name: "SideKiqqKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
        .watchOS(.v10),
    ],
    products: [
        .library(name: "SideKiqqKit", targets: ["SideKiqqKit"]),
    ],
    targets: [
        .target(name: "SideKiqqKit"),
        .testTarget(name: "SideKiqqKitTests", dependencies: ["SideKiqqKit"]),
    ]
)
