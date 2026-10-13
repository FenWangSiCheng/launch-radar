import Foundation
import Darwin
let child = Process()
let output = Pipe(), input = Pipe()
child.executableURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath + "/dist/Launch Radar.app/Contents/Resources/runtime/node")
child.arguments = [FileManager.default.currentDirectoryPath + "/dist/Launch Radar.app/Contents/Resources/engine/worker.mjs"]
child.standardOutput = output
child.standardInput = input
try child.run()
var bytes = [UInt8](repeating: 0, count: 8192)
let count = Darwin.read(output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
assert(count > 0)
print(String(decoding: bytes.prefix(count), as: UTF8.self))
try input.fileHandleForWriting.write(contentsOf: Data("{\"type\":\"shutdown\"}\n".utf8))
child.waitUntilExit()
assert(child.terminationStatus == 0)
