import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { SafariPage, browserChoice, pickScript } from './safari.mjs';
import { fileURLToPath } from 'node:url';
import { Scheduler } from './scheduler.mjs';
import { continueAppleCheckout, initialAppleProgress, isAppleReleaseURL, isAppleURL, prepareAppleRelease } from './apple-flow.mjs';
import { checkTmallAction, prepareTmallAction, prepareTmallCartAtRelease, continueTmallCheckout, resolveTmallButton, isTmallCartURL } from './tmall-flow.mjs';
import { checkJDAction, prepareJDAction, prepareJDCartAtRelease, continueJDCheckout, resolveJDButton, isJDCartURL } from './jd-flow.mjs';
import { observeJDCartRequests } from './jd-diagnostics.mjs';

import { isCheckoutErrorText } from './checkout-recovery.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(directory, 'browsers');
const { chromium } = await import('playwright');
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const scheduler = new Scheduler({ emit: send });
const tasks = new Map();
let context;
let launchPromise;
let demoServer;
let demoPort;
let demoLaunch;
const safariDemos = new Map();

async function safariDemoURL(html) {
  if (!demoServer) {
    demoServer = http.createServer((request, response) => {
      const body = safariDemos.get(request.url);
      response.writeHead(body ? 200 : 404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(body || "演练页面不存在");
    });
    demoLaunch = new Promise((resolve, reject) => {
      demoServer.once("error", reject);
      demoServer.listen(0, "127.0.0.1", () => { demoPort = demoServer.address().port; resolve(); });
    });
  }
  await demoLaunch;
  const route = `/demo/${randomUUID()}`;
  safariDemos.set(route, html);
  return `http://127.0.0.1:${demoPort}${route}`;
}

function stopPicker(task) {
  if (task) { task.pickGeneration = (task.pickGeneration || 0) + 1; clearTimeout(task.pickTimer); }
}

async function bindButton(task, frame, token, url = task.page.url()) {
  task.button = await frame.$(`[data-launch-radar="${token}"]`);
  if (!task.button) throw new Error("目标按钮已失效，请重新绑定");
  if (task.tmallFlow) task.button = await resolveTmallButton(task.button);
  if (task.jdFlow) task.button = await resolveJDButton(task.button);
  task.boundURL = url;
  task.clicked = false;
  task.appleProgress = undefined;
  task.tmallProgress = undefined;
  task.jdProgress = undefined;
  task.page.radarDialog = undefined;
  task.page.radarSubmissionDialog = undefined;
  task.checkoutPage = undefined;
  const text = await task.button.innerText().catch(() => "");
  status(task.id, "bound", `已绑定：${text?.trim().slice(0, 60) || "选定按钮"}`);
}


function assertIdle() {
  if (scheduler.run) throw new Error('请先停止倒计时，再修改页面');
}

async function browser() {
  if (context) return context;
  if (!launchPromise) {
    const profile = process.env.RADAR_TEST_PROFILE || path.join(os.homedir(), 'Library', 'Application Support', 'LaunchRadar', 'Browser');
    launchPromise = fs.mkdir(profile, { recursive: true, mode: 0o700 }).then(() => chromium.launchPersistentContext(profile, {
      headless: process.env.RADAR_TEST_HEADLESS === '1', viewport: null,
      args: ['--start-maximized', ...(process.env.RADAR_TEST_PORT ? [`--remote-debugging-port=${process.env.RADAR_TEST_PORT}`] : [])]
    })).then(async value => {
      context = value;
      context.on('close', () => {
        scheduler.cancel();
        context = undefined;
        launchPromise = undefined;
        for (const task of tasks.values()) {
          if (task.browser === "safari") continue;
          task.button = undefined;
          status(task.id, 'closed', '浏览器已关闭，请重新打开页面');
        }
      });
      await context.exposeBinding('__radarPick', async ({ page, frame }, token) => {
        if (scheduler.run) return;
        const task = [...tasks.values()].find(item => item.page === page);
        if (!task) return;
        await Promise.all(page.frames().map(item => item.evaluate(() => window.__radarCleanup?.()).catch(() => {})));
        await bindButton(task, frame, token);
      });
      send({ type: 'browserReady' });
      return context;
    }).catch(error => { launchPromise = undefined; throw error; });
  }
  return launchPromise;
}

function status(id, state, message, extra = {}) {
  send({ type: 'status', id, state, message, ...extra });
}

async function finishCheckout(task, result) {
  if (['handoff', 'uncertain'].includes(result.state)) {
    const page = task.checkoutPage || task.page;
    if (page.screenshot && !page.radarDialog && !page.isClosed()) {
      try {
        const folder = process.env.RADAR_TEST_PROFILE ? path.join(process.env.RADAR_TEST_PROFILE, 'Diagnostics') : path.join(os.homedir(), 'Library', 'Application Support', 'LaunchRadar', 'Diagnostics');
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        const file = path.join(folder, `${task.id}-${Date.now()}.png`);
        await page.screenshot({ path: file, timeout: 2000 });
        await fs.chmod(file, 0o600);
        result.message += `；现场截图：${file}`;
      } catch { /* Diagnostics must not prevent reporting the checkout state. */ }
    }
  }
  status(task.id, result.state, result.message);
}

async function openTask(command) {
  assertIdle();
  const url = new URL(command.url);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('请输入 http 或 https 商品链接');
  const choice = browserChoice(command);
  const previous = tasks.get(command.id);
  stopPicker(previous);
  if (previous) await previous.page?.close().catch(() => {});
  const task = { id: command.id, clicked: false, demo: Boolean(command.demo), appleFlow: Boolean(command.appleFlow), tmallFlow: command.tmallFlow === true, jdFlow: command.jdFlow === true, submitOrder: command.tmallFlow === true || command.jdFlow === true || Boolean(command.submitOrder), browser: choice, douyinHandoff: command.douyinHandoff === true };
  let page;
  if (choice === 'safari') {
    const target = task.demo ? await safariDemoURL(task.appleFlow ? appleDemoHTML() : demoHTML(command.name || '演练平台')) : url.href;
    page = await SafariPage.open(target);
    page.appleDemoURL = task.demo && task.appleFlow ? target : undefined;
    task.page = page;
    tasks.set(task.id, task);
    status(task.id, 'opened', task.jdFlow && isJDCartURL(page.url())
      ? '京东购物车已打开；到点将刷新、全选并结算，无需绑定按钮'
      : task.appleFlow && isAppleReleaseURL(page.url())
        ? '苹果商品页已打开；到点刷新页面并按默认配置重试开售，无需绑定按钮'
        : 'Safari 已打开；请人工准备信息，再点击「选按钮」');
    return;
  }
  const session = await browser();
  page = await session.newPage();
  task.page = page;
  tasks.set(task.id, task);
  if (task.jdFlow) observeJDCartRequests(page, message => {
    if (tasks.get(task.id) === task) send({ type: 'diagnostic', id: task.id, message });
  });
  const watchDialogs = target => target.on('dialog', dialog => {
    const cartProgress = task.tmallProgress || task.jdProgress;
    if (cartProgress?.pending === 'cart' && !cartProgress.submitted && isCheckoutErrorText(dialog.message())) {
      dialog.dismiss().then(() => { target.radarCheckoutDialog = dialog.message().slice(0, 800); }).catch(error => {
        target.radarDialog = `弹框关闭失败：${error.message}`;
      });
      return;
    }
    const submitted = task.appleProgress?.submitted || task.tmallProgress?.submitted || task.jdProgress?.submitted;
    if (task.submitOrder && submitted) {
      dialog.dismiss().then(() => { target.radarSubmissionDialog = true; }).catch(error => {
        target.radarDialog = `弹框关闭失败：${error.message}`;
      });
      return;
    }
    target.radarDialog = dialog.message().slice(0, 800);
    status(task.id, 'following', `浏览器弹框需要手动处理：${target.radarDialog}`);
    // Leave native dialogs visible for the user; never confirm an unknown action.
  });
  if (task.appleFlow || task.tmallFlow || task.jdFlow) watchDialogs(page);
  page.on('popup', popup => {
    if ((task.tmallFlow || task.jdFlow) && task.clicked && !task.checkoutPage) {
      task.checkoutPage = popup;
      watchDialogs(popup);
    }
  });
  page.on('close', () => {
    if (tasks.get(task.id) === task) status(task.id, 'closed', '页面已关闭');
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame() && task.button && !task.clicked) {
      task.button = undefined;
      const cart = task.tmallFlow && isTmallCartURL(frame.url()) || task.jdFlow && isJDCartURL(frame.url());
      status(task.id, cart ? 'opened' : 'stale', cart ? '购物车已刷新；无需绑定按钮' : '页面已跳转，请重新绑定按钮');
    }
  });
  if (task.demo && task.appleFlow) {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: appleDemoHTML() }));
    await page.goto('https://www.apple.com.cn/shop/radar-demo');
  }
  else if (task.demo) await page.setContent(demoHTML(command.name || '演练平台'));
  else await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.bringToFront();
  status(task.id, 'opened', (task.tmallFlow && isTmallCartURL(page.url()) || task.jdFlow && isJDCartURL(page.url()))
    ? '请核对购物车商品和规格；到点将刷新、全选并结算，无需绑定按钮'
    : task.appleFlow && isAppleReleaseURL(page.url())
      ? '苹果商品页已打开；到点刷新页面并按默认配置重试开售，无需绑定按钮'
      : '请人工准备信息，再点击「选按钮」');
}

