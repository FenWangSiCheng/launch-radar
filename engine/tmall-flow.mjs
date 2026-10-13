import { setTimeout as wait } from 'node:timers/promises';
import { inspectNotice, recoverNotice } from './checkout-recovery.mjs';

export function isTmallURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['taobao.com', 'tmall.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function pageKind(value) {
  if (!isTmallURL(value)) return null;
  const url = new URL(value);
  if (url.hostname === 'cart.taobao.com' && /^\/cart\.htm$/.test(url.pathname)) return 'cart';
  if (['buy.taobao.com', 'buy.tmall.com'].includes(url.hostname) && /confirm[_-]?order|order\/confirm/i.test(url.pathname)) return 'confirm';
  return null;
}

const checkoutNames = /^(结算|去结算)(\s*[（(]\d+[）)])?$/;
const submitNames = /^提交订单$/;
const confirmPayNames = /^立即支付\s*[¥￥]\s*\d[\d,]*(?:\.\d{1,2})?$/;
const paymentNames = /^(立即支付|确认支付|确认付款|立即付款|去支付|付款|支付)(?:\s*[¥￥]\s*\d[\d,]*(?:\.\d{1,2})?)?$/;
const confirmSubmitNames = new RegExp(`(?:${submitNames.source})|(?:${confirmPayNames.source})`);
const tmallSubmitControl = '#submitOrder .trade-buy-btn-submit [class*="btn--"]';

export async function resolveTmallButton(button) {
  const handle = await button.evaluateHandle((element, selector) => element.closest(selector) || element, tmallSubmitControl);
  return handle.asElement();
}

function isOrderCreation(kind, name, info) {
  return kind === 'confirm' && !info.payment && (submitNames.test(name) || (info.orderReview && confirmPayNames.test(name)));
}

