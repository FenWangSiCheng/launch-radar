import assert from 'node:assert/strict';
import { checkJDAction, continueJDCheckout, isJDURL, resolveJDButton } from '../engine/jd-flow.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'engine/browsers';
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const cart = 'https://cart.jd.com/cart_index';
const confirm = 'https://trade.jd.com/shopping/order/getOrderInfo.action';
const order = '<p>应付总额：￥12,999.00</p>';
const follow = (page, extra = {}, run = { cancelled: false }) => continueJDCheckout(page, run, () => {}, { timeoutMs: 400, pollMs: 10, ...extra });
let checks = 0;
async function fixture(url, html, test) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(url);
  try { await test(page); checks++; } finally { await page.close(); }
}
try {
  assert.ok(isJDURL(cart));
  for (const url of ['http://cart.jd.com/cart_index', 'https://jd.com.attacker.test', 'https://fakejd.com', 'https://jd.com@attacker.test', 'invalid']) assert.ok(!isJDURL(url));
  checks++;
  // Match the live cart's div and nested count. Unselected unavailable items
  // and unrelated recommendation prices do not affect button recognition.
  await fixture(cart, '<p>限时预约</p><p>合计:￥12,999.00</p><p>商品总额:￥12,999.00</p><div class="_submitBtn_5cd11_1">去结算 &nbsp;<span id="count">(1)</span></div>', async page => {
    const button = await resolveJDButton(await page.$('#count'));
    assert.equal(await button.getAttribute('class'), '_submitBtn_5cd11_1');
    assert.equal(await checkJDAction(page, button), 'cart');
  });
  for (const route of ['cart.action', 'cart.html', 'cart_index/']) {
    await fixture(`https://cart.jd.com/${route}`, '<p>总价（不含运费）：￥12999.00</p><button>去结算（1）</button>', async page => {
      assert.equal(await checkJDAction(page, page.locator('button')), 'cart');
    });
  }
  for (const amount of ['0', '']) {
    await fixture(cart, `<p>合计:￥${amount}</p><div id="next">去结算 (0)</div>`, async page => {
      assert.equal(await checkJDAction(page, page.locator('#next')), 'cart');
    });
  }
  // The existing submission checkbox also opts into JD integrated payment.
  // Preserve the selected method and prevent another click on resume.
  for (const submitOrder of [false, true]) {
    await fixture(confirm + '?cartSplitPage=1', '<p>升级公告：结算页支付功能升级，提供多种支付工具，如需使用原收银台完成支付，可选择【更多支付】进入。</p><span>商品结算</span><em>付款详情</em><em>商品总额</em><div>￥12999.00</div><input id="method" type="checkbox" checked><div class="payment-action-submit"><button onclick="window.paid=(window.paid||0)+1;document.body.insertAdjacentHTML(\'beforeend\',\'<h1>京东收银台</h1>\')">立即支付</button></div>', async page => {
      const progress = {};
      if (submitOrder) assert.equal(await checkJDAction(page, page.locator('button'), { submitOrder }), 'pay');
      else await assert.rejects(checkJDAction(page, page.locator('button')), /开启自动提交/);
      const result = await follow(page, { submitOrder, progress });
      assert.equal(result.state, submitOrder ? 'paymentReady' : 'reviewOrder');
      assert.equal(await page.evaluate(() => window.paid || 0), submitOrder ? 1 : 0);
      if (submitOrder) {
        assert.equal((await follow(page, { submitOrder, progress })).state, 'paymentReady');
        assert.equal(await page.evaluate(() => window.paid), 1);
      }
      assert.equal(await page.locator('#method').isChecked(), true);
    });
  }
  await fixture(confirm, `${order}<button onclick="window.submissions=(window.submissions||0)+1">提交订单</button>`, async page => {
    assert.equal((await follow(page)).state, 'reviewOrder');
    await assert.rejects(checkJDAction(page, page.locator('button')), /开启自动提交/);
    assert.equal(await page.evaluate(() => window.submissions), undefined);
  });
  await fixture(confirm, `${order}<button id="submit"><span>提交订单</span></button><script>
    window.submissions=0;window.payments=0;submit.onclick=()=>{window.submissions++;document.body.innerHTML='<h1>京东收银台</h1><button onclick="window.payments++">立即支付</button>';};
    </script>`, async page => {
    const progress = {};
    assert.equal((await follow(page, { submitOrder: true, progress })).state, 'paymentReady');
    assert.equal((await follow(page, { submitOrder: true, progress })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.submissions), 1);
    assert.equal(await page.evaluate(() => window.payments), 0);
  });
  await fixture(confirm, `${order}<button onclick="window.submissions=(window.submissions||0)+1">提交订单</button>`, async page => {
    const progress = {};
    assert.equal((await follow(page, { submitOrder: true, progress })).state, 'uncertain');
    assert.equal((await follow(page, { submitOrder: true, progress })).state, 'uncertain');
    assert.equal(await page.evaluate(() => window.submissions), 1);
  });
  await fixture(confirm, `${order}<button id="submit">提交订单</button><script>submit.onclick=()=>document.body.innerHTML='<h1>订单提交成功</h1>';</script>`, async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'orderSubmitted');
  });
  await fixture(confirm, `${order}<button id="submit">提交订单</button><script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;if(window.clicks<3)document.body.insertAdjacentHTML('beforeend','<div class="ui-dialog">繁忙<button class="ui-dialog-close" onclick="this.parentElement.remove()">关闭</button></div>');else document.body.innerHTML='<h1>京东收银台</h1>';};
    </script>`, async page => {
    const progress = {};
    assert.equal((await follow(page, { submitOrder: true, progress, timeoutMs: 1500 })).state, 'paymentReady');
    assert.equal(progress.submissionRetries, 2);
    assert.equal(await page.evaluate(() => window.clicks), 3);
  });
  await fixture(confirm, `${order}<button id="submit">提交订单</button><script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.insertAdjacentHTML('beforeend','<div role="dialog">繁忙<button onclick="this.parentElement.remove()">确定</button></div>');};
    </script>`, async page => {
    const progress = {};
    assert.match((await follow(page, { submitOrder: true, progress, timeoutMs: 3000 })).message, /50 次/);
    assert.equal(await page.evaluate(() => window.clicks), 51);
    assert.match((await follow(page, { submitOrder: true, progress })).message, /50 次/);
    assert.equal(await page.evaluate(() => window.clicks), 51);
  });
  await fixture(cart, '<label><input type="checkbox" checked>全选</label><p>合计:￥12999.00</p><div class="_submitBtn_test">去结算 (1)</div><div role="dialog">系统繁忙，结算失败，请重试<button onclick="this.parentElement.remove()">确定</button></div><script>window.clicks=0;document.querySelector("._submitBtn_test").onclick=()=>{window.clicks++;location.href="https://trade.jd.com/shopping/order/getOrderInfo.action";};</script>', async page => {
    await page.route(confirm, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `${order}<button>提交订单</button>` }));
    const progress = { pending: 'cart' };
    assert.equal((await follow(page, { progress, retryDelays: [0], timeoutMs: 1500 })).state, 'reviewOrder');
    assert.equal(progress.retries.cart, 1);
  });
  await fixture(confirm, `${order}<div role="dialog">正在排队，请勿刷新</div><button onclick="window.clicked=true">提交订单</button>`, async page => {
    assert.match((await follow(page, { submitOrder: true, queueTimeoutMs: 30 })).message, /排队等待/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  for (const html of ['<input required>', '<input type="password">', '<p>请完成验证</p>', '<div role="alert">商品无货</div>', '<button>提交订单</button>']) {
    await fixture(confirm, `${order}${html}<button id="submit" onclick="window.clicked=true">提交订单</button>`, async page => {
      assert.equal((await follow(page, { submitOrder: true })).state, 'handoff');
      assert.equal(await page.evaluate(() => window.clicked), undefined);
    });
  }
  for (const url of ['https://example.com/order', 'https://trade.jd.com/other', 'https://jd.com.attacker.test/shopping/order/getOrderInfo.action']) {
    await fixture(url, `${order}<button onclick="window.clicked=true">提交订单</button>`, async page => {
      assert.equal((await follow(page, { submitOrder: true })).state, 'handoff');
      await assert.rejects(checkJDAction(page, page.locator('button'), { submitOrder: true }), /只支持/);
      assert.equal(await page.evaluate(() => window.clicked), undefined);
    });
  }
  for (const name of ['立即支付', '立即支付 ￥12999', '确认付款', '去支付']) {
    await fixture(confirm, `${order}<button onclick="window.paid=true">${name}</button>`, async page => {
      await assert.rejects(checkJDAction(page, page.locator('button'), { submitOrder: true }), /本人操作/);
      assert.equal((await follow(page, { submitOrder: true })).state, 'reviewOrder');
      assert.equal(await page.evaluate(() => window.paid), undefined);
    });
  }
  await fixture('https://pcashier.jd.com/cashier/index.action', '<button onclick="window.paid=true">立即支付</button>', async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  await fixture(confirm, `${order}<button onclick="window.clicked=true">提交订单</button>`, async page => {
    assert.match((await follow(page, { submitOrder: true }, { cancelled: true })).message, /已停止/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture(confirm, `${order}<button id="submit" disabled onclick="window.clicked=true">提交订单</button>`, async page => {
    const run = { cancelled: false };
    setTimeout(() => { run.cancelled = true; }, 30);
    assert.match((await follow(page, { submitOrder: true }, run)).message, /已停止/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture(confirm, `${order}<button id="submit">提交订单</button><script>window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>';};</script>`, async page => {
    await page.evaluate(() => { const body = document.body; body.remove(); setTimeout(() => document.documentElement.appendChild(body), 60); });
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  // An unchanged confirmation page is ambiguous; resuming must not repeat it.
  await fixture(confirm, `${order}<div class="payment-action-submit"><button onclick="window.clicks=(window.clicks||0)+1">立即支付</button></div>`, async page => {
    const progress = {};
    await follow(page, { submitOrder: true, progress });
    await follow(page, { submitOrder: true, progress });
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(progress.submissionRetries || 0, 0);
  });
  // The confirmation-page “立即支付” creates an order: retry dialogs like Tmall.
  for (const persistent of [false, true]) {
    await fixture(confirm, `${order}<div class="payment-action-submit"><button id="submit">立即支付</button></div><script>
      window.clicks=0;submit.onclick=()=>{window.clicks++;if(${persistent}||window.clicks<3)document.body.insertAdjacentHTML('beforeend','<div role="dialog">繁忙<button onclick="this.parentElement.remove()">确定</button></div>');else document.body.innerHTML='<h1>等待买家付款</h1><button onclick="window.paid=true">立即支付</button>';};
      </script>`, async page => {
      const progress = {};
      const result = await follow(page, { submitOrder: true, progress, timeoutMs: 3000 });
      if (persistent) {
        assert.match(result.message, /50 次订单重试上限/);
        assert.match((await follow(page, { submitOrder: true, progress })).message, /50 次订单重试上限/);
        assert.equal(await page.evaluate(() => window.clicks), 51);
        assert.equal(progress.submissionRetries, 50);
      } else {
        assert.equal(result.state, 'paymentReady');
        assert.equal(progress.submissionRetries, 2);
        assert.equal(await page.evaluate(() => window.clicks), 3);
        assert.equal(await page.evaluate(() => window.paid), undefined);
        assert.equal((await follow(page, { submitOrder: true, progress })).state, 'paymentReady');
        assert.equal(await page.evaluate(() => window.paid), undefined);
      }
    });
  }
  await fixture(confirm, `${order}<div class="payment-action-submit"><button onclick="window.paid=true">立即支付</button></div>`, async page => {
    const progress = { submitted: true, pending: 'submit' };
    await follow(page, { submitOrder: true, progress });
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  for (const before of ['<input required>', '<p>请完成验证</p>']) {
    await fixture(confirm, `${before}<div class="payment-action-submit"><button onclick="window.paid=true">立即支付</button></div>`, async page => {
      await assert.rejects(checkJDAction(page, page.locator('button'), { submitOrder: true }));
      assert.equal((await follow(page, { submitOrder: true })).state, 'handoff');
      assert.equal(await page.evaluate(() => window.paid), undefined);
    });
  }
  await fixture(confirm, `${order}<div class="payment-action-submit"><button onclick="window.paid=true">立即支付</button><button onclick="window.paid=true">立即支付</button></div>`, async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'handoff');
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  await fixture(confirm, `${order}<div class="payment-action-submit"><button onclick="window.paid=true">立即支付</button></div>`, async page => {
    assert.equal((await follow(page, { submitOrder: true }, { cancelled: true })).state, 'handoff');
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  console.log(JSON.stringify({ result: 'PASS', checks, environment: 'mocked Chromium; no real orders or payments' }));
} finally { await browser.close(); }
