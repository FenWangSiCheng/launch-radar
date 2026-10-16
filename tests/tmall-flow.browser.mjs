import assert from 'node:assert/strict';
import { checkTmallAction, continueTmallCheckout, isTmallURL, prepareTmallCartAtRelease, resolveTmallButton } from '../engine/tmall-flow.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'engine/browsers';
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const cart = 'https://cart.taobao.com/cart.htm';
const confirm = 'https://buy.tmall.com/order/confirm_order.htm';
const orderReview = '<h2>确认收货地址</h2><h2>确认订单信息</h2><h2>付款详情</h2>';
// The live confirmation page renders its order control inside the trade-buy area.
const orderControl = (label, id = 'submit') => `<div id="submitOrder"><div class="trade-buy-btn-submit"><button id="${id}">${label}</button></div></div>`;
const total = amount => `<p>商品总价 ¥${amount}</p>`;
const follow = (page, extra = {}, run = { cancelled: false }) => continueTmallCheckout(page, run, () => {}, { timeoutMs: 400, pollMs: 10, ...extra });
let checks = 0;
async function fixture(url, html, test) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(url);
  try { await test(page); checks++; } finally { await page.close(); }
}
try {
  {
    // The cart is reloaded until its query.bag response makes goods selectable.
    const page = await browser.newPage();
    let loads = 0;
    await page.route('**/*', route => {
      loads++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: loads >= 3
        ? '<label><input id="all" type="checkbox">全选</label><p id="total">合计：￥0</p><button id="settle" disabled>结算</button><script>all.onchange=()=>{total.textContent="合计：￥"+(all.checked?17999:0);settle.disabled=!all.checked}</script>'
        : '<p>款式缺货，暂不可结算</p><button id="settle" disabled>结算</button>' });
    });
    await page.goto(cart);
    const prepared = await prepareTmallCartAtRelease(page, { cancelled: false }, () => {}, { timeoutMs: 5000, pollMs: 10 });
    assert.equal(loads, 3);
    assert.equal(await page.locator('#all').isChecked(), true);
    assert.equal(await prepared.button.isEnabled(), true);
    assert.equal(await prepared.button.innerText(), '结算');
    assert.equal(prepared.kind, 'cart');
    checks++;
    await page.close();
  }
  await fixture(cart, '<p>款式缺货，暂不可结算</p><button id="settle" disabled>结算</button>', async page => {
    await assert.rejects(prepareTmallCartAtRelease(page, { cancelled: false }, () => {}, { timeoutMs: 200, pollMs: 10 }), /1 分钟/);
  });
  await fixture(cart, '<div role="dialog">操作太频繁，请稍后再试</div><button>结算</button>', async page => {
    await assert.rejects(prepareTmallCartAtRelease(page, { cancelled: false }, () => {}, { timeoutMs: 200, pollMs: 10 }), /操作太频繁/);
  });
  assert.ok(isTmallURL(cart));
  for (const url of ['http://cart.taobao.com/cart.htm', 'https://tmall.com.attacker.test', 'https://faketmall.com', 'invalid']) assert.ok(!isTmallURL(url));
  checks++;
  await fixture(cart, '<p>合计： ¥17,999</p><button>结算（1）</button>', async page => {
    assert.equal(await checkTmallAction(page, page.locator('button')), 'cart');
  });
  await fixture(cart, '<p>合计： ¥0</p><button>结算</button>', async page => {
    await assert.rejects(checkTmallAction(page, page.locator('button')), /选中有货/);
  });
  await fixture(cart, '<p>款式缺货</p><button>结算</button>', async page => {
    await assert.rejects(checkTmallAction(page, page.locator('button')), /金额/);
  });
  await fixture(cart, '<p>合计： ¥12999</p><button onclick="window.paid=true">立即支付 ¥12999</button>', async page => {
    await assert.rejects(checkTmallAction(page, page.locator('button')), /本人操作/);
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  // Tmall uses a div control, a nested text div, and a hover overlay covering
  // the text. Target the clickable outer div so the overlay belongs to it.
  await fixture(confirm, `${orderReview}${total('17999')}<style>
    .btn--fixture{position:relative;width:254px;height:48px;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .btn--fixture:hover:after{content:'';position:absolute;inset:0;z-index:1}
    </style><div id="submitOrder"><div class="trade-buy-btn-submit"><a>返回</a><div class="btn--fixture"><div id="caption">立即支付 ￥ 17999</div></div></div></div><script>
    window.clicks=0;document.querySelector('.btn--fixture').onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1><button>立即支付 ￥17999</button>';};
    </script>`, async page => {
    const button = await resolveTmallButton(await page.$('#caption'));
    assert.equal(await button.getAttribute('class'), 'btn--fixture');
    assert.equal(await checkTmallAction(page, button), 'confirm');
    assert.equal((await follow(page)).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  // The cart total and the button label both carry the amount; neither is fixed.
  for (const amount of ['9999', '17,999', '12999.00', '0.01']) {
    await fixture(confirm, `${orderReview}${total(amount)}${orderControl(`立即支付 ￥ ${amount}`)}<script>
      window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>';};
      </script>`, async page => {
      assert.equal((await follow(page)).state, 'paymentReady');
      assert.equal(await page.evaluate(() => window.clicks), 1);
    });
  }
  await fixture(confirm, `${orderReview}${total('12,999.00')}${orderControl('立即支付 ￥ 17,999.00')}<script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>';};
    </script>`, async page => {
    assert.equal((await follow(page)).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  // Taobao can render the amount in a sibling node; the review layout plus
  // “立即支付” is enough to recognize the order-creating control.
  await fixture(confirm, `${orderReview}${total('12999')}${orderControl('立即支付')}<script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>';};
    </script>`, async page => {
    assert.equal((await follow(page)).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  // The legacy “提交订单” button creates the order the same way, without any option.
  await fixture(confirm, '<p>实付款 ¥17999</p><button id="submit">提交订单</button><script>window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML=\'<h1>收银台</h1>\';};</script>', async page => {
    assert.equal(await checkTmallAction(page, page.locator('#submit')), 'confirm');
    assert.equal((await follow(page)).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  // The pay control can mount after the rest of the confirmation page.
  await fixture(confirm, `${orderReview}${total('12999')}<div id="payment"></div><script>
    window.payClicks=0;
    setTimeout(()=>{payment.innerHTML='<div id="submitOrder"><div class="trade-buy-btn-submit"><button id="pay">立即支付 ￥12999</button></div></div>';pay.onclick=()=>{window.payClicks++;document.body.innerHTML='<h1>收银台</h1>'};},30);
    </script>`, async page => {
    assert.equal((await follow(page, { timeoutMs: 1000 })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.payClicks), 1);
  });
  // Checkout errors retry inside a one-minute window, like JD, without a count limit.
  await fixture(cart, '<label><input type="checkbox" checked>全选</label><p>合计：￥12999</p><button id="next">结算</button><div role="dialog">系统繁忙，结算失败，请重试<button onclick="this.parentElement.remove()">确定</button></div><script>window.clicks=0;next.onclick=()=>{window.clicks++;location.href="https://buy.tmall.com/order/confirm_order.htm";};</script>', async page => {
    await page.route(confirm, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}<script>window.pays=0;submit.onclick=()=>{window.pays++;document.body.innerHTML='<h1>收银台</h1>'};</script>` }));
    const progress = { pending: 'cart' };
    assert.equal((await follow(page, { progress, timeoutMs: 1500 })).state, 'paymentReady');
    assert.ok(progress.retryDeadlines.cart > Date.now());
    assert.equal(progress.retries.cart, undefined);
    assert.equal(await page.evaluate(() => window.pays), 1);
  });
  // A persistent checkout error stops once the window expires and never re-clicks.
  await fixture(cart, '<label><input type="checkbox" checked>全选</label><p>合计：￥12999</p><div id="next">结算</div><div role="dialog">结算失败，请重试<button onclick="this.parentElement.remove()">确定</button></div><script>window.clicks=0;next.onclick=()=>{window.clicks++;document.body.insertAdjacentHTML("beforeend","<div role=\'dialog\'>结算失败，请重试<button onclick=\'this.parentElement.remove()\'>确定</button></div>");};</script>', async page => {
    const progress = { pending: 'cart' };
    const options = { progress, timeoutMs: 2000, checkoutRetryWindowMs: 250 };
    const result = await follow(page, options);
    assert.equal(result.state, 'handoff');
    assert.match(result.message, /去结算错误已重试 1 分钟/);
    const clicks = await page.evaluate(() => window.clicks);
    assert.ok(clicks > 1);
    assert.equal(progress.retries.cart, undefined);
    const deadline = progress.retryDeadlines.cart;
    assert.match((await follow(page, options)).message, /去结算错误已重试 1 分钟/);
    assert.equal(progress.retryDeadlines.cart, deadline);
    assert.equal(await page.evaluate(() => window.clicks), clicks);
  });
  // An expired checkout window must not consume the payment-stage window.
  await fixture(confirm, `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}<script>window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>'};</script>`, async page => {
    const progress = { pending: 'cart', retryDeadlines: { cart: Date.now() - 1 } };
    assert.equal((await follow(page, { progress })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await fixture(confirm, `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}<div role="dialog">正在排队，请勿刷新</div>`, async page => {
    assert.match((await follow(page, { queueTimeoutMs: 30 })).message, /排队等待/);
    assert.equal(await page.evaluate(() => window.clicks), undefined);
  });
  for (const html of ['<input required>', '<input type="password">', '<p>请完成验证</p>', '<div role="alert">商品无货</div>']) {
    await fixture(confirm, `${orderReview}${total('12999')}${html}${orderControl('立即支付 ￥12999')}`, async page => {
      assert.equal((await follow(page)).state, 'handoff');
      assert.equal(await page.evaluate(() => window.clicks), undefined);
    });
  }
  // A payment control outside the confirmation layout stays manual: the flow
  // waits for the real “立即支付 ￥xxx” instead of clicking it.
  for (const name of ['确认付款', '立即付款', '去支付']) {
    await fixture(confirm, `${orderReview}${total('12999')}<button onclick="window.paid=true">${name}</button>`, async page => {
      await assert.rejects(checkTmallAction(page, page.locator('button')), /本人操作/);
      assert.equal((await follow(page)).state, 'reviewOrder');
      assert.equal(await page.evaluate(() => window.paid), undefined);
    });
  }
  await fixture(confirm, `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999', 'pay')}<button>提交订单</button>`, async page => {
    assert.match((await follow(page)).message, /多个/);
  });
  await fixture(confirm, `${orderReview}<h1>订单支付</h1>${total('12999')}${orderControl('立即支付 ￥12999')}`, async page => {
    assert.equal((await follow(page)).state, 'paymentReady');
    await assert.rejects(checkTmallAction(page, page.locator('#submit')), /本人操作/);
  });
  // An in-page cashier keeps the confirmation URL. Its notices must pause
  // instead of authorizing another “立即支付”.
  await fixture(confirm, `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}<script>window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1><button onclick="window.paid=true">立即支付</button>';};</script>`, async page => {
    const progress = {};
    assert.equal((await follow(page, { progress })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog">未知提示：订单提交失败<button onclick="this.parentElement.remove()">关闭</button></div>'));
    const result = await follow(page, { progress });
    assert.equal(result.state, 'uncertain');
    assert.match(result.message, /未知提示/);
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  await fixture('https://cashier.alipay.com/example', '<button onclick="window.paid=true">立即支付</button>', async page => {
    assert.equal((await follow(page)).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  await fixture('https://example.com/order/confirm_order.htm', `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}`, async page => {
    assert.match((await follow(page)).message, /离开淘宝/);
  });
  await fixture('https://buy.tmall.com/other', `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}`, async page => {
    assert.match((await follow(page)).message, /不是已知的淘宝/);
  });
  await fixture(confirm, `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}`, async page => {
    assert.match((await follow(page, {}, { cancelled: true })).message, /已停止/);
    assert.equal(await page.evaluate(() => window.clicks), undefined);
  });
  await fixture(confirm, `${orderReview}<p>实付款： ¥17999</p><input required aria-label="地址">${orderControl('立即支付 ￥17999')}`, async page => {
    assert.match((await follow(page)).message, /必填/);
  });
  await fixture(confirm, `${orderReview}${total('12999')}<div id="submitOrder"><div class="trade-buy-btn-submit"><button id="submit" disabled>立即支付 ￥12999</button></div></div>`, async page => {
    const run = { cancelled: false };
    setTimeout(() => { run.cancelled = true; }, 50);
    assert.match((await follow(page, {}, run)).message, /已停止/);
  });
  // An unchanged confirmation page is ambiguous; resuming must not repeat it.
  await fixture(confirm, `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}<script>window.clicks=0;submit.onclick=()=>window.clicks++;</script>`, async page => {
    const progress = {};
    await follow(page, { progress });
    await follow(page, { progress });
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(progress.submissionRetries || 0, 0);
  });
  // The confirmation-page control creates an order: dialogs retry inside the
  // one-minute window, the same way JD's “立即支付” does.
  for (const persistent of [false, true]) {
    await fixture(confirm, `${orderReview}${total('12999')}${orderControl('立即支付 ￥12999')}<script>
      window.clicks=0;submit.onclick=()=>{window.clicks++;if(${persistent}||window.clicks<3)document.body.insertAdjacentHTML('beforeend','<div role="dialog">繁忙<button onclick="this.parentElement.remove()">确定</button></div>');else document.body.innerHTML='<h1>等待买家付款</h1><button onclick="window.paid=(window.paid||0)+1">立即支付</button>';};
      </script>`, async page => {
      const progress = {};
      const result = await follow(page, { progress, timeoutMs: 3000, submissionRetryWindowMs: persistent ? 250 : 3000 });
      if (persistent) {
        assert.match(result.message, /重试 1 分钟/);
        const clicks = await page.evaluate(() => window.clicks);
        assert.ok(clicks > 1);
        assert.equal(progress.submissionRetries, undefined);
        assert.match((await follow(page, { progress, submissionRetryWindowMs: 250 })).message, /重试 1 分钟/);
        assert.equal(await page.evaluate(() => window.clicks), clicks);
      } else {
        assert.equal(result.state, 'paymentReady');
        assert.equal(progress.submissionRetries, undefined);
        assert.equal(await page.evaluate(() => window.clicks), 3);
        assert.equal(await page.evaluate(() => window.paid), undefined);
        assert.equal((await follow(page, { progress })).state, 'paymentReady');
        assert.equal(await page.evaluate(() => window.paid), undefined);
      }
    });
  }
  console.log(JSON.stringify({ result: 'PASS', environment: 'mocked Chromium pages; no real orders or payments', checks }));
} finally { await browser.close(); }
