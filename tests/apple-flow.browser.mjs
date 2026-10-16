import assert from 'node:assert/strict';
import { continueAppleCheckout, initialAppleProgress, isAppleURL, prepareAppleRelease } from '../engine/apple-flow.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'engine/browsers';
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
let checks = 0;
async function fixture(html, check) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://www.apple.com.cn/shop/checkout');
  try { await check(page); checks++; }
  finally { await page.close(); }
}
const run = page => continueAppleCheckout(page, { cancelled: false }, () => {}, { timeoutMs: 500, pollMs: 20 });
try {
  assert.equal(isAppleURL('https://secure8.store.apple.com/uk/shop/checkout'), true);
  for (const url of ['https://apple.com.cn.attacker.test', 'https://fakeapple.com', 'http://apple.com', 'invalid']) assert.equal(isAppleURL(url), false);
  checks++;
  await fixture(`<button id="next">添加到购物袋</button><script>
    window.clicks = [];
    const names = ['添加到购物袋','查看购物袋','结账','继续填写送货地址','继续选择付款方式','查看订单','提交订单'];
    let index = 0;
    next.onclick = () => { clicks.push(next.textContent); next.textContent = names[++index]; };
    </script>`, async page => {
    const messages = [];
    const result = await continueAppleCheckout(page, { cancelled: false }, text => messages.push(text), { timeoutMs: 500, pollMs: 20 });
    assert.equal(result.state, 'reviewOrder', JSON.stringify({ result, messages, text: await page.locator('button').innerText() }));
    assert.equal(await page.evaluate(() => clicks.length), 6);
    assert.equal(await page.locator('button').innerText(), '提交订单');
    assert.equal(messages.length, 6);
  });
  await fixture('<button onclick="window.clicked=true">提交订单</button>', async page => {
    assert.equal((await run(page)).state, 'reviewOrder');
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture('<button data-autom="billing-continue" onclick="window.clicked=true">立即支付</button>', async page => {
    assert.equal((await run(page)).state, 'reviewOrder');
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture('<button>结账</button><button>结账</button>', async page => {
    assert.match((await run(page)).message, /多个/);
  });
  await fixture('<button class="checkout">结账</button><button class="checkout">结账</button><button data-autom="add-to-cart" onclick="window.extra=true">添加到购物袋 (推荐配件)</button><script>document.querySelectorAll(".checkout").forEach(button=>button.onclick=()=>{ window.clicks=(window.clicks||0)+1; document.body.innerHTML="<button>提交订单</button>"; });</script>', async page => {
    await page.goto('https://www.apple.com.cn/shop/bag');
    assert.equal((await run(page)).state, 'reviewOrder');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(await page.evaluate(() => window.extra), undefined);
  });
  await fixture('<form action="/a"><button>结账</button></form><form action="/b"><button>结账</button></form>', async page => {
    await page.goto('https://www.apple.com.cn/shop/bag');
    assert.match((await run(page)).message, /多个/);
  });
  await fixture('<form><input required aria-label="收货地址"><button onclick="window.clicked=true">继续选择付款方式</button></form>', async page => {
    assert.match((await run(page)).message, /尚未完整/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture('<input type="password"><button>结账</button>', async page => {
    assert.match((await run(page)).message, /登录/);
  });
  await fixture('<p role="alert">没有库存</p><button>结账</button>', async page => {
    assert.match((await run(page)).message, /提示/);
  });
  await fixture('<button onclick="window.clicked=true">继续</button>', async page => {
    assert.match((await run(page)).message, /超时/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture('<button onclick="window.count=(window.count||0)+1">结账</button>', async page => {
    assert.match((await run(page)).message, /超时/);
    assert.equal(await page.evaluate(() => window.count), 1, 'no retry without a confirmed transition');
  });
  await fixture('<button onclick="window.count=(window.count||0)+1">结账</button>', async page => {
    const button = page.locator('button');
    const progress = await initialAppleProgress(button, page.url());
    await button.click();
    await continueAppleCheckout(page, { cancelled: false }, () => {}, { timeoutMs: 300, pollMs: 20, progress });
    assert.equal(await page.evaluate(() => window.count), 1, 'initial timed click is included in deduplication');
  });
  await fixture('<button onclick="window.count=(window.count||0)+1">结账</button>', async page => {
    const progress = { visited: new Set() };
    const options = { timeoutMs: 300, pollMs: 20, progress };
    await continueAppleCheckout(page, { cancelled: false }, () => {}, options);
    await continueAppleCheckout(page, { cancelled: false }, () => {}, options);
    assert.equal(await page.evaluate(() => window.count), 1, 'resuming must not repeat an uncertain click');
    await page.evaluate(() => { document.querySelector('button').textContent = '查看订单'; document.querySelector('button').onclick = () => { document.querySelector('button').textContent = '提交订单'; }; });
    assert.equal((await continueAppleCheckout(page, { cancelled: false }, () => {}, options)).state, 'reviewOrder');
  });
  await fixture('<button id="next" disabled onclick="this.textContent=\'提交订单\'">结账</button><script>setTimeout(()=>next.disabled=false,100)</script>', async page => {
    assert.equal((await run(page)).state, 'reviewOrder');
  });
  await fixture('<button id="next" disabled onclick="window.clicked=true">结账</button>', async page => {
    const cancellation = { cancelled: false };
    setTimeout(() => { cancellation.cancelled = true; }, 70);
    assert.match((await continueAppleCheckout(page, cancellation, () => {}, { timeoutMs: 500, pollMs: 20 })).message, /已停止/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  });
  await fixture('<button>结账</button>', async page => {
    await page.goto('https://example.com/shop/checkout');
    assert.match((await run(page)).message, /离开苹果/);
  });
  // 开售前页面上只有写死禁用的「继续」，而且页面自己不会再拉取可售状态，
  // 所以必须靠刷新重试；刷新后才换成服务器下发的加购按钮。
  await fixture(`<p id="root"></p><script>
    window.clicks=[];
    const onProduct=location.pathname.startsWith('/shop/buy-iphone/');
    const loads=Number(sessionStorage.getItem('radarLoads')||0)+1;
    if(onProduct) sessionStorage.setItem('radarLoads',String(loads));
    document.getElementById('root').innerHTML='<button disabled data-autom="continueButton">继续</button>';
    if(onProduct&&loads>1){
      document.getElementById('root').innerHTML='<form><button id="buy" data-autom="add-to-cart">添加到购物袋</button></form>';
      document.getElementById('buy').onclick=()=>{
        clicks.push('addBag');
        history.replaceState({},'','/shop/buy-iphone/iphone-18-pro?product=mjyd4ch/a&step=attach#');
        document.getElementById('root').innerHTML='<button id="bag" value="reviewBag">查看购物袋</button><button data-autom="add-to-cart">添加到购物袋 推荐配件</button>';
        document.getElementById('bag').onclick=()=>{clicks.push('bag');document.getElementById('root').innerHTML='<button>提交订单</button>';};
      };
    }
    </script>`, async page => {
    await page.goto('https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyd4ch/a');
    assert.equal(await page.locator('#root button').innerText(),'继续','开售前只有写死的占位控件');
    const control = await prepareAppleRelease(page,{cancelled:false},{timeoutMs:5000,settleMs:600,dwellMs:300,retryDelayMs:50});
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('radarLoads')),'2','刷新一次即可拿到开售按钮，不重复刷新');
    const progress = await initialAppleProgress(control,page.url());
    await control.click();
    const result = await continueAppleCheckout(page,{cancelled:false},()=>{}, {progress,timeoutMs:700,pollMs:10});
    assert.equal(result.state,'reviewOrder',result.message);
    assert.deepEqual(await page.evaluate(()=>clicks),['addBag','bag']);
  });
  await fixture(`<p id="root"></p><button disabled data-autom="continueButton">继续</button>`, async page => {
    await page.goto('https://www.apple.com.cn/shop/buy-iphone/iphone-duo/mk2p4ch/a');
    await assert.rejects(prepareAppleRelease(page,{cancelled:false},{timeoutMs:700,settleMs:300,dwellMs:200,retryDelayMs:50}),/开售重试超时/);
  });
  // 刷新后仍被改动过的折抵换购和 AppleCare 必须校正回默认，否则会加价下单。
  await fixture(`<p id="root"></p><input type="radio" name="tradeupinline" value="tradeIn" checked><input type="radio" name="tradeupinline" value="noTradeIn"><input type="radio" name="applecare-options" value="on" data-autom="acp" checked><input type="radio" name="applecare-options" value="on" data-autom="noapplecare"><form><button data-autom="add-to-cart">添加到购物袋</button></form>`, async page => {
    await page.goto('https://www.apple.com.cn/shop/buy-iphone/iphone-duo/mk2p4ch/a');
    assert.ok(await prepareAppleRelease(page,{cancelled:false},{timeoutMs:3000,settleMs:600,dwellMs:300,retryDelayMs:50}),'校正默认配置后应解析到购买按钮');
    assert.deepEqual(await page.evaluate(()=>({
      noTradeIn:document.querySelector('input[name="tradeupinline"][value="noTradeIn"]').checked,
      tradeIn:document.querySelector('input[name="tradeupinline"][value="tradeIn"]').checked,
      appleCare:document.querySelector('input[data-autom="acp"]').checked
    })),{noTradeIn:true,tradeIn:false,appleCare:false});
  });
  await fixture(`<form><label><input type="radio" name="payment">支付宝</label><label><input type="radio" name="payment">微信支付</label><button id="review" type="button">检查订单</button></form><script>
    window.clicks=[];
    document.querySelector('input').onclick=()=>clicks.push('alipay');
    review.onclick=()=>{if(!document.querySelector('input').checked) throw Error('Alipay not selected'); clicks.push('review');document.body.innerHTML='<button id="submit">立即下单</button>';submit.onclick=()=>{clicks.push('submit');document.body.innerHTML='订单已生成';};};
    </script>`, async page => {
    const progress={visited:new Set()};
    assert.equal((await continueAppleCheckout(page,{cancelled:false},()=>{}, {progress,timeoutMs:500,pollMs:10,submitOrder:true})).state,'orderSubmitted');
    assert.deepEqual(await page.evaluate(()=>clicks),['alipay','review','submit']);
    await continueAppleCheckout(page,{cancelled:false},()=>{}, {progress,timeoutMs:100,pollMs:10,submitOrder:true});
    assert.deepEqual(await page.evaluate(()=>clicks),['alipay','review','submit']);
  });
  await fixture('<button onclick="window.clicked=true">立即下单</button>',async page=>{
    assert.equal((await run(page)).state,'reviewOrder');
    assert.equal(await page.evaluate(()=>window.clicked),undefined);
  });
  await fixture('<button onclick="window.clicked=true">立即支付</button>',async page=>{
    assert.equal((await continueAppleCheckout(page,{cancelled:false},()=>{}, {submitOrder:true,timeoutMs:100,pollMs:10})).state,'reviewOrder');
    assert.equal(await page.evaluate(()=>window.clicked),undefined);
  });
  await fixture(`<button id="next">结账</button><script>window.clicks=0;next.onclick=()=>{clicks++;history.replaceState({},'', '/shop/checkout?_s=Fulfillment-init');document.body.innerHTML='<button>结账</button><button>结账</button>';setTimeout(()=>{document.body.innerHTML='<button id="shipping">继续填写送货地址</button>';shipping.onclick=()=>{clicks++;document.body.innerHTML='<button>立即下单</button>';};},80);};</script>`,async page=>{
    const first=page.locator('#next');const progress=await initialAppleProgress(first,page.url());await first.click();
    const result=await continueAppleCheckout(page,{cancelled:false},()=>{}, {progress,timeoutMs:500,pollMs:10});
    assert.equal(result.state,'reviewOrder',result.message);assert.equal(await page.evaluate(()=>clicks),2);
  });
  await fixture('<form><input type="email" required data-autom="form-field-emailAddress" aria-invalid="false" value="a***"><button type="button" onclick="document.body.innerHTML=\'<button>立即下单</button>\'">继续选择付款方式</button></form>', async page=>{
    assert.equal((await run(page)).state,'reviewOrder');
  });
  await fixture('<form><input type="email" required data-autom="form-field-emailAddress" aria-invalid="false" value="a***"><button type="button" onclick="window.clicked=true">继续选择付款方式</button></form>',async page=>{
    await page.locator('input').fill('b***');
    assert.equal((await run(page)).state,'handoff');assert.equal(await page.evaluate(()=>window.clicked),undefined);
  });
  await fixture(`<input id="checkout.billing.billingOptions.bankLookUp.selectBank" required aria-required="true"><input id="checkout.billing.billingoptions.alipay" type="radio" name="payment"><label for="checkout.billing.billingoptions.alipay"></label><button id="review">检查订单</button><script>window.clicks=[];document.querySelector('input[type=radio]').onclick=()=>clicks.push('alipay');review.onclick=()=>{clicks.push('review');document.body.innerHTML='<button>立即下单</button>';};</script>`,async page=>{
    assert.equal((await run(page)).state,'reviewOrder');assert.deepEqual(await page.evaluate(()=>clicks),['alipay','review']);
  });
  console.log(JSON.stringify({ result: 'PASS', appleCheckoutChecks: checks, environment: 'mocked Apple pages; no real orders' }));
} finally { await browser.close(); }
