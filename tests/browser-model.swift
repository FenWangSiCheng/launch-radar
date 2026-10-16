import Foundation

@main
struct BrowserModelTests {
    static func main() throws {
        let oldTask = Data(#"{"id":"legacy","name":"Apple","url":"https://www.apple.com.cn/shop/buy-iphone","enabled":true,"demo":false,"state":"idle","message":"尚未打开"}"#.utf8)
        var task = try JSONDecoder().decode(PurchaseTask.self, from: oldTask)
        assert(task.selectedBrowser == .safari)
        assert(task.submitOrder != true, "旧任务不能自动开启下单")
        assert(task.tmall != true, "旧任务不能自动变成天猫任务")
        assert(task.tmallFlow != true, "旧任务不能自动开启天猫结账")
        assert(task.jd != true && task.jdFlow != true, "旧任务不能自动开启京东结账")
        task.browser = .chrome
        task.submitOrder = true
        let restored = try JSONDecoder().decode(PurchaseTask.self, from: JSONEncoder().encode(task))
        assert(restored.selectedBrowser == .chrome)
        assert(restored.submitOrder == true, "用户选择的下单选项应在重启后保留")
        assert(PurchaseBrowser.defaultBrowser(for: "https://secure8.store.apple.com/shop/bag") == .safari)
        for url in ["https://tmall.com", "https://apple.com.cn.attacker.test", "https://fakeapple.com", "http://apple.com", "invalid"] {
            assert(PurchaseBrowser.defaultBrowser(for: url) == .chrome)
        }
        assert(PurchaseTask(name: "Apple 演练", url: "https://example.com", demo: true, appleFlow: true).selectedBrowser == .chrome)
        let duoTask = PurchaseTask(name: "Apple · Duo", url: "https://www.apple.com.cn/shop/buy-iphone/iphone-duo/mk2p4ch/a", appleFlow: true)
        assert(duoTask.isAppleRelease, "苹果商品配置页无需绑定按钮")
        for url in ["https://www.apple.com.cn/shop/bag", "https://www.apple.com/shop/checkout", "https://example.com/shop/buy-iphone/x", "https://apple.com.cn.attacker.test/shop/buy-iphone/x", "https://www.apple.com.cn/shop/buy-iphone"] {
            assert(!PurchaseTask(name: "其他", url: url, appleFlow: true).isAppleRelease, "只有苹果商品配置页免绑定：\(url)")
        }
        assert(!PurchaseTask(name: "非苹果任务", url: "https://www.apple.com.cn/shop/buy-iphone/iphone-duo/mk2p4ch/a").isAppleRelease, "未开启苹果流程的任务不免绑定")
        let share = "【淘宝】 https://m.tb.cn/h.example?tk=abc CZ001 「Apple 商品」 点击链接直接打开"
        assert(PurchaseLink.extract(from: share) == "https://m.tb.cn/h.example?tk=abc")
        for url in ["https://detail.tmall.com/item.htm?id=123", "https://m.tb.cn/h.example", "https://e.tb.cn/h.example", "https://item.taobao.com/item.htm?id=123", "https://www.taobao.cn/example"] {
            assert(PurchaseLink.isTmallShare(url))
        }
        for url in ["https://tmall.com.attacker.test", "https://faketmall.com", "http://tmall.com", "https://apple.com.cn", "https://tmall.com@attacker.test", "invalid"] {
            assert(!PurchaseLink.isTmallShare(url))
        }
        assert(PurchaseLink.extract(from: "￥ABC123￥ 纯淘口令") == nil)
        let tmallTask = PurchaseTask(name: "天猫 Apple", url: "https://cart.taobao.com/cart.htm", tmall: true, tmallFlow: true)
        let savedTmall = try JSONDecoder().decode(PurchaseTask.self, from: JSONEncoder().encode(tmallTask))
        assert(savedTmall.tmall == true && savedTmall.selectedBrowser == .chrome)
        assert(savedTmall.tmallFlow == true)
        assert(savedTmall.appleFlow != true && savedTmall.submitOrder != true)
        for url in ["https://cart.jd.com/cart_index", "https://item.jd.com/100.html", "https://u.jd.com/example", "https://3.cn/example"] {
            assert(PurchaseLink.isJDShare(url))
        }
        for url in ["https://jd.com.attacker.test", "https://fakejd.com", "https://jd.com@attacker.test", "http://cart.jd.com/cart_index", "https://tmall.com", "invalid"] {
            assert(!PurchaseLink.isJDShare(url))
        }
        let jdTask = PurchaseTask(name: "京东", url: "https://cart.jd.com/cart_index", jd: true, jdFlow: true)
        let savedJD = try JSONDecoder().decode(PurchaseTask.self, from: JSONEncoder().encode(jdTask))
        assert(savedJD.jd == true && savedJD.jdFlow == true && savedJD.selectedBrowser == .safari)
        for url in ["https://jd.com.attacker.test", "https://fakejd.com", "http://jd.com"] {
            assert(PurchaseBrowser.defaultBrowser(for: url) == .chrome)
        }
        assert(savedJD.submitOrder != true && savedJD.appleFlow != true && savedJD.tmallFlow != true)
        let suiteName = "LaunchRadarTests.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: suiteName)!
        defer { preferences.removePersistentDomain(forName: suiteName) }
        let defaultsURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("config/default-tasks.json")
        let defaults = PurchaseTaskStore.load(preferences: preferences, defaultsURL: defaultsURL)
        assert(defaults.count == 4, "首次安装应加载四个预置页面")
        assert(defaults.filter(\.enabled).count == 1)
        assert(defaults.allSatisfy { $0.state == "idle" && $0.delayMs == nil })
        assert(defaults.filter { $0.jd != true }.allSatisfy { $0.submitOrder == true }, "保留当前下单选项")
        assert(defaults.filter { $0.jd == true }.allSatisfy { $0.enabled && $0.submitOrder == true && $0.jdFlow == true })
        preferences.set(try JSONEncoder().encode([savedJD]), forKey: "tasks")
        let migratedJD = PurchaseTaskStore.load(preferences: preferences, defaultsURL: defaultsURL)
        assert(migratedJD[0].jdFlow == true && migratedJD[0].submitOrder == true, "旧京东任务应自动启用固定结算流程")
        preferences.set(try JSONEncoder().encode([savedTmall]), forKey: "tasks")
        let local = PurchaseTaskStore.load(preferences: preferences, defaultsURL: defaultsURL)
        assert(local.count == 1 && local[0].id == savedTmall.id, "已有列表优先于预置页面")
        assert(local[0].submitOrder == true, "已开启天猫结账的任务应自动继续到立即支付")
        assert(local[0].isTmallCart, "预置购物车任务应识别为淘宝购物车")
        let legacyTmallJSON = Data(#"{"id":"legacy-tmall","name":"天猫购物车","url":"https://cart.taobao.com/cart.htm","enabled":true,"demo":false,"tmall":true,"browser":"chrome","state":"idle","message":"尚未打开"}"#.utf8)
        var legacyTmall = try JSONDecoder().decode(PurchaseTask.self, from: legacyTmallJSON)
        assert(legacyTmall.tmallFlow != true, "旧任务保存时还没有天猫结账开关值")
        preferences.set(try JSONEncoder().encode([legacyTmall]), forKey: "tasks")
        legacyTmall = PurchaseTaskStore.load(preferences: preferences, defaultsURL: defaultsURL)[0]
        assert(legacyTmall.tmallFlow == true && legacyTmall.submitOrder == true, "旧天猫任务应自动启用固定结账流程")
        assert(legacyTmall.usesTmallFlow && legacyTmall.isTmallCart, "迁移后应识别为淘宝购物车任务")
        preferences.set(Data("[]".utf8), forKey: "tasks")
        assert(PurchaseTaskStore.load(preferences: preferences, defaultsURL: defaultsURL).isEmpty, "主动删除全部页面后不应恢复默认列表")
        print("PASS: browser defaults, legacy migration, explicit selection persistence and domain boundaries")
    }
}
