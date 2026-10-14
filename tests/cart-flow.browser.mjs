import assert from 'node:assert/strict';
import { prepareJDAction, continueJDCheckout, resolveJDButton, checkJDAction } from '../engine/jd-flow.mjs';
import { prepareTmallAction, continueTmallCheckout, resolveTmallButton, checkTmallAction } from '../engine/tmall-flow.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'engine/browsers';
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  for (const [url, prepare, follow, resolve, check] of [
    ['https://cart.jd.com/cart_index', prepareJDAction, continueJDCheckout, resolveJDButton, checkJDAction],
    ['https://cart.taobao.com/cart.htm', prepareTmallAction, continueTmallCheckout, resolveTmallButton, checkTmallAction]
  ]) {
    for (const checked of [false, true]) {
      const page = await browser.newPage();
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <label><input id="all" type="checkbox" ${checked ? 'checked' : ''}>全选</label>
        <p id="total">合计：￥${checked ? '100' : '0'}</p><button id="settle">结算</button>
        <script>window.selections=0;window.clicks=0;
        all.onchange=()=>{window.selections++;total.textContent='合计：￥'+(all.checked?100:0);};
        settle.onclick=()=>{if(!all.checked)throw Error('unselected');window.clicks++;document.body.insertAdjacentHTML('beforeend','<div role="dialog">结算错误，请稍后再试<button aria-label="关闭" onclick="this.parentElement.remove()">×</button></div>');};</script>` }));
      await page.goto(url);
      const run = { cancelled: false };
      const bound = await resolve(await page.$('#all'));
      await check(page, bound, { binding: true });
      assert.equal(await page.locator('#all').isChecked(), checked, 'preflight must not change selection');
      assert.equal(await page.evaluate(() => window.clicks), 0);
      let button = await prepare(page, bound, {}, run);
      button = await prepare(page, button, {}, run);
      assert.equal(await page.locator('#all').isChecked(), true);
      assert.equal(await page.evaluate(() => window.selections), checked ? 0 : 1);
      await button.click();
      const progress = { pending: 'cart' };
      const result = await follow(page, run, () => {}, { progress, retryDelays: [0, 0], timeoutMs: 1500, pollMs: 10 });
      assert.match(result.message, /2 次重试上限/);
      assert.equal(await page.evaluate(() => window.clicks), 3);
      assert.equal(await page.evaluate(() => window.selections), checked ? 0 : 1);
      await follow(page, run, () => {}, { progress, retryDelays: [0, 0], timeoutMs: 200, pollMs: 10 });
      assert.equal(await page.evaluate(() => window.clicks), 3);
      checks++;
      await page.close();
    }
    for (const message of ['商品无货', '请先登录', '请完成验证码', '正在排队，请勿刷新']) {
      const page = await browser.newPage();
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <label><input type="checkbox" checked>全选</label><p>合计：￥100</p><button onclick="window.clicked=true">结算</button>
        <div role="dialog">${message}<button onclick="window.noticeClosed=true;this.parentElement.remove()">关闭</button></div>` }));
      await page.goto(url);
      await follow(page, { cancelled: false }, () => {}, { progress: { pending: 'cart' }, timeoutMs: 200, pollMs: 10, queueTimeoutMs: 30 });
      assert.equal(await page.evaluate(() => window.clicked || window.noticeClosed), undefined);
      checks++;
      await page.close();
    }
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <div role="checkbox" aria-checked="false" onclick="this.setAttribute('aria-checked','true');setTimeout(()=>{document.querySelector('#total').textContent='合计：￥100';document.querySelector('#settle').outerHTML='<button id=settle>结算</button>';},100)"><span>全选</span></div>
      <p id="total">合计：￥0</p><button id="settle" disabled>结算</button>` }));
    await page.goto(url);
    const button = await prepare(page, await resolve(await page.$('[role=checkbox] span')));
    assert.equal(await button.evaluate(node => node.isConnected), true);
    assert.equal(await page.getByRole('checkbox').getAttribute('aria-checked'), 'true');
    await prepare(page, button);
    checks++;
    await page.close();
  }
  console.log(JSON.stringify({ result: 'PASS', checks, environment: 'mocked Chromium; select-all and checkout-error retries' }));
} finally { await browser.close(); }
