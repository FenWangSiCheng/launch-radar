import AppKit
import Foundation
import Darwin
import SwiftUI

enum PurchaseBrowser: String, Codable, CaseIterable {
    case safari, chrome
    var title: String { self == .safari ? "Safari" : "Chrome" }
    static func defaultBrowser(for url: String) -> PurchaseBrowser {
        guard let parsed = URL(string: url), parsed.scheme?.lowercased() == "https", let host = parsed.host?.lowercased() else { return .chrome }
        return ["apple.com", "apple.com.cn", "jd.com"].contains { host == $0 || host.hasSuffix("." + $0) } ? .safari : .chrome
    }
}

struct PurchaseTask: Identifiable, Codable {
    var id = UUID().uuidString
    var name: String
    var url: String
    var enabled = true
    var demo = false
    var appleFlow: Bool?
    var douyinHandoff: Bool?
    var tmall: Bool?
    var tmallFlow: Bool?
    var jd: Bool?
    var jdFlow: Bool?
    var submitOrder: Bool?
    var browser: PurchaseBrowser?
    var selectedBrowser: PurchaseBrowser { browser ?? (demo ? .chrome : PurchaseBrowser.defaultBrowser(for: url)) }
    var state = "idle"
    var message = "尚未打开"
    var delayMs: Double?
}

struct LogEntry: Identifiable {
    let id = UUID()
    let time = Date()
    let message: String
}

enum PurchaseTaskStore {
    static func load(preferences: UserDefaults, defaultsURL: URL?) -> [PurchaseTask] {
        let data: Data?
        if preferences.object(forKey: "tasks") != nil {
            data = preferences.data(forKey: "tasks")
        } else {
            data = defaultsURL.flatMap { try? Data(contentsOf: $0) }
        }
        guard let data, let saved = try? JSONDecoder().decode([PurchaseTask].self, from: data) else { return [] }
        return saved.map { task in
            var copy = task
            copy.state = "idle"; copy.message = "请重新打开并绑定按钮"; copy.delayMs = nil
            return copy
        }
    }
}

@MainActor
final class RadarModel: ObservableObject {
    @Published var tasks: [PurchaseTask] = []
    @Published var logs: [LogEntry] = []
    @Published var target = Date(timeIntervalSince1970: ceil(Date().timeIntervalSince1970 + 120))
    @Published var running = false
    @Published var waiting = false
    @Published var hasScheduledTime = false
    @Published var connected = false
    @Published var error: String?
    @Published var mobileReminder: String?
    @Published var paymentReminder: String?
    @Published var phase = "准备好页面后，设置时间或立即运行"
    private var process: Process?
    private var input: FileHandle?
    private var pipes: [Pipe] = []
    private var sleepGuard: Process?
    private var pending = Data()
    private let preferences = UserDefaults.standard

    init() {
        tasks = PurchaseTaskStore.load(preferences: preferences, defaultsURL: Bundle.main.url(forResource: "default-tasks", withExtension: "json"))
        persist()
        startWorker()
    }

    func persist() {
        if let data = try? JSONEncoder().encode(tasks) { preferences.set(data, forKey: "tasks") }
    }

