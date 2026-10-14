import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { chromium } from 'playwright';
import { setTimeout as wait } from 'node:timers/promises';

const profile = await mkdtemp(path.join(os.tmpdir(), 'radar-test-'));
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const events = [];
const worker = spawn(process.execPath, ['engine/worker.mjs'], {
  env: { ...process.env, RADAR_TEST_PROFILE: profile, RADAR_TEST_HEADLESS: '1', RADAR_TEST_PORT: String(port) },
  stdio: ['pipe', 'pipe', 'pipe']
});
worker.stderr.on('data', data => process.stderr.write(data));
readline.createInterface({ input: worker.stdout }).on('line', line => events.push(JSON.parse(line)));
function send(command) { worker.stdin.write(JSON.stringify(command) + '\n'); }
async function event(predicate, start = 0) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const found = events.slice(start).find(predicate);
    if (found) return found;
    await wait(20);
  }
  throw new Error('Event timeout: ' + JSON.stringify(events.slice(start)));
}
let browser;
try {
  await event(item => item.type === 'started');
  for (let i = 0; i < 3; i++) {
    send({ type: 'open', id: String(i), name: `模拟平台 ${i + 1}`, url: 'https://example.com', demo: true });
    await event(item => item.id === String(i) && item.state === 'opened');
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts()[0].pages().filter(page => page.url() === 'about:blank');
  const demoPages = [];
  for (const page of pages) {
    if (await page.locator('#submit').count()) {
      const heading = await page.locator('h1').innerText();
      demoPages[Number(heading.match(/模拟平台 (\d+)/)[1]) - 1] = page;
    }
  }
  assert.equal(demoPages.length, 3);
  for (let i = 0; i < 3; i++) {
    send({ type: 'pick', id: String(i) });
    await event(item => item.id === String(i) && item.state === 'picking');
    await demoPages[i].locator('#submit').click();
    await event(item => item.id === String(i) && item.state === 'bound');
    assert.equal(await demoPages[i].locator('#count').innerText(), '0', 'binding must not submit');
  }
  const start = events.length;
  const target = Date.now() + 1800;
  send({ type: 'arm', ids: ['0', '1', '2'], target });
  await event(item => item.type === 'armed', start);
  send({ type: 'arm', ids: ['0', '1', '2'], target });
  await event(item => item.type === 'error' && item.message.includes('已有倒计时'), start);
  await event(item => item.type === 'finished', start);
  const successes = events.slice(start).filter(item => item.state === 'demoSuccess');
  assert.equal(successes.length, 3);
  for (const page of demoPages) assert.equal(await page.locator('#count').innerText(), '1');
  const timing = await Promise.all(successes.map(async item => ({ platform: item.id, dispatchDelayMs: item.delayMs, actualClickDelayMs: await demoPages[Number(item.id)].evaluate(() => window.__radarDemoClickAt) - target })));
  const after = events.length;
  send({ type: 'arm', ids: ['0', '1', '2'], target: Date.now() + 1500 });
  await event(item => item.type === 'error', after);
  assert.equal(await demoPages[0].locator('#count').innerText(), '1');
  // Rebind, arm then cancel: no additional click.
  const rebindStart = events.length;
  send({ type: 'pick', id: '0' });
  await event(item => item.id === '0' && item.state === 'picking', rebindStart);
  await demoPages[0].locator('#submit').click();
  await event(item => item.id === '0' && item.state === 'bound', rebindStart);
  const cancelStart = events.length;
  send({ type: 'arm', ids: ['0'], target: Date.now() + 1500 });
  await event(item => item.type === 'armed', cancelStart);
  send({ type: 'cancel' });
  await event(item => item.type === 'cancelled', cancelStart);
  await wait(1600);
  assert.equal(await demoPages[0].locator('#count').innerText(), '1');
  // Replacing a previously bound button must fail, rather than guess a new target.
  await demoPages[0].evaluate(() => { const old = document.querySelector('#submit'); old.replaceWith(old.cloneNode(true)); });
  const staleStart = events.length;
  send({ type: 'arm', ids: ['0'], target: Date.now() + 1500 });
  await event(item => item.type === 'error', staleStart);
  assert.equal(await demoPages[0].locator('#count').innerText(), '1');
  // A button disabled during preparation can become enabled at launch time.
  const disabledStart = events.length;
  send({ type: 'pick', id: '1' });
  await event(item => item.id === '1' && item.state === 'picking', disabledStart);
  await demoPages[1].locator('#submit').click();
  await event(item => item.id === '1' && item.state === 'bound', disabledStart);
  await demoPages[1].evaluate(() => {
    document.querySelector('#submit').disabled = true;
    setTimeout(() => { document.querySelector('#submit').disabled = false; }, 1800);
  });
  const enablingStart = events.length;
  send({ type: 'arm', ids: ['1'], target: Date.now() + 1500 });
  const disabledReady = await event(item => item.id === '1' && item.state === 'ready', enablingStart);
  assert.ok(disabledReady.message.includes('1.5 秒'), 'generic tasks must show their actual enablement timeout');
  await event(item => item.type === 'armed', enablingStart);
  await event(item => item.state === 'demoSuccess', enablingStart);
  assert.equal(await demoPages[1].locator('#count').innerText(), '2');
  // Exercise the real worker's Apple follow-up path using a fully mocked site.
  const appleStart = events.length;
  send({ type: 'open', id: 'apple', name: '苹果多步演练', url: 'https://example.com', demo: true, appleFlow: true });
  await event(item => item.id === 'apple' && item.state === 'opened', appleStart);
  const applePage = browser.contexts()[0].pages().find(page => page.url().includes('/radar-demo'));
  send({ type: 'pick', id: 'apple' });
  await event(item => item.id === 'apple' && item.state === 'picking', appleStart);
  await applePage.locator('#next').click();
  await event(item => item.id === 'apple' && item.state === 'bound', appleStart);
  assert.equal(await applePage.locator('#next').innerText(), '继续');
  send({ type: 'arm', ids: ['apple'], appleFlows: { apple: true }, target: Date.now() + 1500 });
  await event(item => item.id === 'apple' && item.state === 'reviewOrder', appleStart);
  await event(item => item.type === 'finished', appleStart);
  assert.equal(await applePage.locator('#next').innerText(), '立即下单');
  assert.equal(await applePage.locator('#result').innerText(), '');
  const submitStart = events.length;
  send({type:'open', id:'apple-submit', name:'完整下单演练', url:'https://example.com', demo:true, appleFlow:true, submitOrder:true});
  await event(item=>item.id==='apple-submit' && item.state==='opened',submitStart);
  const submitPage=browser.contexts()[0].pages().filter(page=>page.url().includes('/radar-demo')).find(page=>page!==applePage);
  send({type:'pick',id:'apple-submit'});
  await event(item=>item.id==='apple-submit' && item.state==='picking',submitStart);
  await submitPage.locator('#next').click();
  await event(item=>item.id==='apple-submit' && item.state==='bound',submitStart);
  send({type:'arm',ids:['apple-submit'],appleFlows:{'apple-submit':true},submitOrders:{'apple-submit':true},target:Date.now()+1500});
  await event(item=>item.id==='apple-submit' && item.state==='orderSubmitted',submitStart);
  await event(item=>item.type==='finished',submitStart);
  assert.equal(await submitPage.locator('#result').innerText(),'模拟订单已生成（未付款）');
  assert.equal(await submitPage.locator('input[type="radio"]').isChecked(),true);
  const finalStart = events.length;
  send({ type: 'pick', id: 'apple' });
  await event(item => item.id === 'apple' && item.state === 'picking', finalStart);
  await applePage.locator('#next').click();
  await event(item => item.id === 'apple' && item.state === 'bound', finalStart);
  send({ type: 'arm', ids: ['apple'], target: Date.now() + 1500 });
  await event(item => item.type === 'error' && item.message.includes('最终订单'), finalStart);
  assert.equal(await applePage.locator('#result').innerText(), '');
  await applePage.setContent(`<form><input id="address" required hidden><button id="next" type="button">继续</button></form><script>
    let stage=0; window.steps=0;
    next.onclick=()=>{ window.steps++; stage++; address.hidden=false; next.textContent=stage===1?'继续选择付款方式':stage===2?'查看订单':'提交订单'; };
    </script>`);
  const handoffStart = events.length;
  send({ type: 'pick', id: 'apple' });
  await event(item => item.id === 'apple' && item.state === 'picking', handoffStart);
  await applePage.locator('#next').click();
  await event(item => item.id === 'apple' && item.state === 'bound', handoffStart);
  send({ type: 'arm', ids: ['apple'], target: Date.now() + 1500 });
  await event(item => item.id === 'apple' && item.state === 'handoff', handoffStart);
  await event(item => item.type === 'finished', handoffStart);
  assert.equal(await applePage.evaluate(() => window.steps), 1);
  await applePage.locator('#address').fill('模拟地址');
  const resumeStart = events.length;
  send({ type: 'resume', id: 'apple' });
  await event(item => item.id === 'apple' && item.state === 'reviewOrder', resumeStart);
  await event(item => item.type === 'finished', resumeStart);
  assert.equal(await applePage.evaluate(() => window.steps), 3);
  // Manual runs use the same bound buttons and replace a pending timer.
  for (const scheduled of [false, true]) {
    const manualStart = events.length;
    send({ type: 'pick', id: '2' });
    await event(item => item.id === '2' && item.state === 'picking', manualStart);
    await demoPages[2].locator('#submit').click();
    await event(item => item.id === '2' && item.state === 'bound', manualStart);
    if (scheduled) {
      send({ type: 'arm', ids: ['2'], target: Date.now() + 1500 });
      await event(item => item.type === 'armed', manualStart);
    }
    send({ type: 'runNow', ids: ['2'] });
    await event(item => item.id === '2' && item.state === 'demoSuccess', manualStart);
    await event(item => item.type === 'finished', manualStart);
    if (scheduled) await wait(1600);
    assert.equal(await demoPages[2].locator('#count').innerText(), scheduled ? '3' : '2');
    assert.equal(events.slice(manualStart).filter(item => item.state === 'demoSuccess').length, 1);
    assert.ok(!events.slice(manualStart).some(item => item.type === 'error'));
  }
  // Route all Taobao/Tmall test pages locally; never touch the real cart.
  await browser.contexts()[0].route(/^https:\/\/(cart\.taobao\.com|buy\.tmall\.com)\//, route => {
    const url = new URL(route.request().url());
    const popup = url.searchParams.has('popup');
    const html = url.hostname === 'cart.taobao.com'
      ? `<label><input id="all" type="checkbox" onchange="window.selected=(window.selected||0)+1">全选</label><p>合计： ¥17999</p><button id="settle">结算</button><script>window.settled=0;settle.onclick=()=>{if(!all.checked)throw new Error('must select all');window.settled++;if(window.settled===1){alert('结算错误，请稍后再试');return;}${popup ? "window.open('about:blank')" : "location.href='https://buy.tmall.com/order/confirm_order.htm'"};};</script>`
      : '<h2>确认收货地址</h2><h2>确认订单信息</h2><h2>付款详情</h2><p>商品总价 ¥17999</p><style>.btn--fixture{position:relative;width:254px;height:48px;display:flex;align-items:center;justify-content:center}.btn--fixture:hover:after{content:"";position:absolute;inset:0;z-index:1}</style><div id="submitOrder"><div class="trade-buy-btn-submit"><div id="submit" class="btn--fixture"><div>立即支付 ¥17999</div></div></div></div><script>window.submissions=0;window.payments=0;submit.onclick=()=>{window.submissions++;document.body.innerHTML=\'<h1>收银台</h1><button id="pay">立即支付</button>\';pay.onclick=()=>window.payments++;};</script>';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  for (const popup of [false, true]) {
    const tmallStart = events.length;
    const id = popup ? 'tmall-popup' : 'tmall';
    const url = `https://cart.taobao.com/cart.htm${popup ? '?popup=1' : ''}`;
    const previousPages = new Set(browser.contexts()[0].pages());
    send({ type: 'open', id, url, browser: 'chrome', tmallFlow: true, submitOrder: true });
    await event(item => item.id === id && item.state === 'opened', tmallStart);
    const cartPage = browser.contexts()[0].pages().find(page => !previousPages.has(page) && page.url() === url);
    // Let the worker dismiss native errors; this CDP observer must not auto-dismiss them.
    cartPage.on('dialog', () => {});
    send({ type: 'pick', id });
    await event(item => item.id === id && item.state === 'picking', tmallStart);
    await cartPage.locator('#all').click();
    await event(item => item.id === id && item.state === 'bound', tmallStart);
    assert.equal(await cartPage.evaluate(() => window.settled), 0);
    assert.equal(await cartPage.locator('#all').isChecked(), false, 'binding must not select all');
    // Attach the test client before navigating the popup so its first request
    // is always mocked; CDP can otherwise attach after the initial request.
    const popupPage = popup ? browser.contexts()[0].waitForEvent('page') : null;
    send({ type: 'runNow', ids: [id], tmallFlows: { [id]: true }, submitOrders: { [id]: true } });
    if (popupPage) await (await popupPage).goto('https://buy.tmall.com/order/confirm_order.htm');
    await event(item => item.id === id && item.state === 'paymentReady', tmallStart);
    await event(item => item.type === 'finished', tmallStart);
    const orderPage = browser.contexts()[0].pages().find(page => !previousPages.has(page) && page.url().includes('buy.tmall.com'));
    assert.equal(await orderPage.evaluate(() => window.submissions), 1);
    assert.equal(await orderPage.evaluate(() => window.payments), 0);
    // Resume after an unknown post-submission notice must retain the submit guard.
    await orderPage.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog">未知订单提示<button>确定</button></div>'));
    const paused = events.length;
    send({ type: 'resume', id });
    const pausedResult = await event(item => item.id === id && item.state === 'uncertain', paused);
    assert.match(pausedResult.message, /未知订单提示/);
    await event(item => item.type === 'finished', paused);
    await orderPage.locator('[role="dialog"]').evaluate(element => element.remove());
    const resumed = events.length;
    send({ type: 'resume', id });
    await event(item => item.id === id && item.state === 'paymentReady', resumed);
    await event(item => item.type === 'finished', resumed);
    assert.equal(await orderPage.evaluate(() => window.submissions), 1);
    assert.equal(await orderPage.evaluate(() => window.payments), 0);
    const repeated = events.length;
    send({ type: 'runNow', ids: [id] });
    await event(item => item.type === 'error', repeated);
    assert.equal(await orderPage.evaluate(() => window.submissions), 1);
  }
  // JD uses a div checkout control with a nested count in the live cart.
  await browser.contexts()[0].route(/^https:\/\/(cart\.jd\.com|trade\.jd\.com)\//, route => {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get('mode') || 'legacy';
    const popup = url.searchParams.has('popup');
    const destination = `https://trade.jd.com/shopping/order/getOrderInfo.action?mode=${mode}`;
    const html = url.hostname === 'cart.jd.com'
      ? `<label><input id="all" type="checkbox" onchange="window.selected=(window.selected||0)+1">全选</label><p>合计:￥12,999.00</p><p>商品总额:￥12,999.00</p><div id="settle" class="_submitBtn_fixture">去结算 &nbsp;<span id="caption">(1)</span></div><script>window.settled=0;settle.onclick=()=>{if(!all.checked)throw new Error('must select all');window.settled++;if(window.settled===1){alert('结算错误，请稍后再试');return;}${popup ? "window.open('about:blank')" : `location.href='${destination}'`};};</script>`
      : mode === 'integrated'
        ? '<span>商品结算</span><em>付款详情</em><em>商品总额</em><div>￥12999.00</div><div class="payment-action-submit"><button onclick="window.payments=(window.payments||0)+1;document.body.insertAdjacentHTML(\'beforeend\',\'<h1>京东收银台</h1>\')">立即支付</button></div>'
        : '<p>应付总额：￥12999.00</p><button id="order-submit"><span>提交订单</span></button><script>window.submissions=0;window.payments=0;document.querySelector("#order-submit").onclick=()=>{window.submissions++;document.body.innerHTML=\'<h1>京东收银台</h1><button onclick="window.payments++">立即支付</button>\';};</script>';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  for (const { mode, popup, submitOrder } of [{ mode: 'legacy', popup: false, submitOrder: true }, { mode: 'legacy', popup: true, submitOrder: true }, { mode: 'legacy', popup: false, submitOrder: false }, { mode: 'integrated', popup: false, submitOrder: true }, { mode: 'integrated', popup: false, submitOrder: false }]) {
    const start = events.length;
    const id = `jd-${mode}-${popup}-${submitOrder}`;
    const url = `https://cart.jd.com/cart_index?mode=${mode}${popup ? '&popup=1' : ''}`;
    const previous = new Set(browser.contexts()[0].pages());
    send({ type: 'open', id, url, browser: 'chrome', jdFlow: true, submitOrder });
    await event(item => item.id === id && item.state === 'opened', start);
    const cartPage = browser.contexts()[0].pages().find(page => !previous.has(page) && page.url() === url);
    // Let the worker dismiss native errors; this CDP observer must not auto-dismiss them.
    cartPage.on('dialog', () => {});
    send({ type: 'pick', id });
    await event(item => item.id === id && item.state === 'picking', start);
    await cartPage.locator(mode === 'legacy' ? '#all' : '#caption').click();
    await event(item => item.id === id && item.state === 'bound', start);
    assert.equal(await cartPage.evaluate(() => window.settled), 0);
    assert.equal(await cartPage.locator('#all').isChecked(), false, 'binding must not select all');
    const popupPage = popup ? browser.contexts()[0].waitForEvent('page') : null;
    send({ type: 'arm', ids: [id], jdFlows: { [id]: true }, submitOrders: { [id]: submitOrder }, target: Date.now() + 1500 });
    await event(item => item.type === 'armed', start);
    assert.equal(await cartPage.locator('#all').isChecked(), false, 'arming must not select all');
    if (popupPage) await (await popupPage).goto(`https://trade.jd.com/shopping/order/getOrderInfo.action?mode=${mode}`);
    const state = submitOrder ? 'paymentReady' : 'reviewOrder';
    await event(item => item.id === id && item.state === state, start);
    await event(item => item.type === 'finished', start);
    const orderPage = browser.contexts()[0].pages().find(page => !previous.has(page) && page.url().includes('trade.jd.com'));
    assert.equal(await orderPage.evaluate(() => window.payments || 0), mode === 'integrated' && submitOrder ? 1 : 0);
    assert.equal(await orderPage.evaluate(() => window.submissions || 0), mode === 'legacy' && submitOrder ? 1 : 0);
    if (state === 'paymentReady') {
      const resumed = events.length;
      send({ type: 'resume', id });
      await event(item => item.id === id && item.state === 'paymentReady', resumed);
      await event(item => item.type === 'finished', resumed);
      assert.equal(await orderPage.evaluate(() => window.submissions || 0), mode === 'legacy' ? 1 : 0);
    }
    const repeat = events.length;
    send({ type: 'runNow', ids: [id] });
    await event(item => item.type === 'error', repeat);
    assert.equal(await orderPage.evaluate(() => window.payments || 0), mode === 'integrated' && submitOrder ? 1 : 0);
  }
  await writeFile('docs/browser-test-results.json', JSON.stringify({ testedAt: new Date().toISOString(), environment: 'local headless Chromium; simulated checkout only', timing, checks: ['binding does not submit', 'three pages submit once', 'duplicate arm rejected', 'clicked tasks cannot rearm without rebinding', 'cancel prevents click', 'detached button fails', 'disabled button waits for enablement', 'Apple follow-up stops before order submission', 'Apple final primary button rejected', 'Apple missing address pauses and resumes after filling', 'manual run dispatches immediately', 'manual trigger replaces timer without duplicate execution', 'Tmall checkout submits once and stops before payment', 'Tmall checkout supports a new order tab without duplicate submission', 'Tmall unknown post-submit notice pauses and resumes without resubmission', 'JD div binding does not checkout', 'JD scheduled checkout supports same-tab and popup navigation', 'JD submission guard survives resume', 'JD default stops at confirmation', 'JD submission checkbox clicks integrated payment once and preserves resume guard'] }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', timing, checks: 21 }, null, 2));
} finally {
  send({ type: 'shutdown' });
  await new Promise(resolve => { worker.on('exit', resolve); setTimeout(() => { worker.kill(); resolve(); }, 4000).unref(); });
  await browser?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
