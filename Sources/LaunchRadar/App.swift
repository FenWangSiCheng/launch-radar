import SwiftUI
import AppKit
import CoreImage.CIFilterBuiltins

@main
struct LaunchRadarApp: App {
    @StateObject private var model = RadarModel()
    var body: some Scene {
        WindowGroup("Launch Radar") {
            Dashboard(model: model)
                .frame(minWidth: 900, minHeight: 680)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in model.shutdown() }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1040, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("抢购") {
                Button("停止倒计时") { model.stop() }.keyboardShortcut(".", modifiers: .command).disabled(!model.running)
            }
        }
    }
}

private enum Design {
    static let accent = Color(red: 0.78, green: 0.36, blue: 0.20)
    static let spacing: CGFloat = 24
}

struct Dashboard: View {
    @ObservedObject var model: RadarModel
    @State private var purchaseEntry: PurchaseEntry?
    @State private var showLog = false
    @State private var settingTime = false
    @State private var scheduledTime = Date()
    var body: some View {
        VStack(alignment: .leading, spacing: Design.spacing) {
            header
            countdown
            HStack {
                Text("购买页面").font(.title3.weight(.semibold))
                Text("\(model.tasks.filter(\.enabled).count) 个参与任务").foregroundStyle(.secondary)
                Spacer()
                Button("天猫苹果旗舰店", systemImage: "bag") { purchaseEntry = .tmall }
                Button("京东购物车", systemImage: "cart") { purchaseEntry = .jd }
                Button("抖音苹果旗舰店", systemImage: "iphone") { purchaseEntry = .douyin }
                Button("添加页面", systemImage: "plus") { purchaseEntry = .browser }
            }.disabled(model.running)
            taskList
            footer
        }
        .padding(32)
        .background(.background)
        .tint(Design.accent)
        .sheet(item: $purchaseEntry) { AddTaskSheet(model: model, initialEntry: $0) }
        .sheet(isPresented: $showLog) { logSheet }
        .sheet(isPresented: $settingTime) { scheduleSheet }
        .alert("抖音购买时间已到", isPresented: Binding(get: { model.mobileReminder != nil }, set: { if !$0 { model.mobileReminder = nil } })) {
            Button("知道了") { model.mobileReminder = nil }
        } message: { Text(model.mobileReminder ?? "") }
        .alert("请本人完成付款", isPresented: Binding(get: { model.paymentReminder != nil }, set: { if !$0 { model.paymentReminder = nil } })) {
            Button("知道了") { model.paymentReminder = nil }
        } message: { Text(model.paymentReminder ?? "") }
        .alert("操作未完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了") { model.error = nil }
        } message: { Text(model.error ?? "") }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            Image(systemName: "scope").font(.system(size: 32, weight: .light)).foregroundStyle(Design.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text("Launch Radar").font(.system(size: 28, weight: .semibold, design: .rounded))
                Text("准备在前，提交在同一刻。").foregroundStyle(.secondary)
            }
            Spacer()
            Label(model.connected ? "本地服务就绪" : "正在连接", systemImage: model.connected ? "checkmark.circle" : "clock")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var countdown: some View {
        HStack(alignment: .center, spacing: 32) {
            VStack(alignment: .leading, spacing: 8) {
                Text(model.waiting ? "距离自动运行" : "定时运行").font(.caption).foregroundStyle(.secondary)
                TimelineView(.periodic(from: .now, by: 0.25)) { context in
                    Text(clockText(at: context.date))
                        .font(.system(size: 40, weight: .light, design: .monospaced))
                        .monospacedDigit()
                        .accessibilityLabel("倒计时 \(clockText(at: context.date))")
                }
                if model.hasScheduledTime {
                    Text(model.target, format: .dateTime.month().day().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(model.phase).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 16) {
                HStack(spacing: 12) {
                    Button("设置时间", systemImage: "clock") {
                        let nextTime = max(model.target, Date().addingTimeInterval(120))
                        scheduledTime = Date(timeIntervalSince1970: ceil(nextTime.timeIntervalSince1970 / 60) * 60)
                        settingTime = true
                    }.disabled(!model.canArm)
                    Button("立即运行", systemImage: "play.fill") { model.runNow() }
                        .buttonStyle(.borderedProminent).controlSize(.large).disabled(!model.canRunNow)
                }
                if model.running {
                    Button(model.waiting ? "取消定时" : "停止", systemImage: "stop.fill") { model.stop() }
                        .keyboardShortcut(".", modifiers: .command)
                } else {
                    Text("保存时间后自动运行，也可手动立即触发")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(24)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
    }

    private func clockText(at date: Date) -> String {
        guard model.waiting else { return model.running ? "运行中" : "待运行" }
        let interval = max(0, model.target.timeIntervalSince(date))
        let milliseconds = Int(interval * 1000)
        return String(format: "%02d:%02d:%02d", milliseconds / 3_600_000, (milliseconds / 60_000) % 60, (milliseconds / 1000) % 60)
    }

    private var scheduleSheet: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("设置运行时间").font(.title2.weight(.semibold))
            Text("保存后开始等待，到点自动运行所有参与任务。")
                .foregroundStyle(.secondary)
            DatePicker("运行时间", selection: $scheduledTime, displayedComponents: [.date, .hourAndMinute])
            HStack {
                Spacer()
                Button("取消") { settingTime = false }.keyboardShortcut(.cancelAction)
                Button("保存时间") {
                    model.schedule(at: scheduledTime)
                    settingTime = false
                }.buttonStyle(.borderedProminent).disabled(!model.canArm || scheduledTime.timeIntervalSinceNow < 1)
            }
        }.padding(32).frame(width: 460).tint(Design.accent)
    }

    private var taskList: some View {
        ScrollView {
            if model.tasks.isEmpty {
                ContentUnavailableView {
                    Label("先准备你的购买页面", systemImage: "safari")
                } description: {
                    Text("添加商品链接，在浏览器里填好信息，再选定要定时点击的按钮。")
                } actions: {
                    Button("添加页面") { purchaseEntry = .browser }
                }.padding(.vertical, 32)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach($model.tasks) { $task in
                        TaskRow(task: $task, model: model)
                        Divider()
                    }
                }
            }
        }
    }

    private var footer: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: "hand.raised").foregroundStyle(.secondary)
            Text("苹果任务到点等待开售，再自动进入结账并选择支付宝。开启立即下单后会创建订单；支付宝付款由你完成。请提前准备规格和地址，登录或验证码需要你处理。")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button("执行记录", systemImage: "list.bullet.rectangle") { showLog = true }
        }
    }

    private var logSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("执行记录").font(.title2); Spacer(); Button("完成") { showLog = false } }
            Text("延迟表示本机发出点击操作相对目标时间的差值，不代表服务器接收时间。")
                .font(.caption).foregroundStyle(.secondary)
            List(model.logs) { entry in
                HStack(alignment: .top) {
                    Text(entry.time, format: .dateTime.hour().minute().second()).monospacedDigit().foregroundStyle(.secondary)
                    Text(entry.message).textSelection(.enabled)
                }
            }
        }.padding(24).frame(width: 760, height: 480)
    }
}