    func startWorker() {
        let resources = Bundle.main.resourceURL!
        let bundledWorker = resources.appendingPathComponent("engine/worker.mjs")
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let worker = FileManager.default.fileExists(atPath: bundledWorker.path) ? bundledWorker : root.appendingPathComponent("engine/worker.mjs")
        let bundledNode = resources.appendingPathComponent("runtime/node")
        let executable = FileManager.default.fileExists(atPath: bundledNode.path) ? bundledNode : URL(fileURLWithPath: "/usr/bin/env")
        let workerProcess = Process()
        workerProcess.executableURL = executable
        workerProcess.arguments = executable == bundledNode ? [worker.path] : ["node", worker.path]
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        pipes = [stdin, stdout, stderr]
        workerProcess.standardInput = stdin
        workerProcess.standardOutput = stdout
        workerProcess.standardError = stderr
        workerProcess.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.appendLog("执行服务已退出")
                self.connected = false
                self.running = false
                self.waiting = false
                self.releaseSleepGuard()
                self.phase = "执行服务已退出，请重新启动应用"
            }
        }
        do {
            try workerProcess.run()
            process = workerProcess
            input = stdin.fileHandleForWriting
            appendLog("本地执行服务启动中")
        let outputHandle = stdout.fileHandleForReading
        let errorHandle = stderr.fileHandleForReading
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var buffer = [UInt8](repeating: 0, count: 8192)
            while true {
                let count = Darwin.read(outputHandle.fileDescriptor, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                let data = Data(buffer.prefix(count))
                DispatchQueue.main.async { self?.consume(data) }
            }
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var buffer = [UInt8](repeating: 0, count: 8192)
            while true {
                let count = Darwin.read(errorHandle.fileDescriptor, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                let text = String(decoding: buffer.prefix(count), as: UTF8.self)
                DispatchQueue.main.async { self?.appendLog(text.trimmingCharacters(in: .whitespacesAndNewlines)) }
            }
        }

        } catch {
            self.error = "执行服务无法启动：\(error.localizedDescription)"
        }
    }

    private func consume(_ data: Data) {
        pending.append(data)
        while let newline = pending.firstIndex(of: 10) {
            let line = pending.prefix(upTo: newline)
            pending.removeSubrange(...newline)
            guard let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            receive(event)
        }
    }

    private func receive(_ event: [String: Any]) {
        let type = event["type"] as? String ?? ""
        let message = event["message"] as? String ?? ""
        switch type {
        case "started": connected = true; appendLog("本地执行服务已连接")
        case "diagnostic": appendLog(message)
        case "status":
            guard let id = event["id"] as? String, let index = tasks.firstIndex(where: { $0.id == id }) else { return }
            tasks[index].state = event["state"] as? String ?? "idle"
            tasks[index].message = message
            if let delay = event["delayMs"] as? Double { tasks[index].delayMs = delay }
            if tasks[index].state == "mobileReminder" {
                NSSound.beep()
                mobileReminder = message
            }
            if tasks[index].state == "paymentReady" || (tasks[index].jd == true && tasks[index].state == "reviewOrder") {
                NSSound.beep()
                paymentReminder = "\(tasks[index].name)：\(message)"
            }
            appendLog("\(tasks[index].name)：\(message)")
        case "armed":
            waiting = event["immediate"] as? Bool != true
            phase = waiting ? "已设置 · 到点自动运行" : "正在运行…"
        case "triggered":
            waiting = false
            phase = "正在运行…"
        case "finished":
            running = false
            waiting = false
            releaseSleepGuard()
            phase = "本轮已结束 · 请查看页面进度或手机购买提醒"
        case "cancelled": phase = message; appendLog(message)
        case "error":
            error = message
            appendLog(message)
            if let id = event["id"] as? String, let index = tasks.firstIndex(where: { $0.id == id }) {
                tasks[index].state = "failed"; tasks[index].message = message
            }
        default: break
        }
    }

    func send(_ command: [String: Any]) {
        guard connected, let input else { error = "执行服务尚未就绪"; return }
        do {
            var data = try JSONSerialization.data(withJSONObject: command)
            data.append(10)
            try input.write(contentsOf: data)
        } catch { self.error = "发送操作失败：\(error.localizedDescription)" }
    }

    func add(name: String, url: String, demo: Bool = false, browser: PurchaseBrowser? = nil, douyinHandoff: Bool = false, tmall: Bool = false, jd: Bool = false) {
        let host = URL(string: url)?.host?.lowercased() ?? ""
        let apple = ["apple.com", "apple.com.cn"].contains { host == $0 || host.hasSuffix("." + $0) }
        tasks.append(PurchaseTask(name: name, url: url, demo: demo, appleFlow: apple && !douyinHandoff && !tmall && !jd, douyinHandoff: douyinHandoff, tmall: tmall, tmallFlow: tmall, jd: jd, jdFlow: jd, browser: douyinHandoff || tmall ? .chrome : browser ?? (jd ? .safari : nil)))
        if douyinHandoff { tasks[tasks.count - 1].message = "在手机抖音中准备商品、规格和地址；电脑到点提醒" }
        if jd { tasks[tasks.count - 1].message = "打开京东购物车，登录、整理本次要购买的商品并核对规格，再绑定全选" }
        if tmall { tasks[tasks.count - 1].message = "打开商品并核对旗舰店，登录、选好规格，再绑定购买按钮" }
        persist()
    }

    func addDemo() {
        guard !running else { return }
        for name in ["Apple 演练", "通用演练", "天猫演练"] {
            add(name: name, url: "https://example.com", demo: true)
            if name == "Apple 演练" { tasks[tasks.count - 1].appleFlow = true }
        }
        persist()
    }

    func open(_ task: PurchaseTask) {
        guard !running else { return }
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index].state = "opening"; tasks[index].message = "正在打开浏览器…"; tasks[index].delayMs = nil
        }
        send(["type": "open", "id": task.id, "url": task.url, "name": task.name, "demo": task.demo, "appleFlow": task.appleFlow ?? false, "tmallFlow": task.tmallFlow ?? false, "jdFlow": task.jdFlow ?? false, "douyinHandoff": task.douyinHandoff ?? false, "submitOrder": task.submitOrder ?? false, "browser": task.selectedBrowser.rawValue])
    }

    func changeBrowser(_ id: String, to browser: PurchaseBrowser) {
        guard !running, let index = tasks.firstIndex(where: { $0.id == id }), tasks[index].state != "opening" else { return }
        guard tasks[index].selectedBrowser != browser else { return }
        send(["type": "remove", "id": id])
        tasks[index].browser = browser
        tasks[index].state = "idle"
        tasks[index].message = "浏览器已切换，请重新打开并绑定按钮"
        tasks[index].delayMs = nil
        persist()
    }

    func remove(_ task: PurchaseTask) {
        guard !running else { return }
        send(["type": "remove", "id": task.id])
        tasks.removeAll { $0.id == task.id }
        persist()
    }

    var canArm: Bool {
        connected && !running && !tasks.filter(\.enabled).isEmpty && tasks.filter(\.enabled).allSatisfy { $0.douyinHandoff == true || ["bound", "ready"].contains($0.state) }
    }

    func schedule(at date: Date) {
        guard canArm else { return }
        let date = Date(timeIntervalSince1970: floor(date.timeIntervalSince1970))
        guard date.timeIntervalSinceNow >= 1 else { error = "请设置至少一秒后的运行时间"; return }
        target = date
        hasScheduledTime = true
        start(type: "arm")
    }

    var canRunNow: Bool { canArm || (connected && waiting) }

    func runNow() {
        guard canRunNow else { return }
        if waiting {
            waiting = false
            phase = "正在运行…"
            send(["type": "runNow"])
        } else {
            hasScheduledTime = false
            start(type: "runNow")
        }
    }

    private func start(type: String) {
        running = true
        waiting = false
        phase = "正在检查各页面…"
        preventSleep()
        let selected = tasks.filter(\.enabled)
        send(["type": type, "ids": selected.map(\.id), "douyinReminders": selected.filter { $0.douyinHandoff == true }.map { ["id": $0.id, "url": $0.url] }, "appleFlows": Dictionary(uniqueKeysWithValues: selected.map { ($0.id, $0.appleFlow ?? false) }), "tmallFlows": Dictionary(uniqueKeysWithValues: selected.map { ($0.id, $0.tmallFlow ?? false) }), "jdFlows": Dictionary(uniqueKeysWithValues: selected.map { ($0.id, $0.jdFlow ?? false) }), "submitOrders": Dictionary(uniqueKeysWithValues: selected.map { ($0.id, $0.submitOrder ?? false) }), "target": target.timeIntervalSince1970 * 1000])
    }

    func resume(_ task: PurchaseTask) {
        guard connected, !running, (task.appleFlow == true || task.tmallFlow == true || task.jdFlow == true), ["handoff", "uncertain"].contains(task.state) else { return }
        running = true
        phase = "正在核查页面并继续结账"
        preventSleep()
        send(["type": "resume", "id": task.id, "submitOrder": task.submitOrder ?? false])
    }

    private func preventSleep() {
        let guardProcess = Process()
        guardProcess.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
        guardProcess.arguments = ["-i", "-s"]
        do { try guardProcess.run(); sleepGuard = guardProcess }
        catch { appendLog("无法阻止休眠，请保持 Mac 唤醒") }
    }

    func stop() { waiting = false; send(["type": "cancel"]) }

    private func releaseSleepGuard() {
        if sleepGuard?.isRunning == true { sleepGuard?.terminate() }
        sleepGuard = nil
    }

    private func appendLog(_ message: String) {
        guard !message.isEmpty else { return }
        logs.append(LogEntry(message: message))
        if logs.count > 200 { logs.removeFirst(logs.count - 200) }
    }

    func shutdown() {
        persist()
        releaseSleepGuard()
        if connected { send(["type": "shutdown"]) }
        try? input?.close()
    }
}


