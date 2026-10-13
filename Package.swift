// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "LaunchRadar", platforms: [.macOS(.v14)], products: [.executable(name: "LaunchRadar", targets: ["LaunchRadar"])], targets: [.executableTarget(name: "LaunchRadar")], swiftLanguageModes: [.v5])
