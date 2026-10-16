import Foundation

let output = URL(fileURLWithPath: "config/default-tasks.json")
guard let saved = UserDefaults(suiteName: "local.launchradar.app")?.data(forKey: "tasks") else {
    print("未找到本机任务，沿用 config/default-tasks.json")
    exit(0)
}

guard var tasks = (try? JSONSerialization.jsonObject(with: saved)) as? [[String: Any]],
      tasks.allSatisfy({ $0["id"] is String && $0["name"] is String && $0["url"] is String }) else {
    fputs("本机任务数据无效，打包已停止。\n", stderr)
    exit(1)
}

for index in tasks.indices {
    tasks[index]["state"] = "idle"
    tasks[index]["message"] = "请重新打开并绑定按钮"
    tasks[index].removeValue(forKey: "delayMs")
}

do {
    let data = try JSONSerialization.data(withJSONObject: tasks, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    try data.write(to: output, options: .atomic)
    print("已将本机 \(tasks.count) 条任务写入安装包预置列表")
} catch {
    fputs("写入安装包预置列表失败：\(error)\n", stderr)
    exit(1)
}
