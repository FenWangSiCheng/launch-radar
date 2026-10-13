import assert from 'node:assert/strict';
import { checkTmallAction, continueTmallCheckout, isTmallURL, resolveTmallButton } from '../engine/tmall-flow.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'engine/browsers';
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
let checks = 0;
const cart = 'https://cart.taobao.com/cart.htm';
const confirm = 'https://buy.tmall.com/order/confirm_order.htm';
async function fixture(url, html, test) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(url);
  try { await test(page); checks++; } finally { await page.close(); }
}
const options = { timeoutMs: 350, pollMs: 10 };
const follow = (page, extra = {}, run = { cancelled: false }) => continueTmallCheckout(page, run, () => {}, { ...options, ...extra });
const orderReview = '<h2>确认收货地址</h2><h2>确认订单信息</h2><h2>付款详情</h2><p>商品总价 ¥12999</p>';
try {
  for (const amount of ['9999', '17,999', '12999.00', '0.01']) {
    await fixture(confirm, `<h2>确认收货地址</h2><h2>确认订单信息</h2><h2>付款详情</h2><p>商品总价 ￥${amount}</p><button id="submit">立即支付 ￥ ${amount}</button><script>
      window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>';};
      </script>`, async page => {
      assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
      assert.equal(await page.evaluate(() => window.clicks), 1);
    });
  }
  assert.ok(isTmallURL(cart));
  for (const url of ['http://cart.taobao.com/cart.htm', 'https://tmall.com.attacker.test', 'https://faketmall.com', 'invalid']) assert.ok(!isTmallURL(url));
  checks++;
  await fixture(confirm, `<button id="submit">立即支付 ￥12999</button><script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>';};
    setTimeout(()=>document.body.insertAdjacentHTML('afterbegin','<h2>确认收货地址</h2><h2>确认订单信息</h2><h2>付款详情</h2><p>商品总价 ￥12999</p>'),80);
    </script>`, async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await fixture(cart, `${orderReview}<button id="submit">立即支付 ￥12999</button><script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>';};
    </script>`, async page => {
    const evaluate = page.evaluate.bind(page);
    // Use a real navigation, with the new document appearing during inspection.
    page.evaluate = async (...args) => {
      if (page.url().startsWith(cart)) await page.goto(confirm);
      return evaluate(...args);
    };
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await evaluate(() => window.clicks), 1);
  });
  await fixture(confirm, `${orderReview}<button id="submit">提交订单</button><script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1>';};
    </script>`, async page => {
    await page.evaluate(() => {
      const body = document.body;
      body.remove();
      setTimeout(() => document.documentElement.appendChild(body), 80);
    });
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await fixture(confirm, '<button>提交订单</button>', async page => {
    await page.evaluate(() => document.body.remove());
    assert.match((await follow(page, { submitOrder: true })).message, /超时/);
  });
  await fixture(confirm, `${orderReview}<button id="submit">提交订单</button><script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;const body=document.body;body.remove();setTimeout(()=>{body.innerHTML='<h1>收银台</h1>';document.documentElement.appendChild(body);},80);};
    </script>`, async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await fixture(cart, '<p>合计： ¥0</p><button>结算</button>', async page => {
    await assert.rejects(checkTmallAction(page, page.locator('button')), /选中有货/);
  });
  await fixture(cart, '<p>款式缺货</p><button>结算</button>', async page => {
    await assert.rejects(checkTmallAction(page, page.locator('button')), /金额/);
  });
  await fixture(cart, '<p>合计： ¥17,999</p><button>结算（1）</button>', async page => {
    assert.equal(await checkTmallAction(page, page.locator('button')), 'cart');
  });
  await fixture(confirm, '<p>实付款： ￥17999.00</p><button onclick="window.clicks=(window.clicks||0)+1">提交订单</button>', async page => {
    assert.equal((await follow(page)).state, 'reviewOrder');
    assert.equal(await page.evaluate(() => window.clicks), undefined);
    await assert.rejects(checkTmallAction(page, page.locator('button')), /开启自动提交/);
  });
  await fixture(confirm, `<p>实付款： ¥17999</p><button id="submit">提交订单</button><script>
    window.clicks=0; window.paid=0; submit.onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1><button onclick="window.paid++">立即支付</button>';};
    </script>`, async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(await page.evaluate(() => window.paid), 0);
  });
  await fixture(confirm, '<p>实付款： ¥17999</p><button onclick="window.clicks=(window.clicks||0)+1">提交订单</button>', async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'uncertain');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal((await follow(page, { submitOrder: true, submitted: true })).state, 'uncertain');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await fixture(confirm, `${orderReview}<input id="address" type="radio" name="address" checked><input type="radio" name="address"><input id="alipay" type="checkbox" checked><button id="submit"><span>立即支付</span> <span>￥12999</span></button><script>
    window.clicks=0;window.paid=0;submit.onclick=()=>{window.clicks++;window.defaults=[address.checked,alipay.checked];document.body.innerHTML='<h1>收银台</h1><button onclick="window.paid++">立即支付 ¥12999</button>';};
    </script>`, async page => {
    assert.equal((await follow(page)).state, 'reviewOrder');
    await assert.rejects(checkTmallAction(page, page.locator('button')), /开启自动提交/);
    assert.equal(await page.evaluate(() => window.clicks), 0);
    assert.equal(await checkTmallAction(page, page.locator('button'), { submitOrder: true }), 'confirm');
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.deepEqual(await page.evaluate(() => window.defaults), [true, true]);
    assert.equal(await page.evaluate(() => window.paid), 0);
  });
  await fixture(confirm, `${orderReview}<button onclick="window.clicks=(window.clicks||0)+1">立即支付 ¥12999</button>`, async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'uncertain');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal((await follow(page, { submitOrder: true, submitted: true })).state, 'uncertain');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await fixture(confirm, `${orderReview}<button>立即支付 ¥12999</button><button>提交订单</button>`, async page => {
    assert.match((await follow(page, { submitOrder: true })).message, /多个/);
  });
  // Tmall uses a div control, a nested text div, and a hover overlay covering
  // the text. Target the clickable outer div so the overlay belongs to it.
  await fixture(confirm, `${orderReview}<style>
    .btn--fixture{position:relative;width:254px;height:48px;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .btn--fixture:hover:after{content:'';position:absolute;inset:0;z-index:1}
    </style><div id="submitOrder"><div class="trade-buy-btn-submit"><a>返回</a><div class="btn--fixture"><div id="caption">立即支付 ￥ 12999</div></div></div></div><script>
    window.clicks=0;document.querySelector('.btn--fixture').onclick=()=>{window.clicks++;document.body.innerHTML='<h1>收银台</h1><button>立即支付 ￥12999</button>';};
    </script>`, async page => {
    const button = await resolveTmallButton(await page.$('#caption'));
    assert.equal(await button.getAttribute('class'), 'btn--fixture');
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await fixture(confirm, `${orderReview}<h1>订单支付</h1><button onclick="window.paid=true">立即支付 ¥12999</button>`, async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    await assert.rejects(checkTmallAction(page, page.locator('button'), { submitOrder: true }), /付款需要/);
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  await fixture(confirm, '<p>商品总价 ¥12999</p><button onclick="window.paid=true">立即支付 ¥12999</button>', async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'handoff');
    await assert.rejects(checkTmallAction(page, page.locator('button'), { submitOrder: true }), /付款需要/);
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  await fixture(confirm, '<p>实付款： ¥17999</p><button>提交订单</button><button>提交订单</button>', async page => {
    assert.match((await follow(page, { submitOrder: true })).message, /多个/);
  });
  await fixture(confirm, `<p>实付款： ¥17999</p><button id="submit"><span>提交订单</span></button><script>
    window.clicks=0;submit.onclick=()=>{window.clicks++;document.body.innerHTML='<button>立即支付</button>';};
    </script>`, async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await fixture(confirm, '<p>实付款： ¥17999</p><input required aria-label="地址"><button onclick="window.clicked=true">提交订单</button>', async page => {
    assert.match((await follow(page, { submitOrder: true })).message, /必填/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  for (const html of ['<input type="password">', '<p>请完成验证</p>', '<p role="alert">商品无货</p>']) {
    await fixture(confirm, `${html}<p>实付款： ¥17999</p><button onclick="window.clicked=true">提交订单</button>`, async page => {
      assert.equal((await follow(page, { submitOrder: true })).state, 'handoff');
      assert.equal(await page.evaluate(() => window.clicked), undefined);
    });
  }
  await fixture(confirm, '<p>实付款： ¥17999</p><button onclick="window.clicked=true">提交订单</button>', async page => {
    assert.match((await follow(page, { submitOrder: true }, { cancelled: true })).message, /已停止/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture('https://example.com/order/confirm_order.htm', '<p>实付款： ¥17999</p><button onclick="window.clicked=true">提交订单</button>', async page => {
    assert.match((await follow(page, { submitOrder: true })).message, /离开淘宝/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture('https://buy.tmall.com/other', '<p>实付款： ¥17999</p><button onclick="window.clicked=true">提交订单</button>', async page => {
    assert.match((await follow(page, { submitOrder: true })).message, /超时/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  for (const name of ['立即支付', '确认付款', '立即付款', '去支付']) {
    await fixture(confirm, `<p>实付款： ¥17999</p><button onclick="window.paid=true">${name}</button>`, async page => {
      assert.equal((await follow(page, { submitOrder: true })).state, 'handoff');
      await assert.rejects(checkTmallAction(page, page.locator('button'), { submitOrder: true }), /付款需要/);
      assert.equal(await page.evaluate(() => window.paid), undefined);
    });
  }
  await fixture('https://cashier.alipay.com/example', '<button onclick="window.paid=true">立即支付</button>', async page => {
    assert.equal((await follow(page, { submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => window.paid), undefined);
  });
  await fixture(confirm, '<p>实付款： ¥17999</p><button id="submit" disabled onclick="window.clicked=true">提交订单</button>', async page => {
    const run = { cancelled: false };
    setTimeout(() => { run.cancelled = true; }, 50);
    assert.match((await follow(page, { submitOrder: true }, run)).message, /已停止/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  console.log(JSON.stringify({ result: 'PASS', environment: 'mocked Chromium pages; no real orders or payments', checks }));
} finally { await browser.close(); }
