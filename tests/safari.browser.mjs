import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SafariPage, browserChoice, pickScript } from '../engine/safari.mjs';
import { continueAppleCheckout, initialAppleProgress } from '../engine/apple-flow.mjs';
import { resolveJDButton, prepareJDAction, continueJDCheckout } from '../engine/jd-flow.mjs';

assert.equal(browserChoice({ browser: 'safari' }), 'safari');
assert.equal(browserChoice({ browser: 'chrome' }), 'chrome');
assert.equal(browserChoice({}), 'chrome');
assert.throws(() => browserChoice({ browser: 'webkit' }));

// Exercise the complete Safari DOM adapter with a browser transport. This does
// not claim that macOS Apple Events permissions or native Safari were verified.
const browser = await chromium.launch({ headless: true });
try {
  const native = await browser.newPage();
  await native.route('https://www.apple.com.cn/**', route => route.fulfill({ body: '<html><body></body></html>', contentType: 'text/html' }));
  await native.goto('https://www.apple.com.cn/shop/product');
  const page = new SafariPage('test', async (action, id, source) => {
    if (action === 'url') return native.url();
    if (action === 'evaluate') return native.evaluate(source);
    throw new Error(`Unexpected action: ${action}`);
  });
  await page.refreshURL();
  await native.setContent('<button id="next">继续</button><span id="count">0</span><script>next.onclick=()=>count.textContent=Number(count.textContent)+1;</script>');
  await page.evaluate(pickScript());
  await native.locator('#next').click();
  assert.equal(await native.locator('#count').innerText(), '0', 'Safari binding must not submit');
  const picked = await page.evaluate(() => window.__radarPicked);
  assert.equal(picked.url, page.url());
  const button = await page.$(`[data-launch-radar="${picked.token}"]`);
  assert.equal(await button.innerText(), '继续');
  assert.equal(await button.isVisible(), true);
  await button.click({ trial: true });
  assert.equal(await native.locator('#count').innerText(), '0');
  await button.click();
  assert.equal(await native.locator('#count').innerText(), '1');
  await native.locator('#next').evaluate(element => element.disabled = true);
  assert.equal(await button.isEnabled(), false);
  await native.evaluate(() => setTimeout(() => next.disabled = false, 100));
  await button.click({ timeout: 500 });
  assert.equal(await native.locator('#count').innerText(), '2');
  await native.evaluate(() => { const cover = document.createElement('div'); cover.id = 'cover'; cover.style = 'position:fixed;inset:0;z-index:9999'; document.body.append(cover); });
  await assert.rejects(button.click({ timeout: 100 }), /遮挡/);
  assert.equal(await native.locator('#count').innerText(), '2');
  await native.locator('#cover').evaluate(element => element.remove());
  await native.locator('#next').evaluate(element => element.replaceWith(element.cloneNode(true)));
  assert.equal(await button.isVisible(), false);
  await assert.rejects(button.click(), /失效/);
  await page.evaluate(pickScript());
  await native.keyboard.press('Escape');
  assert.equal((await page.evaluate(() => window.__radarPicked)).cancelled, true);
  await native.setContent('<button id="next" disabled>继续</button>');
  await page.evaluate(pickScript());
  // Disabled controls emit pointerdown even when their native click is suppressed.
  await native.locator('#next').dispatchEvent('pointerdown');
  assert.ok((await page.evaluate(() => window.__radarPicked)).token);

  await native.setContent(`<button id="next">继续</button><p id="result"></p><script>
    let step=0; const stages=[['添加到购物袋','add-to-cart'],['查看购物袋','reviewBag'],['结账','checkout'],['继续填写送货地址','fulfillment-continue'],['继续选择付款方式','shipping-continue'],['查看订单','billing-continue'],['提交订单','place-order']];
    next.onclick=()=>{if(step===stages.length){result.textContent='submitted';return;} const [name,autom]=stages[step++];next.textContent=name;next.setAttribute('data-autom',autom);};
  </script>`);
  const first = await page.$('#next');
  const progress = await initialAppleProgress(first, page.url());
  await first.click();
  const result = await continueAppleCheckout(page, { cancelled: false }, () => {}, { progress, timeoutMs: 500, pollMs: 10 });
  assert.equal(result.state, 'reviewOrder');
  assert.equal(await native.locator('#next').innerText(), '提交订单');
  assert.equal(await native.locator('#result').innerText(), '');
  await assert.rejects(initialAppleProgress(await page.$('#next'), page.url()), /最终订单/);
  await native.setContent(`<button id="next">结账</button><script>
    window.clicks=0;next.onclick=()=>{clicks++;if(clicks===1)document.body.insertAdjacentHTML('beforeend','<div role="dialog"><p>系统繁忙，操作失败，请稍后重试</p><button onclick="this.parentElement.remove()">确定</button></div>');else document.body.innerHTML='<button>立即下单</button>';};
  </script>`);
  assert.equal((await continueAppleCheckout(page, { cancelled: false }, () => {}, { timeoutMs: 500, pollMs: 10, retryDelays: [10, 20, 30] })).state, 'reviewOrder');
  assert.equal(await native.evaluate(() => clicks), 2);
  await native.setContent('<button id="submit">立即下单</button><script>window.clicks=0;submit.onclick=()=>{clicks++;setTimeout(()=>document.body.innerHTML="订单已生成",60);};</script>');
  const submittedProgress = { visited: new Set() };
  assert.equal((await continueAppleCheckout(page, { cancelled: false }, () => {}, { progress: submittedProgress, submitOrder: true, timeoutMs: 500, pollMs: 10 })).state, 'orderSubmitted');
  await continueAppleCheckout(page, { cancelled: false }, () => {}, { progress: submittedProgress, submitOrder: true, timeoutMs: 100, pollMs: 10 });
  assert.equal(await native.evaluate(() => clicks), 1);
  await native.setContent('<form><input required><button data-autom="shipping-continue">继续选择付款方式</button></form>');
  assert.equal((await continueAppleCheckout(page, { cancelled: false }, () => {})).state, 'handoff');
  await native.goto('https://www.apple.com.cn/shop/another-product');
  await page.refreshURL();
  assert.notEqual(page.url(), picked.url);
  await assert.rejects(first.evaluate(element => element.isConnected), /失效/);
  // JD's div control can be picked on its nested count. Exercise the actual
  // Safari adapter through selection, navigation, dialog retry and resume.
  const cart = 'https://cart.jd.com/cart_index';
  const confirm = 'https://trade.jd.com/shopping/order/getOrderInfo.action';
  await native.route('https://cart.jd.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<label><input type="checkbox">全选</label><p>合计:￥12999.00</p><div class="_submitBtn_test" onclick="location.href='${confirm}'">去结算 <span id="count">(1)</span></div>` }));
  await native.route('https://trade.jd.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<p>升级公告：如需使用原收银台完成支付，可选择更多支付进入。</p><p>应付总额:￥12999.00</p><div class="payment-action-submit"><button id="submit">立即支付</button></div><script>window.submissions=0;submit.onclick=()=>{submissions++;if(submissions===1)document.body.insertAdjacentHTML('beforeend','<div role="dialog">繁忙<button onclick="this.parentElement.remove()">关闭</button></div>');else document.body.insertAdjacentHTML('beforeend','<h1>京东收银台</h1>');};</script>` }));
  await native.goto(cart);
  await page.refreshURL();
  await page.evaluate(pickScript());
  await native.locator('input[type=checkbox]').click();
  const jdPicked = await page.evaluate(() => window.__radarPicked);
  let jdButton = await resolveJDButton(await page.$(`[data-launch-radar="${jdPicked.token}"]`));
  assert.equal(await jdButton.innerText(), '全选');
  assert.equal(await native.locator('input').isChecked(), false, 'binding must not select all');
  assert.equal(native.url(), cart, 'binding must not checkout');
  jdButton = await prepareJDAction(page, jdButton, { submitOrder: true });
  assert.equal(await jdButton.getAttribute('class'), '_submitBtn_test');
  assert.equal(await native.locator('input').isChecked(), true);
  const jdProgress = { pending: 'cart' };
  await jdButton.click();
  const jdResult = await continueJDCheckout(page, { cancelled: false }, () => {}, { submitOrder: true, progress: jdProgress, timeoutMs: 2000, pollMs: 10 });
  assert.equal(jdResult.state, 'paymentReady');
  assert.equal(page.url(), confirm, 'Safari must refresh URL after checkout navigation');
  assert.equal(await native.evaluate(() => submissions), 2);
  assert.equal(jdProgress.submissionRetries, 1);
  assert.equal((await continueJDCheckout(page, { cancelled: false }, () => {}, { submitOrder: true, progress: jdProgress, timeoutMs: 100 })).state, 'paymentReady');
  assert.equal(await native.evaluate(() => submissions), 2, 'resume must not submit again');
  console.log('PASS: Safari adapter binding, trial click, disabled button, overlay, stale target, cancel, Apple checkout protection, JD binding/select-all/navigation/submission/retry/resume (Chromium transport)');
} finally { await browser.close(); }