struct TaskRow: View {
    @Binding var task: PurchaseTask
    @ObservedObject var model: RadarModel
    @State private var showingMobile = false
    private var busy: Bool { model.running || task.state == "opening" }
    var body: some View {
        HStack(spacing: 16) {
            Toggle("参与 \(task.name)", isOn: $task.enabled).labelsHidden().toggleStyle(.checkbox)
                .disabled(model.running).onChange(of: task.enabled) { _, _ in model.persist() }
            Image(systemName: task.douyinHandoff == true ? "iphone" : task.demo ? "flask" : "globe").font(.title2).foregroundStyle(.secondary).frame(width: 32)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(task.name).font(.headline)
                    if task.demo { Text("演练").font(.caption).foregroundStyle(Design.accent) }
                    if let delay = task.delayMs { Text(String(format: "+%.0f ms", delay)).font(.caption.monospaced()).foregroundStyle(.secondary) }
                }
                Text(task.message).font(.caption).foregroundStyle(statusColor).lineLimit(2)
                if !task.demo { Text(task.url).font(.caption2).foregroundStyle(.tertiary).lineLimit(1) }
                if task.douyinHandoff == true {
                    Text("手机接力 · 到点提醒 · 下单和订单在抖音 App 中处理").font(.caption).foregroundStyle(.secondary)
                } else {
                if task.jd == true {
                    Text(task.isJDCart ? "京东购物车 · 到点刷新并全选，然后去结算 → 立即支付；付款由你完成" : "京东 · 去结算 → 立即支付；付款由你完成")
                        .font(.caption).foregroundStyle(.secondary)
                } else if task.tmall == true {
                    Text(task.isTmallCart ? "淘宝购物车 · 到点刷新并尝试全选，然后去结算 → 立即支付；付款由你完成" : "天猫 · 去结算 → 立即支付；付款由你完成")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("自动继续天猫结账（Chrome）", isOn: Binding(
                        get: { task.tmallFlow ?? false },
                        set: { task.tmallFlow = $0; model.persist() }
                    )).toggleStyle(.checkbox).font(.caption).disabled(busy)
                }
                Picker("浏览器", selection: Binding(
                    get: { task.selectedBrowser },
                    set: { model.changeBrowser(task.id, to: $0) }
                )) {
                    ForEach(PurchaseBrowser.allCases, id: \.self) { browser in
                        Text(browser.title).tag(browser)
                    }
                }.pickerStyle(.menu).frame(width: 190).disabled(busy || !model.connected)
                if supportsAppleFlow {
                    Toggle("自动继续苹果结账（选择支付宝）", isOn: Binding(
                        get: { task.appleFlow ?? false },
                        set: { task.appleFlow = $0; model.persist() }
                    )).toggleStyle(.checkbox).font(.caption).disabled(busy || task.demo)
                    if task.appleFlow == true {
                        Toggle("自动点击立即下单（会创建真实订单）", isOn: Binding(
                            get: { task.submitOrder ?? false },
                            set: { task.submitOrder = $0; model.persist() }
                        )).toggleStyle(.checkbox).font(.caption).disabled(busy)
                    }
                }
                }
            }
            Spacer(minLength: 8)
            HStack(spacing: 8) {
                if (task.appleFlow == true || task.tmallFlow == true || task.jdFlow == true) && ["handoff", "uncertain", "reviewOrder"].contains(task.state) {
                    Button("继续结账") { model.resume(task) }.disabled(busy || !model.connected)
                        .help(task.jd == true || task.tmall == true ? "处理页面提示后核查并继续；去结算和立即支付异常分别最多重试 1 分钟，继续不会重新计时" : "处理页面提示后核查并继续；下单弹框最多额外重试 10 次")
                }
                if task.douyinHandoff == true {
                    Button("手机购买", systemImage: "qrcode") { showingMobile = true }
                } else {
                Button("打开") { model.open(task) }.disabled(busy || !model.connected)
                if !task.isTmallCart && !task.isJDCart {
                    Button("选按钮") { model.send(["type": "pick", "id": task.id]) }
                        .disabled(busy || ["idle", "closed", "opening"].contains(task.state) || !model.connected)
                }
                Button { model.send(["type": "focus", "id": task.id]) } label: { Image(systemName: "arrow.up.forward.app") }
                    .help("查看浏览器页面").accessibilityLabel("查看 \(task.name)").disabled(task.state == "idle")
                }
                Button(role: .destructive) { model.remove(task) } label: { Image(systemName: "trash") }
                    .help("移除任务").accessibilityLabel("移除 \(task.name)").disabled(busy)
            }.buttonStyle(.bordered)
        }.padding(.vertical, 16)
            .sheet(isPresented: $showingMobile) { DouyinPurchaseSheet(task: task) }
    }
    private var supportsAppleFlow: Bool {
        if task.demo { return task.name == "Apple 演练" }
        let host = URL(string: task.url)?.host?.lowercased() ?? ""
        return ["apple.com", "apple.com.cn"].contains { host == $0 || host.hasSuffix("." + $0) }
    }
    private var statusColor: Color {
        switch task.state {
        case "bound", "ready", "demoSuccess", "reviewOrder", "orderSubmitted", "paymentReady": return .green
        case "failed", "uncertain", "stale", "closed", "handoff", "mobileReminder": return .orange
        default: return .secondary
        }
    }
}