async function label(button) {
  return button.evaluate(element => (element.innerText || element.value || element.textContent || element.getAttribute('aria-label') || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim());
}

async function inspectDocument(page) {
  return page.evaluate(() => {
    // Navigation can expose the new URL before its document body exists.
    // Treat that interval as loading, not an invalid order or payment page.
    if (!document.body) return { loading: true };
    const shown = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const text = document.body.innerText;
    if ([...document.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"], iframe[src*="captcha"], iframe[src*="login"]')].some(shown)
      || /请完成验证|拖动滑块|扫码登录|请先登录/.test(text)) return { blocked: '需要登录或验证码，请手动处理' };
    if ([...document.querySelectorAll('[role="alert"]')].some(element => shown(element) && element.innerText.trim())) return { blocked: '页面有提示，请手动核查库存和订单信息' };
    if ([...document.querySelectorAll('input,select,textarea')].some(element => shown(element) && !element.disabled
      && ((element.willValidate && !element.validity.valid) || (element.getAttribute('aria-required') === 'true' && !element.value?.trim())))) return { blocked: '必填信息尚未完整，请核对地址和配送选项' };
    const totals = [...text.matchAll(/(?:合计|实付款|应付总额|商品总价)\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/g)].map(match => Number(match[1].replaceAll(',', '')));
    return { total: totals.at(-1), orderReview: /确认收货地址/.test(text) && /确认订单信息/.test(text) && /付款详情/.test(text), payment: /收银台|订单支付|等待买家付款/.test(text), submitted: /订单提交成功|订单已提交/.test(text) };
  });
}

export async function checkTmallAction(page, button, { submitOrder = false } = {}) {
  const kind = pageKind(page.url());
  const name = await label(button);
  const info = await inspectDocument(page);
  if (info.loading) throw new Error('订单页面正在加载，请等待页面显示完整后再运行');
  const createsOrder = isOrderCreation(kind, name, info);
  if (!createsOrder && /支付|付款/.test(name)) throw new Error('付款需要你本人操作，请绑定结算或提交订单按钮');
  if (!createsOrder && !(kind === 'cart' && checkoutNames.test(name))) throw new Error('天猫自动流程只支持淘宝购物车的结算或确认订单页的提交订单，请重新绑定');
  if (kind === 'confirm' && !submitOrder) throw new Error('请开启自动提交订单，或在浏览器中手动提交');
  if (info.blocked) throw new Error(info.blocked);
  if (!(info.total > 0)) throw new Error('未能确认大于 0 的订单金额；请选中有货商品并核对合计金额');
  return kind;
}

async function visibleActions(page, names) {
  // Exact text also covers merchant controls implemented as a div/span.
  const locator = page.getByRole('button', { name: names }).or(page.getByRole('link', { name: names })).or(page.getByText(names, { exact: true }))
    .or(page.locator(tmallSubmitControl).filter({ hasText: names }));
  const visible = [];
  for (const candidate of await locator.all()) {
    const nestedLabel = await candidate.evaluate((element, selector) => {
      const control = element.closest(`button,a,[role="button"],${selector}`);
      return control && control !== element;
    }, tmallSubmitControl);
    if (!nestedLabel && await candidate.isVisible()) visible.push(candidate);
  }
  return visible;
}

// The bound cart click is issued by the worker. This follows only the known
// confirmation page, preserving defaults. Its amount-labelled “立即支付”
// creates the order; controls on the cashier/payment page remain manual.
export async function continueTmallCheckout(page, run, report, { submitOrder = false, submitted = false, timeoutMs = 45000, pollMs = 200, getPage = () => page, progress = {}, retryDelays, queueTimeoutMs } = {}) {
  submitted = progress.submitted ||= submitted;
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.cancelled) return { state: 'handoff', message: '已停止后续步骤，请核查当前订单；已发出的点击无法撤回' };
    page = getPage();
    if (page.isClosed()) return { state: 'handoff', message: '页面已关闭，请核查订单' };
    try {
      const url = new URL(page.url());
      if (url.protocol === 'https:' && (url.hostname === 'alipay.com' || url.hostname.endsWith('.alipay.com'))) {
        return { state: 'paymentReady', message: '已到支付宝页面，请本人核对订单金额并完成付款' };
      }
      if (!isTmallURL(url.href)) {
        if (url.href === 'about:blank') { await wait(pollMs); continue; }
        return { state: 'handoff', message: '页面已离开淘宝/天猫，自动操作已停止，请手动核查' };
      }
      const notice = await inspectNotice(page);
      if (notice) {
        const recovery = await recoverNotice(page, notice, run, progress, submitted ? 'submit' : progress.pending, report, { retryDelays, queueTimeoutMs });
        if (recovery.stop) return { state: submitted ? 'uncertain' : 'handoff', message: recovery.stop };
        if (recovery.waiting) { deadline = Date.now() + timeoutMs; await wait(pollMs); continue; }
        if (recovery.retry) { progress.retryCart = true; deadline = Date.now() + timeoutMs; }
      } else { progress.queueStarted = undefined; progress.queueReported = false; }
      const info = await inspectDocument(page);
      if (info.loading) { await wait(pollMs); continue; }
      // The cart may navigate while its document is being inspected. Never
      // classify the new confirmation document using the old cart URL.
      if (page.url() !== url.href) continue;
      if (info.blocked) return { state: 'handoff', message: info.blocked };
      const kind = pageKind(url.href);
      if (kind === 'cart' && progress.retryCart && !submitted) {
        const cartButtons = await visibleActions(page, checkoutNames);
        if (cartButtons.length !== 1) return { state: 'handoff', message: '重试结算按钮不明确，请手动核查' };
        await checkTmallAction(page, cartButtons[0], { submitOrder });
        if (run.cancelled) continue;
        progress.retryCart = false;
        await cartButtons[0].click({ timeout: 1500, noWaitAfter: true });
        await wait(pollMs);
        continue;
      } else if (kind !== 'cart') progress.retryCart = false;
      const buttons = [];
      if (kind === 'confirm' && !info.payment) {
        for (const candidate of await visibleActions(page, confirmSubmitNames)) {
          if (isOrderCreation(kind, await label(candidate), info)) buttons.push(candidate);
        }
      }
      // A payment label can render before the confirmation headings/control.
      // On this route it is not proof that an order has already been created.
      if (info.payment || ((kind !== 'confirm' || submitted) && !buttons.length && (await visibleActions(page, paymentNames)).length)) return { state: 'paymentReady', message: '已到付款页面，请本人核对订单和金额并点击支付' };
      if (submitted && info.submitted) return { state: 'orderSubmitted', message: '页面显示订单已提交，请手动查看订单并完成付款' };
      if (kind === 'confirm') {
        if (buttons.length > 1) return { state: 'handoff', message: '发现多个提交订单按钮，请手动选择' };
        if (buttons.length === 1) {
          if (!submitOrder) return { state: 'reviewOrder', message: '已到确认订单页，请核对商品、地址和金额后手动提交' };
          if (!submitted && await buttons[0].isEnabled()) {
            await checkTmallAction(page, buttons[0], { submitOrder });
            if (run.cancelled) continue;
            // Mark before clicking. A timeout or unchanged page never retries.
            submitted = progress.submitted = true;
            progress.pending = 'submit';
            report('正在提交订单一次；付款由你本人完成');
            try { await buttons[0].click({ timeout: 1500, noWaitAfter: true }); }
            catch { return { state: 'uncertain', message: '订单提交结果不明确，请核查订单；不会重复提交' }; }
          }
        }
      }
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) return { state: submitted ? 'uncertain' : 'handoff', message: `已暂停，请手动核查：${error.message}` };
    }
    await wait(pollMs);
  }
  return { state: submitted ? 'uncertain' : 'handoff', message: submitted ? '已发出提交订单点击，但未确认结果；请核查订单，不会重复提交' : '等待确认订单页面超时，请手动处理当前页面' };
}