enum PurchaseLink {
    static func extract(from text: String) -> String? {
        guard let expression = try? NSRegularExpression(pattern: "https?://[^\\s<>\"，。]+", options: .caseInsensitive),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range, in: text) else { return nil }
        let value = String(text[range]).trimmingCharacters(in: CharacterSet(charactersIn: ",;!)]}）】"))
        guard let parsed = URL(string: value), let host = parsed.host, !host.isEmpty else { return nil }
        return value
    }
    static func isDouyin(_ text: String) -> Bool {
        guard let parsed = URL(string: text), parsed.scheme?.lowercased() == "https", let host = parsed.host?.lowercased() else { return false }
        return ["douyin.com", "jinritemai.com"].contains { host == $0 || host.hasSuffix("." + $0) }
    }
    static func isJDShare(_ text: String) -> Bool {
        guard let parsed = URL(string: text), parsed.scheme?.lowercased() == "https", let host = parsed.host?.lowercased() else { return false }
        return ["jd.com", "3.cn"].contains { host == $0 || host.hasSuffix("." + $0) }
    }
    static func isTmallShare(_ text: String) -> Bool {
        guard let parsed = URL(string: text), parsed.scheme?.lowercased() == "https", let host = parsed.host?.lowercased() else { return false }
        return ["tmall.com", "taobao.com", "tb.cn", "taobao.cn"].contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

enum PurchaseEntry: String, CaseIterable, Identifiable {
    case browser, tmall, jd, douyin
    var id: String { rawValue }
    var title: String {
        switch self {
        case .browser: return "浏览器购买"
        case .tmall: return "天猫苹果旗舰店"
        case .jd: return "京东购物车"
        case .douyin: return "抖音苹果旗舰店 · 手机接力"
        }
    }
}