struct AddTaskSheet: View {
    @ObservedObject var model: RadarModel
    @Environment(\.dismiss) var dismiss
    @State private var name = ""
    @State private var url = ""
    @State private var browser: PurchaseBrowser?
    var initialEntry: PurchaseEntry = .browser
    @State private var entry: PurchaseEntry = .browser
    private var douyin: Bool { entry == .douyin }
    private var tmall: Bool { entry == .tmall }
    private var jd: Bool { entry == .jd }
    private var purchaseURL: String? { PurchaseLink.extract(from: url) }
    private var valid: Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let parsed = purchaseURL else { return false }
        if douyin { return PurchaseLink.isDouyin(parsed) }
        if tmall { return PurchaseLink.isTmallShare(parsed) }
        if jd { return PurchaseLink.isJDShare(parsed) }
        return true
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("添加购买页面").font(.title2.weight(.semibold))
            Text(douyin ? "保存商品分享链接，电脑到点提醒，手机抖音 App 完成购买。" : jd ? "京东购物车无需绑定按钮：到点刷新、尝试全选并结算。" : tmall ? "使用淘宝购物车可免绑定按钮：到点刷新、尝试全选并结算，随后点击「立即支付」。" : "人工准备信息后，工具按统一时间点击你选定的按钮。")
                .foregroundStyle(.secondary)
            Form {
                Picker("购买方式", selection: $entry) {
                    ForEach(PurchaseEntry.allCases, id: \.self) { option in
                        Text(option.title).tag(option)
                    }
                }
                TextField("页面名称", text: $name, prompt: Text(jd ? "例如：京东 · 黑色 256GB" : "例如：天猫 · 黑色 256GB"))
                TextField(douyin || tmall || jd ? "商品分享链接" : "商品链接", text: $url, prompt: Text(douyin ? "粘贴抖音复制的完整分享文字" : jd ? "粘贴京东链接或完整分享文字，需包含 https 链接" : tmall ? "粘贴天猫/淘宝完整分享文字，需包含 https 链接" : "https://…"))
                if tmall {
                    Button("使用淘宝购物车") { url = "https://cart.taobao.com/cart.htm"; browser = .chrome }
                }
                if jd {
                    Button("使用京东购物车") { url = "https://cart.jd.com/cart_index"; browser = .safari }
                }
                if !douyin {
                Picker("浏览器", selection: Binding(
                    get: { browser ?? PurchaseBrowser.defaultBrowser(for: purchaseURL ?? url) },
                    set: { browser = $0 }
                )) {
                    ForEach(PurchaseBrowser.allCases, id: \.self) { browser in
                        Text(browser.title).tag(browser)
                    }
                }

                }
            }.textFieldStyle(.roundedBorder)
            Text(douyin ? "请在抖音 App 核对店名为 Apple Store 官方旗舰店，提前选好规格和地址。此任务无需绑定网页按钮；购物车、订单和付款在手机中处理。" : jd ? "京东购物车任务无需绑定按钮。到点刷新、全选，点击「去结算」，再点击「立即支付」；后续付款由你本人完成。登录、验证码、购物车加载失败或操作频繁时会停止。" : tmall ? "淘宝购物车任务无需绑定按钮。到点刷新、全选，点击「结算」，再点击结算页显示金额的「立即支付」；金额随商品变化，后续付款由你本人完成。登录、验证码、缺货、必填信息缺失或操作频繁时会停止。" : "苹果官网默认使用 Safari，其他网站默认 Chrome。Safari 首次使用需允许来自 Apple 事件的 JavaScript。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("添加") {
                    model.add(name: name.trimmingCharacters(in: .whitespacesAndNewlines), url: purchaseURL!, browser: browser, douyinHandoff: douyin, tmall: tmall, jd: jd)
                    dismiss()
                }.buttonStyle(.borderedProminent).disabled(!valid).keyboardShortcut(.defaultAction)
            }
        }.padding(32).frame(width: 520).tint(Design.accent)
            .onAppear { entry = initialEntry; if entry == .jd { url = "https://cart.jd.com/cart_index" }; updateDefaultName() }
            .onChange(of: entry) { _, _ in browser = nil; updateDefaultName() }
    }
    private func updateDefaultName() {
        guard name.isEmpty || ["天猫 · Apple 旗舰店", "抖音 · Apple Store 官方旗舰店", "京东 · 购物车"].contains(name) else { return }
        name = jd ? "京东 · 购物车" : tmall ? "天猫 · Apple 旗舰店" : douyin ? "抖音 · Apple Store 官方旗舰店" : ""
    }
}


