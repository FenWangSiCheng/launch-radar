import assert from 'node:assert/strict';
import { continueAppleCheckout } from '../engine/apple-flow.mjs';
import { continueTmallCheckout } from '../engine/tmall-flow.mjs';
import { inspectNotice } from '../engine/checkout-recovery.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'engine/browsers';
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const apple = 'https://www.apple.com.cn/shop/checkout';
const cart = 'https://cart.taobao.com/cart.htm';
const confirm = 'https://buy.tmall.com/order/confirm_order.htm';
const opts = { timeoutMs: 200, pollMs: 10, retryDelays: [10, 20, 30], queueTimeoutMs: 100 };
const failure = '<div role="dialog"><div role="alert">系统繁忙，操作失败，请稍后重试</div><button onclick="this.parentElement.remove()">确定</button></div>';
let checks = 0;
async function fixture(url, html, check) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(url);
  try { await check(page); checks++; } finally { await page.close(); }
}
const followApple = (page, extra = {}, run = { cancelled: false }) => continueAppleCheckout(page, run, () => {}, { ...opts, ...extra });
const followTmall = (page, extra = {}, run = { cancelled: false }) => continueTmallCheckout(page, run, () => {}, { ...opts, ...extra });
try {
  await fixture(apple, `<button id="next">结账</button><script>window.clicks=0;next.onclick=()=>{clicks++;if(clicks<3)document.body.insertAdjacentHTML('beforeend',${JSON.stringify(failure)});else document.body.innerHTML='<button>立即下单</button>';};</script>`, async page => {
    const progress = { visited: new Set() };
    assert.equal((await followApple(page, { progress })).state, 'reviewOrder');
    assert.equal(await page.evaluate(() => clicks), 3);
    assert.equal(progress.retries.checkout, 2);
  });
  await fixture(apple, `<button id="next">结账</button><script>window.clicks=0;next.onclick=()=>{clicks++;document.body.insertAdjacentHTML('beforeend',${JSON.stringify(failure)});};</script>`, async page => {
    const progress = { visited: new Set() };
    assert.match((await followApple(page, { progress })).message, /重试上限/);
    assert.equal(await page.evaluate(() => clicks), 4);
    assert.match((await followApple(page, { progress })).message, /重试上限/);
    assert.equal(await page.evaluate(() => clicks), 4);
  });
  for (const name of ['添加到购物袋', '立即下单']) {
    await fixture(apple, `<button id="next">${name}</button><script>window.clicks=0;next.onclick=()=>{clicks++;document.body.insertAdjacentHTML('beforeend',${JSON.stringify(failure)});};</script>`, async page => {
      const progress = { visited: new Set() };
      const result = await followApple(page, { progress, submitOrder: true });
      assert.equal(result.state, name === '立即下单' ? 'uncertain' : 'handoff');
      await followApple(page, { progress, submitOrder: true });
      assert.equal(await page.evaluate(() => clicks), 1);
    });
  }
  await fixture(apple, '<button id="next">立即下单</button><script>window.clicks=0;next.onclick=()=>{clicks++;setTimeout(()=>document.body.innerHTML="订单已生成",60);};</script>', async page => {
    assert.equal((await followApple(page, { submitOrder: true })).state, 'orderSubmitted');
    assert.equal(await page.evaluate(() => clicks), 1);
  });
  await fixture(apple, '<button onclick="window.clicks=(window.clicks||0)+1">立即下单</button>', async page => {
    const progress = { visited: new Set() };
    assert.equal((await followApple(page, { progress, submitOrder: true })).state, 'uncertain');
    await followApple(page, { progress, submitOrder: true });
    assert.equal(await page.evaluate(() => clicks), 1);
  });
  await fixture(apple, '<div role="status">正在排队，请勿刷新</div><button onclick="window.clicked=true">结账</button>', async page => {
    const progress = { visited: new Set() };
    assert.match((await followApple(page, { progress })).message, /排队等待已达上限/);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
    assert.match((await followApple(page, { progress })).message, /排队等待已达上限/);
  });
  await fixture(apple, '<div role="dialog">正在排队，请勿刷新</div><button id="next" onclick="document.body.innerHTML=\'<button>立即下单</button>\'">结账</button><script>setTimeout(()=>document.querySelector("div").remove(),60)</script>', async page => {
    assert.equal((await followApple(page)).state, 'reviewOrder');
  });
  for (const text of ['系统繁忙，请稍后再试', '系统繁忙，操作失败，请重试，需要验证码', '商品已售罄', '未知提示']) {
    await fixture(apple, `<div role="dialog">${text}<button onclick="window.closedNotice=true">确定</button></div><button onclick="window.clicked=true">结账</button>`, async page => {
      assert.equal((await followApple(page)).state, 'handoff');
      assert.equal(await page.evaluate(() => window.closedNotice || window.clicked), undefined);
    });
  }
  await fixture(apple, `<button id="next">结账</button><script>window.clicks=0;next.onclick=()=>{clicks++;document.body.insertAdjacentHTML('beforeend',${JSON.stringify(failure)});};</script>`, async page => {
    const run = { cancelled: false };
    setTimeout(() => { run.cancelled = true; }, 60);
    await followApple(page, { retryDelays: [1000, 2000, 4000] }, run);
    assert.equal(await page.evaluate(() => clicks), 1);
  });
  await fixture(cart, `<p>合计 ¥12999</p><button id="next">结算</button>${failure}<script>window.clicks=1;next.onclick=()=>{clicks++;history.replaceState({},'',${JSON.stringify(confirm)});};</script>`, async page => {
    // Route transition must change host via navigation, not cross-origin history.
    await page.evaluate(url => { next.onclick = () => { clicks++; location.href = url; }; }, confirm);
    await page.unroute('**/*');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>实付款 ¥12999</p><button>提交订单</button>' }));
    const progress = { pending: 'cart', submitted: false };
    assert.equal((await followTmall(page, { progress, timeoutMs: 600 })).state, 'reviewOrder');
    assert.equal(progress.retries.cart, 1);
  });
  await fixture(confirm, `<p>实付款 ¥12999</p><button id="next">提交订单</button><script>window.clicks=0;next.onclick=()=>{clicks++;document.body.insertAdjacentHTML('beforeend',${JSON.stringify(failure)});};</script>`, async page => {
    const progress = {};
    assert.equal((await followTmall(page, { progress, submitOrder: true })).state, 'uncertain');
    await page.locator('[role="dialog"] button').click();
    await followTmall(page, { progress, submitOrder: true });
    assert.equal(await page.evaluate(() => clicks), 1);
  });
  await fixture(confirm, '<p>实付款 ¥12999</p><button id="next">提交订单</button><script>window.clicks=0;next.onclick=()=>clicks++;</script>', async page => {
    const progress = {};
    assert.equal((await followTmall(page, { progress, submitOrder: true })).state, 'uncertain');
    await page.evaluate(() => document.body.innerHTML = '<h1>等待买家付款</h1>');
    assert.equal((await followTmall(page, { progress, submitOrder: true })).state, 'paymentReady');
    assert.equal(await page.evaluate(() => clicks), 1);
  });
  await fixture(apple, '<form onsubmit="window.submitted=true;return false"><div role="dialog">系统繁忙，操作失败，请稍后重试<button>确定</button></div><button type="button">结账</button></form>', async page => {
    const notice = await inspectNotice(page);
    assert.equal(notice.kind, 'blocked', 'a dismiss label must never submit an enclosing form');
    assert.equal((await followApple(page)).state, 'handoff');
    assert.equal(await page.evaluate(() => window.submitted), undefined);
  });
  await fixture(apple, '<button onclick="alert(\'系统繁忙\')">结账</button>', async page => {
    const opened = new Promise(resolve => page.once('dialog', dialog => { page.radarDialog = dialog.message(); resolve(dialog); }));
    const click = page.locator('button').click();
    const dialog = await opened;
    assert.match((await inspectNotice(page)).text, /系统繁忙/);
    await dialog.dismiss();
    await click;
  });
  console.log(JSON.stringify({ result: 'PASS', recoveryChecks: checks, environment: 'mocked congestion; no real orders' }));
} finally { await browser.close(); }
