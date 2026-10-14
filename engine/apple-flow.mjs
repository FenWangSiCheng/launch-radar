import { setTimeout as wait } from 'node:timers/promises';
import { inspectNotice, recoverNotice, recoverSubmissionDialog } from './checkout-recovery.mjs';

export function isAppleURL(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && ['apple.com', 'apple.com.cn'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

// Match only known checkout actions; final submission requires an explicit task option.
const steps = [
  { key: 'addBag', name: '加入购物袋', names: /^(添加到购物袋|加入购物袋|Add to Bag)$/i, autom: ['add-to-cart', 'add-to-bag'] },
  { key: 'bag', name: '查看购物袋', names: /^(查看购物袋|查看购物车|Review Bag|View Bag)$/i, autom: ['reviewBag', 'review-bag'] },
  { key: 'checkout', name: '进入结账', names: /^(结账|结算|Check Out|Checkout)$/i, autom: ['checkout'] },
  { key: 'guest', name: '以访客身份继续', names: /^(以游客身份继续|以访客身份继续|以访客身份结账|Continue as Guest|Guest Checkout)$/i, autom: ['guest-checkout'] },
  { key: 'shipping', name: '确认配送方式', names: /^(继续选择送货地址|继续填写送货地址|继续填写收货地址|继续至送货地址|Continue to Shipping Address)$/i, autom: ['fulfillment-continue'] },
  { key: 'billing', name: '确认地址并进入支付方式', names: /^(继续选择付款方式|继续至付款|继续至支付|Continue to Payment|Continue to Billing)$/i, autom: ['shipping-continue'] },
  { key: 'review', name: '进入订单核对', names: /^(查看订单|核对订单|检查订单|Review Your Order|Review Order)$/i, autom: ['billing-continue'] }
];
const submitNames = /^(立即下单|现在下单|下订单|下单|提交订单|Place (Your )?Order)$/i;
const finalNames = /^(立即下单|现在下单|下订单|下单|提交订单|立即购买|立即支付|确认支付|付款|Place (Your )?Order|Pay Now|Buy Now|Complete Purchase)$/i;

export function isFinalAction(label, autom) {
  return finalNames.test(label.trim()) || /Apple\s?Pay/i.test(label) || ['place-order', 'placeOrder', 'checkout-apple-pay'].includes(autom);
}

export async function initialAppleProgress(button, url) {
  const label = await button.evaluate(element => (element.getAttribute('aria-label') || element.innerText || element.textContent || element.value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim());
  const autom = await button.getAttribute('data-autom');
  if (isFinalAction(label, autom)) throw new Error('最终订单提交和支付请手动完成');
  const stage = steps.find(step => step.names.test(label.trim()) || step.autom.includes(autom));
  return { visited: new Set(stage ? [stage.key] : []), pending: stage ? `${url}|${stage.key}` : undefined };
}

async function visible(locator) {
  const found = [];
  for (const candidate of await locator.all()) {
    if (await candidate.isVisible()) found.push(candidate);
  }
  return found;
}

async function formIncomplete(button) {
  return button.evaluate(button => {
    const form = button.closest('form') || document;
    const shown = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const alipaySelected = document.getElementById('checkout.billing.billingoptions.alipay')?.checked === true;
    const fields = [...form.querySelectorAll('input, select, textarea')].filter(element => shown(element) && !element.disabled
      && !(alipaySelected && element.id === 'checkout.billing.billingOptions.bankLookUp.selectBank'));
    if (fields.some(element => {
      if (!element.willValidate || element.validity.valid) return false;
      // Apple validates the unchanged saved email server-side while displaying
      // its masked form in an editable type=email input.
      const savedMaskedEmail = element.type === 'email' && element.getAttribute('data-autom') === 'form-field-emailAddress'
        && element.getAttribute('aria-invalid') === 'false' && /[*•●]/.test(element.value)
        && element.value === element.defaultValue && element.validity.typeMismatch
        && !element.validity.valueMissing && !element.validity.patternMismatch;
      return !savedMaskedEmail;
    })) return true;
    return fields.some(element => element.getAttribute('aria-required') === 'true' && !element.value?.trim());
  });
}

async function inspect(page, { submitOrder = false, pendingKey } = {}) {
  if (page.refreshURL) await page.refreshURL();
  if (page.url() !== page.appleDemoURL && !isAppleURL(page.url())) return { stop: '页面离开苹果官网，已交给你接管' };
  const finals = await visible(page.getByRole('button', { name: finalNames }).or(page.getByRole('link', { name: finalNames }))
    .or(page.locator('[data-autom="place-order"], [data-autom="placeOrder"]')));
  const blocked = await page.evaluate(() => {
    const shown = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    if ([...document.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"], iframe[src*="idmsa.apple.com"], iframe[src*="captcha"]')].some(shown)) return '需要登录或验证码，请在浏览器中完成后手动继续';
    if ([...document.querySelectorAll('[role="alert"], .form-message-wrapper')].some(element => shown(element) && element.textContent.trim())) return '页面提示需要处理，请查看浏览器中的信息';
    return null;
  });
  if (blocked) return { stop: blocked };
  if (finals.length) {
    if (!submitOrder) return { stop: '已到订单核对或支付页面，请核对规格、价格和地址后手动提交', complete: true };
    if (finals.length !== 1) return { stop: '发现多个订单提交按钮，请手动核查' };
    const finalLabel = await finals[0].evaluate(element => (element.getAttribute('aria-label') || element.innerText || element.textContent || element.value || '').trim());
    if (!submitNames.test(finalLabel)) return { stop: '已到支付操作，请手动完成付款', complete: true };
    if (await formIncomplete(finals[0])) return { stop: '订单信息或必填选项尚未完整，请手动核查' };
    return { action: { key: 'submit', name: '提交订单', button: finals[0] } };
  }
  const afterProduct = /[?&]step=attach(?:[&#]|$)/.test(page.url());
  const onBag = /\/shop\/bag\/?$/.test(new URL(page.url()).pathname);
  const matches = [];
  for (const step of steps) {
    // Bag recommendations must never add an extra product to the order.
    if (step.key === pendingKey || ((onBag || afterProduct) && step.key === 'addBag')) continue;
    const locator = page.getByRole('button', { name: step.names }).or(page.getByRole('link', { name: step.names }))
      .or(page.locator(step.autom.flatMap(value => ['button', 'a', '[role="button"]', 'input[type="submit"]'].map(tag => `${tag}[data-autom="${value}"]`)).join(', ')));
    for (const button of await visible(locator)) {
      // Protect against a merchant reusing an intermediate data-autom value.
      const label = await button.evaluate(element => (element.getAttribute('aria-label') || element.innerText || element.textContent || element.value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim());
      if (isFinalAction(label, await button.getAttribute('data-autom'))) return { stop: '已到订单提交页面，请核对后手动提交', complete: true };
      matches.push({ ...step, button, label: label.trim() });
    }
  }
  if (matches.length > 1) {
    // Apple's bag repeats the same checkout control above and below the item
    // list. Collapse only these equivalent controls in the known bag context.
    const equivalent = onBag && matches.every(item => item.key === 'checkout' && item.label === matches[0].label);
    const destinations = equivalent ? await Promise.all(matches.map(item => item.button.evaluate(button => JSON.stringify({ href: button.getAttribute('href'), action: button.closest('form')?.getAttribute('action') ?? null, method: button.closest('form')?.getAttribute('method') ?? null })))) : [];
    if (!equivalent || new Set(destinations).size !== 1) return { stop: '发现多个可继续的按钮，请手动选择，避免走错流程' };
  }
  if (!matches.length) return {};
  const action = matches[0];
  if (action.key === 'review') {
    const payment = await page.evaluate(() => {
      const shown = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
      const radios = [...document.querySelectorAll('input[type="radio"], [role="radio"]')].filter(element => shown(element) || [...element.labels || []].some(shown));
      const alipay = radios.filter(element => {
        const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent);
        const label = [element.getAttribute('aria-label'), ...labelled, ...[...element.labels || []].map(label => label.textContent), element.textContent].filter(Boolean).join(' ');
        if (element.id === 'checkout.billing.billingoptions.alipay') return true;
        return /支付宝|Alipay/i.test(label) && !/花呗|分期/.test(label);
      });
      if (!alipay.length) return { present: false };
      if (alipay.length !== 1) return { ambiguous: true };
      const element = alipay[0];
      if (element.checked || element.getAttribute('aria-checked') === 'true') return { selected: true };
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') return { unavailable: true };
      const token = `payment-${Date.now()}`;
      element.setAttribute('data-launch-radar-payment', token);
      // Native radio inputs are sometimes visually hidden: click their visible label.
      const target = shown(element) ? element : [...element.labels || []].find(shown);
      target.setAttribute('data-launch-radar-payment-target', token);
      return { token };
    });
    if (payment.ambiguous || payment.unavailable) return { stop: '支付宝选项不明确或不可用，请手动核查' };
    if (payment.token) return { action: { key: 'alipay', name: '选择支付宝', button: await page.$(`[data-launch-radar-payment-target="${payment.token}"]`) } };
  }
  // Validate the active form only; hidden forms for later checkout stages do
  // not block a valid current step. Never invent address/payment information.
  const missing = await formIncomplete(action.button);
  if (missing) return { stop: '地址、配送或付款信息尚未完整，请在浏览器中填写或选择后手动继续' };
  return { action };
}

export async function continueAppleCheckout(page, run, report, { timeoutMs = 45000, pollMs = 200, progress = { visited: new Set() }, submitOrder = false, retryDelays, queueTimeoutMs, submissionRetryDelayMs } = {}) {
  const visited = progress.visited;
  let pending = progress.pending;
  let deadline = Date.now() + timeoutMs;
  for (let count = 0; count < 12;) {
    if (run.cancelled) return { state: 'handoff', message: '已停止后续步骤，请在浏览器中检查当前进度' };
    if (page.isClosed()) return { state: 'handoff', message: '页面已关闭，后续步骤已停止' };
    let state;
    try {
      if (page.refreshURL) await page.refreshURL();
      const url = new URL(page.url());
      if (progress.submitted && url.protocol === 'https:' && (url.hostname === 'alipay.com' || url.hostname.endsWith('.alipay.com'))) return { state: 'paymentReady', message: '已到支付宝页面，请本人核对订单并完成付款' };
      if (page.url() !== page.appleDemoURL && !isAppleURL(page.url())) return { state: progress.submitted ? 'uncertain' : 'handoff', message: '页面离开苹果官网，请核查订单' };
      if (progress.submitted) {
        const result = await page.evaluate(() => {
          let text = document.body?.innerText || '';
          document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open], .next-dialog, .ant-modal, .el-message-box').forEach(node => { if (node.innerText) text = text.replace(node.innerText, ''); });
          if (/订单提交成功|订单已提交|订单已生成|感谢您的订购|感谢你的订购/.test(text)) return 'orderSubmitted';
          if (/收银台|订单支付|等待付款|等待买家付款/.test(text)) return 'paymentReady';
        });
        if (result) return { state: result, message: '页面显示订单已生成或已到付款页，请本人核对订单并完成付款' };
        if (submitOrder) {
          const recovery = await recoverSubmissionDialog(page, run, progress, report, { submissionRetryDelayMs });
          if (recovery?.stop) return { state: 'uncertain', message: recovery.stop };
          if (recovery?.retry) {
            progress.retrySubmission = true;
            visited.delete('submit');
            pending = progress.pending = undefined;
            deadline = Date.now() + timeoutMs;
          }
        }
      }
      const notice = await inspectNotice(page);
      if (notice) {
        const recovery = await recoverNotice(page, notice, run, progress, pending?.split('|').at(-1), report, { retryDelays, queueTimeoutMs });
        if (recovery.stop) return { state: progress.submitted ? 'uncertain' : 'handoff', message: recovery.stop };
        if (recovery.waiting) { deadline = Date.now() + timeoutMs; await wait(pollMs); continue; }
        if (recovery.retry) {
          const key = pending.split('|').at(-1);
          visited.delete(key);
          pending = undefined;
          progress.pending = undefined;
          deadline = Date.now() + timeoutMs;
        }
      } else { progress.queueStarted = undefined; progress.queueReported = false; }
      if (progress.submitted && !progress.retrySubmission) state = {};
      else {
        state = await inspect(page, { submitOrder, pendingKey: pending?.split('|').at(-1) });
        if (progress.submitted && state.action && state.action.key !== 'submit') state = {};
      }
    }
    catch (error) {
      // Navigation can destroy the execution context between observations.
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) {
        return { state: progress.submitted ? 'uncertain' : 'handoff', message: `无法确认当前页面，已暂停：${error.message}` };
      }
      state = {};
    }
    if (state.stop) return { state: state.complete ? 'reviewOrder' : 'handoff', message: state.stop };
    if (state.action) {
      const action = state.action;
      const signature = `${page.url()}|${action.key}`;
      // A click returning successfully is not evidence that checkout advanced.
      // Repeat a stage only after an explicit, recoverable failure cleared its guard.
      if (action.key !== pending?.split('|').at(-1)) {
        if (visited.has(action.key)) return { state: 'handoff', message: '页面回到已执行步骤，已暂停，请手动核查' };
        if (!submitOrder && pending?.endsWith('|review')) return { state: 'handoff', message: '订单核对后的页面需要你检查，已停止自动操作' };
        if (await action.button.isEnabled()) {
          if (run.cancelled) continue;
          visited.add(action.key);
          pending = signature;
          progress.pending = signature;
          report(`正在${action.name}`);
          if (action.key === 'submit') { progress.submitted = true; progress.retrySubmission = false; }
          try { await action.button.click({ timeout: 1500, noWaitAfter: true }); }
          catch { return { state: progress.submitted ? 'uncertain' : 'handoff', message: `${action.name}的结果不明确，已暂停；请手动核查，不会重试` }; }
          if (action.key === 'submit') report('已发出下单点击，正在确认订单结果；出现弹框时最多重试 10 次');
          if (action.key !== 'submit') count++;
          deadline = Date.now() + timeoutMs;
        }
      }
    }
    if (Date.now() >= deadline) return { state: progress.submitted ? 'uncertain' : 'handoff', message: progress.submitted ? '已发出下单点击，但未确认订单结果；请查看我的订单，不会重复提交' : '等待页面变化超时或未识别到下一步，请在浏览器中继续' };
    await wait(pollMs);
  }
  return { state: 'handoff', message: '已达到自动步骤上限，请手动核查当前页面' };
}

// A launch can replace the disabled pre-sale control. Re-resolve only the
// product's known Add to Bag control, on the original product page.
export async function waitForAppleRelease(page, original, run, { timeoutMs = 120000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.cancelled) throw new Error('已停止等待开售');
    if (page.refreshURL) await page.refreshURL();
    if (!isAppleURL(page.url()) || !/\/shop\/buy-iphone\//.test(new URL(page.url()).pathname) || /[?&]step=attach/.test(page.url())) throw new Error('等待开售期间页面已离开商品配置页');
    if (await original.evaluate(element => element.isConnected).catch(() => false)) {
      // The page can replace the control after isConnected was observed.
      // Treat that specific race as still waiting and resolve it next poll.
      const enabled = await original.isVisible() && await original.isEnabled().catch(error => {
        if (/Element is not attached to the DOM/.test(error.message)) return false;
        throw error;
      });
      if (enabled) return original;
    } else {
      const buttons = await visible(page.getByRole('button', { name: steps[0].names }).or(page.locator('button[data-autom="add-to-cart"], button[data-autom="add-to-bag"]')));
      if (buttons.length > 1) throw new Error('商品页存在多个购买按钮，请重新绑定');
      if (buttons.length === 1 && await buttons[0].isEnabled()) return buttons[0];
    }
    await wait(pollMs);
  }
  throw new Error('等待开售按钮启用超时，请检查官网');
}