async function pickButton(id) {
  assertIdle();
  const task = tasks.get(id);
  if (!task || task.page.isClosed()) throw new Error('请先打开页面');
  await task.page.bringToFront();
  stopPicker(task);
  task.button = undefined;
  if (task.browser === 'safari') {
    await task.page.refreshURL();
    await task.page.evaluate(pickScript());
    task.picking = true;
    const generation = task.pickGeneration;
    const poll = async () => {
      if (task.pickGeneration !== generation || tasks.get(id) !== task) return;
      try {
        const picked = await task.page.evaluate(() => window.__radarPicked);
        if (task.pickGeneration !== generation || tasks.get(id) !== task) return;
        if (picked?.cancelled) { task.picking = false; status(id, 'opened', '已取消选择，请重新选择按钮'); return; }
        if (picked?.token) {
          await task.page.refreshURL();
          if (picked.url !== task.page.url()) throw new Error('页面已跳转，请重新绑定按钮');
          await bindButton(task, task.page, picked.token, picked.url);
          task.picking = false;
          return;
        }
        if (!await task.page.evaluate(() => Boolean(window.__radarCleanup))) { task.picking = false; status(id, 'stale', '页面已变化，请重新选择按钮'); return; }
        task.pickTimer = setTimeout(poll, 200);
      } catch (error) { if (task.pickGeneration === generation) status(id, 'failed', error.message); }
    };
    task.pickTimer = setTimeout(poll, 200);
    status(id, 'picking', '在 Safari 中点击要绑定的按钮（仅支持当前页面，不支持内嵌框架）');
    return;
  }
  await Promise.all(task.page.frames().map(frame => frame.evaluate(() => {
    if (window.__radarCleanup) window.__radarCleanup();
    const banner = document.createElement('div');
    banner.textContent = 'Launch Radar · 点击目标购买按钮进行绑定（此次不会下单） · Esc 取消';
    Object.assign(banner.style, { position: 'fixed', top: '16px', left: '16px', right: '16px', zIndex: '2147483647', padding: '16px', background: '#23221f', color: 'white', borderRadius: '8px', font: '16px system-ui', pointerEvents: 'none' });
    document.documentElement.appendChild(banner);
    let highlighted;
    let originalOutline;
    function clearHighlight() {
      if (highlighted) highlighted.style.outline = originalOutline;
    }
    function move(event) {
      clearHighlight();
      highlighted = event.target.closest('button, a, input[type="submit"], input[type="button"], [role="button"]') || event.target;
      originalOutline = highlighted.style.outline;
      highlighted.style.outline = '3px solid #C65B32';
    }
    function cleanup() {
      clearHighlight(); banner.remove();
      document.removeEventListener('click', click, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      delete window.__radarCleanup;
    }
    function click(event) {
      event.preventDefault(); event.stopImmediatePropagation();
      const element = event.target.closest('button, a, input[type="submit"], input[type="button"], [role="button"]') || event.target;
      const token = `r${Date.now()}${Math.random().toString(16).slice(2)}`;
      element.setAttribute('data-launch-radar', token);
      cleanup();
      window.__radarPick(token);
    }
    function down(event) { if (event.target.closest(':disabled')) click(event); }
    function key(event) { if (event.key === 'Escape') cleanup(); }
    document.addEventListener('click', click, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    window.__radarCleanup = cleanup;
  }).catch(error => { throw new Error(`无法在该页面选择按钮：${error.message}`); })));
  status(id, 'picking', '在浏览器中点击要绑定的按钮');
}

async function checkTask(task) {
  if (task?.douyinHandoff) { status(task.id, "ready", "手机购买提醒已就绪；到点后在抖音 App 下单"); return; }
  if (task?.page.refreshURL) await task.page.refreshURL();
  if (!task || task.page.isClosed()) throw new Error('存在未打开或已关闭的任务');
  const tmallCart = task.tmallFlow && isTmallCartURL(task.page.url());
  const jdCart = task.jdFlow && isJDCartURL(task.page.url());
  // 苹果商品页到点由工具刷新并重新解析开售按钮，不需要预先绑定。
  const appleRelease = task.appleFlow === true && isAppleReleaseURL(task.page.url());
  if (!task.button && !tmallCart && !jdCart && !appleRelease) throw new Error('存在未绑定的任务');
  if (task.clicked) throw new Error('该任务已经点击过，请人工核查订单并重新绑定');
  if (task.button && task.page.url() !== task.boundURL) throw new Error('页面已经变化，请重新绑定按钮');
  if (task.appleFlow && task.page.url() !== task.page.appleDemoURL && !isAppleURL(task.page.url())) throw new Error('后续步骤仅适用于苹果官网，请关闭该选项或打开苹果页面');
  if (task.tmallFlow) {
    if (task.appleFlow || task.jdFlow || task.browser !== 'chrome') throw new Error('天猫自动流程请使用 Chrome，并关闭其他平台结账');
    if (!tmallCart) await checkTmallAction(task.page, task.button, { binding: true });
  }
  if (task.jdFlow) {
    if (task.appleFlow || task.tmallFlow) throw new Error('京东自动流程请关闭其他平台结账');
    if (!jdCart) await checkJDAction(task.page, task.button, { binding: true });
  }
  if (task.appleFlow && task.button) {
    await initialAppleProgress(task.button, task.page.url());
  }
  if (tmallCart || jdCart || appleRelease) {
    task.boundURL = task.page.url();
    status(task.id, 'ready', appleRelease ? '已就绪；到点刷新页面并按默认配置重试开售，最多 1 分钟' : `${jdCart ? '京东' : '淘宝'}购物车已就绪；到点刷新并尝试全选，最多 1 分钟`);
    return;
  }
  const connected = await task.button.evaluate(element => element.isConnected);
  if (!connected || !await task.button.isVisible()) throw new Error('目标按钮已失效或隐藏，请重新绑定');
  // A trial click checks overlays and scrolls the target into view without submitting.
  const enabled = await task.button.isEnabled();
  if (enabled) await task.button.click({ trial: true, timeout: 2000 });
  status(task.id, 'ready', enabled ? '按钮检查通过，等待触发' : '按钮当前禁用；到点最多等待 1.5 秒，请确认页面能自动更新开售状态');
}

async function execute(task, run) {
  if (run.cancelled) return;
  try {
    if (task.douyinHandoff) {
      status(task.id, "mobileReminder", "购买时间已到：请在手机抖音 App 的 Apple Store 官方旗舰店核对商品并下单");
      return;
    }
    if (task.page.refreshURL) await task.page.refreshURL();
    if (task.page.isClosed()) throw new Error('页面已关闭或变化');
    const tmallCart = task.tmallFlow && isTmallCartURL(task.page.url());
    const jdCart = task.jdFlow && isJDCartURL(task.page.url());
    const appleRelease = task.appleFlow && isAppleReleaseURL(task.page.url());
    // 商品页到点会刷新，期间还可能被预购等待页接管，URL 上的查询串会变，只校验仍在商品页。
    if (!appleRelease && task.page.url() !== task.boundURL) throw new Error('页面已关闭或变化');
    if (appleRelease) {
      status(task.id, 'following', '正在等待开售：刷新页面并按默认配置重试（最多 1 分钟）');
      task.button = await prepareAppleRelease(task.page, run, {
        report: message => status(task.id, 'following', message)
      });
    }
    if (tmallCart || jdCart) {
      // Reload replaces the bound DOM node. Resolve controls from the refreshed
      // cart only after selection and checkout become available.
      task.button = undefined;
    } else if (!appleRelease) {
      const valid = await task.button.evaluate(element => element.isConnected);
      if (!valid) throw new Error('目标按钮已失效');
    }
    if (task.appleFlow) task.appleProgress = await initialAppleProgress(task.button, task.page.url());
    let tmallKind = null;
    if (task.tmallFlow) {
      const prepared = tmallCart
        ? await prepareTmallCartAtRelease(task.page, run, message => status(task.id, 'following', message))
        : await prepareTmallAction(task.page, task.button, { returnKind: true }, run);
      task.button = prepared.button;
      tmallKind = prepared.kind;
    }
    let jdKind = null;
    if (task.jdFlow) {
      const prepared = jdCart
        ? await prepareJDCartAtRelease(task.page, run, message => status(task.id, 'following', message))
        : await prepareJDAction(task.page, task.button, { returnKind: true }, run);
      task.button = prepared.button;
      jdKind = prepared.kind;
    }
    if (run.cancelled) return;
    // Set before issuing the action: timeouts must never lead to automatic retries.
    task.clicked = true;
    if (task.tmallFlow) task.tmallProgress = { submitted: tmallKind === 'confirm', payClicked: tmallKind === 'confirm', pending: tmallKind === 'confirm' ? 'submit' : 'cart' };
    if (task.jdFlow) task.jdProgress = { submitted: jdKind !== 'cart', payClicked: jdKind === 'pay', pending: jdKind === 'cart' ? 'cart' : 'submit' };
    const issuedAt = Date.now();
    status(task.id, 'clicking', '正在点击', { issuedAt, delayMs: issuedAt - run.target });
    await task.button.click({ timeout: 1500, noWaitAfter: true });
    if (task.tmallFlow) {
      status(task.id, 'following', tmallKind === 'confirm' ? '已点击立即支付，正在等待付款页面；付款由你本人完成' : '已点击去结算，正在等待淘宝结算页并点击立即支付', { delayMs: issuedAt - run.target });
      const result = await continueTmallCheckout(task.page, run, message => status(task.id, 'following', message), {
        progress: task.tmallProgress, getPage: () => task.checkoutPage || task.page
      });
      await finishCheckout(task, result);
    } else if (task.jdFlow) {
      status(task.id, 'following', '已点击去结算，正在等待京东结算页并点击立即支付', { delayMs: issuedAt - run.target });
      const result = await continueJDCheckout(task.page, run, message => status(task.id, 'following', message), {
        progress: task.jdProgress, getPage: () => task.checkoutPage || task.page
      });
      await finishCheckout(task, result);
    } else if (task.appleFlow) {
      status(task.id, 'following', '已触发，正在识别苹果官网后续步骤', { delayMs: issuedAt - run.target });
      const result = await continueAppleCheckout(task.page, run, message => status(task.id, 'following', message), { progress: task.appleProgress, submitOrder: task.submitOrder });
      await finishCheckout(task, result);
    } else if (task.demo) {
      const count = await task.page.locator('#count').innerText();
      status(task.id, 'demoSuccess', `演练成功：点击 ${count} 次`, { delayMs: issuedAt - run.target });
    } else {
      status(task.id, 'checkOrder', '已点击；请在平台核查订单并完成支付', { delayMs: issuedAt - run.target });
    }
  } catch (error) {
    await finishCheckout(task, { state: task.clicked ? 'uncertain' : 'failed', message: task.clicked ? (task.page.radarDialog ? `浏览器弹框需要手动处理：${task.page.radarDialog}；点击结果不明，不会重试` : '点击结果不明确，请核查订单；不会自动重试') : `未提交：${error.message}` });
  }
}

function appleDemoHTML() {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>苹果多步演练</title><style>body{font:18px system-ui;max-width:680px;margin:80px auto}button{font:inherit;padding:16px}section{padding:24px;background:#faf9f6}</style><h1>Apple · 多步结账演练</h1><p>模拟页面，不会访问苹果或生成真实订单。地址和付款信息已准备完成。</p><section><p id="stage">等待定时继续</p><button id="next">继续</button><p id="result"></p></section><script>
  const stages = [['添加到购物袋','add-to-cart'],['查看购物袋','reviewBag'],['结账','checkout'],['继续填写送货地址','fulfillment-continue'],['继续选择付款方式','shipping-continue'],['检查订单','billing-continue'],['立即下单','place-order']];
  let step = 0;
  document.querySelector('#next').onclick = () => {
    if (step === stages.length) { document.querySelector('#result').textContent = '模拟订单已生成（未付款）'; document.querySelector('#next').remove(); return; }
    const [name, autom] = stages[step++];
    document.querySelector('#next').textContent = name;
    document.querySelector('#next').setAttribute('data-autom', autom);
    if (autom === 'billing-continue') { const payment = document.createElement('label'); payment.innerHTML = '<input type="radio" name="payment">支付宝'; document.querySelector('#next').before(payment); }
    document.querySelector('#stage').textContent = step === stages.length ? '已到订单核对，等待人工确认' : '模拟结账第 ' + step + ' 步';
  };
  </script></html>`;
}

function demoHTML(name) {
  const safeName = name.replace(/[<>&"']/g, '');
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Launch Radar 演练</title><style>body{font:18px system-ui;max-width:680px;margin:80px auto;background:#faf9f6;color:#292724}button{background:#c65b32;color:white;padding:18px 32px;border:0;border-radius:8px;font:inherit}section{padding:32px;border:1px solid #ddd;border-radius:12px}h1{font-size:36px}</style><h1>${safeName} · 模拟结算</h1><section><h2>iPhone 首发演练</h2><p>型号、地址和付款方式已准备完成。</p><p>此页面不会创建真实订单。</p><button id="submit" onclick="window.__radarDemoClickAt=Date.now();document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1; document.querySelector('#result').textContent='模拟订单已生成'">提交模拟订单</button><p id="result">等待提交</p><p>点击次数：<strong id="count">0</strong></p></section></html>`;
}

async function cleanUp() {
  scheduler.cancel();
  await Promise.allSettled([...tasks.values()].map(async task => {
    stopPicker(task);
    if (task.browser === 'safari' && task.picking) await task.page.evaluate(() => window.__radarCleanup?.());
  }));
  await context?.close();
}

async function handle(command) {
  switch (command.type) {
    case 'open': await openTask(command); break;
    case 'pick': await pickButton(command.id); break;
    case 'focus': {
      const task = tasks.get(command.id);
      await (task?.checkoutPage || task?.page)?.bringToFront();
      break;
    }
    case 'check': await checkTask(tasks.get(command.id)); break;
    case 'resume': {
      const task = tasks.get(command.id);
      if (task && command.submitOrder !== undefined) task.submitOrder = task.tmallFlow || task.jdFlow || command.submitOrder === true;
      await scheduler.resume(task, async item => {
        if (item?.page.refreshURL) await item.page.refreshURL();
        if (!item?.clicked || (!item.appleFlow && !item.tmallFlow && !item.jdFlow) || item.page.isClosed()) throw new Error('请先执行苹果、天猫或京东任务，再处理页面提示');
        // User requested resume after handling the native dialog. Retain click guards.
        item.page.radarDialog = undefined;
        if (item.checkoutPage) item.checkoutPage.radarDialog = undefined;
      }, async (item, run) => {
        const report = message => status(item.id, 'following', message);
        const result = item.tmallFlow
          ? await continueTmallCheckout(item.checkoutPage || item.page, run, report, { progress: item.tmallProgress ??= { submitted: true }, getPage: () => item.checkoutPage || item.page })
          : item.jdFlow
            ? await continueJDCheckout(item.checkoutPage || item.page, run, report, { progress: item.jdProgress ??= { submitted: true }, getPage: () => item.checkoutPage || item.page })
          : await continueAppleCheckout(item.page, run, report, { progress: item.appleProgress ??= { visited: new Set() }, submitOrder: item.submitOrder });
        await finishCheckout(item, result);
      });
      break;
    }
    case 'remove': {
      assertIdle();
      const task = tasks.get(command.id);
      stopPicker(task);
      tasks.delete(command.id);
      await task?.checkoutPage?.close();
      await task?.page?.close();
      break;
    }
    case 'runNow':
    case 'arm': {
      if (command.type === 'runNow' && scheduler.run) {
        scheduler.triggerNow();
        break;
      }
      if (scheduler.run) throw new Error('已有倒计时正在运行');
      for (const reminder of command.douyinReminders || []) {
        if (!command.ids.includes(reminder.id)) continue;
        const existing = tasks.get(reminder.id);
        if (existing) existing.douyinHandoff = true;
        else tasks.set(reminder.id, { id: reminder.id, douyinHandoff: true });
      }
      const selected = command.ids.map(id => tasks.get(id));
      if (new Set(command.ids).size !== selected.length) throw new Error('任务重复');
      for (const task of selected) {
        if (task && command.appleFlows) task.appleFlow = command.appleFlows[task.id] === true;
        if (task && command.tmallFlows) task.tmallFlow = command.tmallFlows[task.id] === true;
        if (task && command.jdFlows) task.jdFlow = command.jdFlows[task.id] === true;
        if (task && command.submitOrders) task.submitOrder = task.tmallFlow || task.jdFlow || command.submitOrders[task.id] === true;
      }
      if (command.type === 'runNow') await scheduler.runNow(selected, checkTask, execute);
      else await scheduler.arm(selected, command.target, checkTask, execute);
      break;
    }
    case 'cancel': scheduler.cancel(); break;
    case 'shutdown': await cleanUp(); process.exit(0); break;
    default: throw new Error('未知操作');
  }
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  let command;
  try { command = JSON.parse(line); }
  catch { send({ type: 'error', message: '操作格式错误' }); return; }
  handle(command).catch(error => send({ type: 'error', id: command.id, message: error.message }));
});
process.stdin.on('end', async () => { await cleanUp(); process.exit(0); });
process.on('uncaughtException', error => { send({ type: 'error', message: error.message }); process.exit(1); });
send({ type: 'started' });
