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
        print("PASS: browser defaults, legacy migration, explicit selection persistence and domain boundaries")
    }
}