struct DouyinPurchaseSheet: View {
    let task: PurchaseTask
    @Environment(\.dismiss) var dismiss
    @State private var copied = false
    private var qrImage: NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(task.url.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("抖音苹果旗舰店 · 手机购买").font(.title2.weight(.semibold))
            Text(task.name).foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 24) {
                if let qrImage {
                    Image(nsImage: qrImage).interpolation(.none).resizable()
                        .scaledToFit().frame(width: 176, height: 176).padding(12).background(.white)
                        .accessibilityLabel("商品分享链接二维码")
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("1. 用手机扫码打开商品，或复制链接到抖音 App。")
                    Text("2. 核对 Apple Store 官方旗舰店、型号、颜色、容量和地址。")
                    Text("3. 回到电脑设置时间；到点响铃后，在手机核对金额、下单并付款。")
                }.font(.callout)
            }
            Text("购物车和订单请在抖音 App 中查看。电脑不会自动操作手机；提醒需要本应用保持运行、Mac 保持唤醒。")
                .font(.caption).foregroundStyle(.secondary)
            Text(task.url).font(.caption).textSelection(.enabled).lineLimit(3)
            HStack {
                Button(copied ? "已复制链接" : "复制商品链接") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(task.url, forType: .string)
                    copied = true
                }
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }.padding(32).frame(width: 620).tint(Design.accent)
    }
}
