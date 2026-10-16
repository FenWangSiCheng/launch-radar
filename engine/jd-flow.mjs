import { setTimeout as wait } from 'node:timers/promises';
import { selectAllCartItems, resolveSelectAllButton, isSelectAllButton } from './cart-selection.mjs';
import { inspectNotice, recoverNotice, recoverSubmissionDialog } from './checkout-recovery.mjs';

export function isJDURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'jd.com' || url.hostname.endsWith('.jd.com'));
  } catch { return false; }
}

export function isJDCartURL(value) { return pageKind(value) === 'cart'; }

function pageKind(value) {
  if (!isJDURL(value)) return null;
  const url = new URL(value);
  if (url.hostname === 'cart.jd.com' && /^\/(cart_index\/?|cart\.(action|html))$/.test(url.pathname)) return 'cart';
  if (url.hostname === 'trade.jd.com' && url.pathname === '/shopping/order/getOrderInfo.action') return 'confirm';
  return null;
}

function isPaymentURL(value) {
  const url = new URL(value);
  return url.protocol === 'https:' && ['pcashier.jd.com', 'cashier.jd.com', 'pay.jd.com', 'cashier.jdpay.com'].includes(url.hostname);
}

const checkoutNames = /^(去结算|结算)(\s*[（(]\s*\d+\s*[）)])?$/;
const immediatePayNames = /^立即支付(?:\s*[¥￥]\s*\d[\d,]*(?:\.\d{1,2})?)?$/;
const paymentNames = /^(立即支付|确认支付|确认付款|立即付款|去支付|付款|支付)(?:\s*[¥￥]\s*\d[\d,]*(?:\.\d{1,2})?)?$/;
// The current JD cart is a div with a nested count, not a native button.
const jdControls = '[class*="_submitBtn_"], #order-submit, .payment-action-submit button';

export async function resolveJDButton(button) {
  const handle = await button.evaluateHandle((element, selector) => element.closest(selector) || element, jdControls);
  return resolveSelectAllButton(handle.asElement());
}

async function label(button) {
  return button.evaluate(element => (element.innerText || element.value || element.textContent || element.getAttribute('aria-label') || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim());
}

async function inspectDocument(page, button) {
  const inspect = element => {
    if (!document.body) return { loading: true };
    const shown = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const text = document.body.innerText;
    if (/操作太频繁|操作过于频繁|访问过于频繁|请求过于频繁/.test(text)) return { blocked: '京东提示操作太频繁，请停止刷新，稍后手动恢复购物车；自动结账已暂停' };
    if (/购物车跑丢了/.test(text)) return { blocked: '京东购物车数据加载失败，请先在浏览器恢复商品列表，再运行' };
    if ([...document.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"], iframe[src*="captcha"], iframe[src*="login"]')].some(shown)
      || /请完成验证|拖动滑块|扫码登录|请先登录|手机扫码安全登录/.test(text)) return { blocked: '需要登录或验证码，请手动处理' };
    // JD can display the payment QR code in-place, keeping the same URL and
    // the original submit button. This is already the manual payment stage.
    const scanPayment = [...document.querySelectorAll('[class*="scantoPayMain"]')].some(element => shown(element)
      && /微信APP扫码支付|支付宝.*扫码支付/.test(element.innerText || '')
      && [...element.querySelectorAll('img[class*="qRCoodeImage"], img[alt*="付款码"], img[alt*="二维码"], canvas')].some(shown));
    if (scanPayment) return { documentURL: location.href, payment: true, paymentExpired: /二维码已过期|二维码已失效/.test(text) };
    if ([...document.querySelectorAll('[role="alert"]')].some(element => shown(element) && element.innerText.trim())) return { blocked: '页面有提示，请手动核查库存和订单信息' };
    if ([...document.querySelectorAll('input,select,textarea')].some(element => shown(element) && !element.disabled
      && ((element.willValidate && !element.validity.valid) || (element.getAttribute('aria-required') === 'true' && !element.value?.trim())))) return { blocked: '必填信息尚未完整，请核对地址和配送选项' };
    const integratedPayment = [...document.querySelectorAll('.payment-action-submit button')].some(element => shown(element) && /立即支付/.test(element.innerText));
    const integratedLayout = Boolean(document.querySelector('.payment-action-submit')) || /结算页支付功能升级/.test(text) && /付款详情/.test(text);
    // The checkout upgrade notice mentions the original cashier. Only a
    // visible status/heading identifies payment, not an occurrence in prose.
    const payment = /收银台|收银员台|订单支付|等待付款|等待买家付款/.test(text) && [...document.querySelectorAll('h1,h2,h3,[role="heading"],div,p,span')].some(element => {
      if (!shown(element) || element.closest('[role="dialog"], [aria-modal="true"], dialog[open], .ui-dialog')) return false;
      const status = element.innerText?.trim() || '';
      return /^(?:京东)?(?:收银台|收银员台|订单支付)(?:\s|$)|^(?:订单)?(?:等待付款|等待买家付款)(?:\s|$)/.test(status);
    });
    return { documentURL: location.href, integratedPayment, integratedLayout, payment, submitted: /订单提交成功|订单已提交|订单创建成功|感谢您.*提交订单/.test(text),
      name: element ? (element.innerText || element.value || element.textContent || element.getAttribute('aria-label') || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : undefined,
      integratedControl: element?.matches('.payment-action-submit button') || false };
  };
  return button ? button.evaluate(inspect) : page.evaluate(inspect);
}

export async function prepareJDAction(page, button, options = {}, run = { cancelled: false }) {
  const cart = pageKind(page.url()) === 'cart';
  if (cart) {
    if (button) await checkJDAction(page, button, { ...options, binding: true });
    const selectAll = button ? await isSelectAllButton(button) : false;
    await selectAllCartItems(page, run, selectAll ? button : undefined);
  }
  const deadline = Date.now() + 1500;
  while (true) {
    if (run.cancelled) throw new Error('已停止结算');
    if (cart) {
      const buttons = await visibleActions(page, checkoutNames);
      if (buttons.length > 1) throw new Error('全选后结算按钮不明确，请重新绑定');
      button = buttons[0];
    }
    if (button) {
      const kind = await checkJDAction(page, button, options);
      if (await button.isEnabled()) return options.returnKind ? { button, kind } : button;
    }
    if (Date.now() >= deadline) throw new Error('全选后结算按钮仍不可用，请核查商品是否可购买');
    await wait(30);
  }
}

// Cart stock is loaded after navigation. Refresh for at most one minute, then
// select all and resolve the current checkout control without using a stale
// bound element from the previous document.
export async function prepareJDCartAtRelease(page, run, report = () => {}, { timeoutMs = 60000, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (run.cancelled) throw new Error('已停止刷新京东购物车');
    if (page.refreshURL) await page.refreshURL();
    if (!isJDCartURL(page.url())) throw new Error('页面已离开京东购物车，已停止自动结算');
    attempts++;
    if (attempts === 1 || attempts % 5 === 0) report(`正在刷新京东购物车并尝试全选（第 ${attempts} 次，最多 1 分钟）`);
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(8000, Math.max(1000, deadline - Date.now())) });
    } catch (error) {
      if (!/Timeout|ERR_ABORTED|刷新页面超时/.test(error.message)) throw error;
      continue;
    }
    const loadDeadline = Math.min(deadline, Date.now() + 2000);
    while (Date.now() < loadDeadline) {
      if (run.cancelled) throw new Error('已停止刷新京东购物车');
      const info = await inspectDocument(page);
      if (info.documentURL && !isJDCartURL(info.documentURL)) throw new Error('页面已离开京东购物车，已停止自动结算');
      if (info.blocked) throw new Error(info.blocked);
      if (!info.loading) {
        try {
          return await prepareJDAction(page, undefined, { returnKind: true }, run);
        } catch (error) {
          if (!/未找到购物车全选按钮|全选未生效|结算按钮仍不可用|按钮已禁用|Timeout/.test(error.message)) throw error;
        }
      }
      await wait(Math.min(pollMs, Math.max(1, loadDeadline - Date.now())));
    }
  }
  throw new Error('刷新京东购物车已持续 1 分钟，商品仍不可选或无法结算；请手动核查库存');
}

export async function checkJDAction(page, button, { binding = false } = {}) {
  const url = page.url();
  const kind = pageKind(url);
  const info = await inspectDocument(page, button);
  const name = info.name;
  if (info.loading) throw new Error('订单页面正在加载，请等待页面显示完整后再运行');
  if (info.blocked) throw new Error(info.blocked);
  const integratedPay = kind === 'confirm' && info.integratedPayment && immediatePayNames.test(name)
    && info.integratedControl;
  if (/支付|付款/.test(name) && !integratedPay) throw new Error('付款需要你本人操作；自动点击只支持京东商品结算页的立即支付');
  if (!(kind === 'cart' && (checkoutNames.test(name) || binding && name === '全选')) && !integratedPay) throw new Error('京东自动流程只支持购物车的全选、去结算或商品结算页的立即支付，请重新绑定');
  if (info.payment || info.submitted || (info.integratedPayment && !integratedPay)) throw new Error('当前页面需要本人核查订单和付款，请勿自动提交');
  // Inspecting can race a navigation. A check is valid only on the same route.
  if (page.url() !== url || info.documentURL && info.documentURL !== url) throw new Error('页面已变化，请重新绑定按钮');
  return integratedPay ? 'pay' : kind;
}

async function visibleActions(page, names) {
  const locator = page.getByRole('button', { name: names }).or(page.getByRole('link', { name: names })).or(page.getByText(names, { exact: true }))
    .or(page.locator(jdControls).filter({ hasText: names }));
  // Filter all candidates within one page evaluation. Safari otherwise makes
  // several Apple Event round trips for every candidate and nested text node.
  const token = await locator.evaluateAll((elements, { selector, pattern }) => {
    const names = new RegExp(pattern.source, pattern.flags);
    const visible = elements.filter(element => {
      const control = element.closest(`button,a,[role="button"],${selector}`);
      if (control && control !== element) return false;
      if (!element.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
      const text = (element.innerText || element.value || element.textContent || element.getAttribute('aria-label') || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      return names.test(text);
    });
    const token = `jd-action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    visible.forEach(element => element.setAttribute('data-radar-jd-action', token));
    return token;
  }, { selector: jdControls, pattern: { source: names.source, flags: names.flags } });
  return page.locator(`[data-radar-jd-action="${token}"]`).all();
}

function clickWasNotSent(error) {
  return /^(目标按钮已失效(?:，请重新绑定)?|目标按钮未启用、隐藏或被遮挡)$/.test(error.message);
}

export async function continueJDCheckout(page, run, report, { timeoutMs = 45000, pollMs = 200, getPage = () => page, progress = {}, checkoutRetryWindowMs = 60000, queueTimeoutMs, submissionRetryDelayMs, submissionRetryWindowMs = 60000 } = {}) {
  let deadline = Date.now() + timeoutMs;
  let unrecognizedPay = false;
  while (Date.now() < deadline) {
    if (run.cancelled) return { state: 'handoff', message: '已停止后续步骤，请核查当前订单；已发出的点击无法撤回' };
    page = getPage();
    if (page.isClosed()) return { state: 'handoff', message: '页面已关闭，请核查订单' };
    try {
      if (page.refreshURL) await page.refreshURL();
      const url = page.url();
      if (url === 'about:blank') { await wait(pollMs); continue; }
      if (isPaymentURL(url)) return { state: 'paymentReady', message: '已到京东付款页面，请本人核对订单和金额并完成付款' };
      if (!isJDURL(url)) return { state: 'handoff', message: '页面已离开京东，自动操作已停止，请手动核查' };
      const kind = pageKind(url);
      // A QR payment modal stays on the confirmation URL with the original
      // submit button behind it. Recognize it before dialog recovery can
      // dismiss the modal and authorize another order submission.
      const snapshot = await inspectDocument(page);
      if (page.url() !== url || snapshot.documentURL && snapshot.documentURL !== url) continue;
      if (snapshot.payment) return { state: 'paymentReady', message: snapshot.paymentExpired
        ? '已到京东扫码付款页面，二维码已过期；请本人在页面重新获取并完成付款'
        : '已到京东扫码付款页面，请本人核对订单和金额并扫码付款' };
      if (kind === 'cart' && progress.retryDeadlines?.cart && Date.now() >= progress.retryDeadlines.cart) return { state: 'handoff', message: '去结算错误已重试 1 分钟，请核查购物车' };
      if (progress.submissionRetryDeadlineAt && Date.now() >= progress.submissionRetryDeadlineAt) return { state: 'uncertain', message: '立即支付弹框已重试 1 分钟，请核查订单' };
      if (progress.submitted && kind === 'confirm') {
        if (!snapshot.submitted) {
          const recovery = await recoverSubmissionDialog(page, run, progress, report, { submissionRetryDelayMs, submissionRetryWindowMs });
          if (recovery?.stop) return { state: 'uncertain', message: recovery.stop };
          if (recovery?.retry) { progress.retrySubmission = true; deadline = progress.submissionRetryDeadlineAt; }
        }
      }
      const notice = await inspectNotice(page, { checkoutErrors: kind === 'cart' && progress.pending === 'cart' });
      if (notice) {
        const recovery = await recoverNotice(page, notice, run, progress, progress.submitted ? 'submit' : progress.pending, report, { retryWindowMs: checkoutRetryWindowMs, queueTimeoutMs });
        if (recovery.stop) return { state: progress.submitted ? 'uncertain' : 'handoff', message: recovery.stop };
        if (recovery.waiting) { deadline = Date.now() + timeoutMs; await wait(pollMs); continue; }
        if (recovery.retry) { progress.retryCart = true; deadline = Date.now() + timeoutMs; }
      } else { progress.queueStarted = undefined; progress.queueReported = false; }
      const info = await inspectDocument(page);
      if (info.loading) { await wait(pollMs); continue; }
      if (page.url() !== url || info.documentURL && info.documentURL !== url) continue;
      if (info.blocked) return { state: 'handoff', message: info.blocked };
      if (info.payment) return { state: 'paymentReady', message: info.paymentExpired
        ? '已到京东扫码付款页面，二维码已过期；请本人在页面重新获取并完成付款'
        : '已到京东扫码付款页面，请本人核对订单和金额并扫码付款' };
      if (progress.submitted && info.submitted) return { state: 'orderSubmitted', message: '页面显示订单已提交，请手动查看订单并完成付款' };
      if (kind === 'cart' && progress.retryCart && !progress.submitted) {
        const buttons = await visibleActions(page, checkoutNames);
        if (buttons.length !== 1) return { state: 'handoff', message: '重试结算按钮不明确，请手动核查' };
        const retryButton = await prepareJDAction(page, buttons[0], {}, run);
        if (run.cancelled) continue;
        if (progress.retryDeadlines?.cart && Date.now() >= progress.retryDeadlines.cart) return { state: 'handoff', message: '去结算错误已重试 1 分钟，请核查购物车' };
        progress.retryCart = false;
        await retryButton.click({ timeout: 1500, noWaitAfter: true });
      } else if (kind !== 'cart') progress.retryCart = false;
      if (kind === 'confirm') {
        const payments = await visibleActions(page, paymentNames);
        if (info.integratedPayment) {
          const payButtons = [];
          for (const button of await page.locator('.payment-action-submit button').all()) {
            if (await button.isVisible() && immediatePayNames.test(await label(button))) payButtons.push(button);
          }
          if (payButtons.length !== 1) return { state: 'handoff', message: '立即支付按钮不明确，请手动核查' };
          // On this confirmation page, “立即支付” creates the order before
          // handing payment to the user. Only dialog recovery permits a retry.
          if ((!progress.submitted || progress.retrySubmission) && await payButtons[0].isEnabled()) {
            if (progress.retrySubmission && Date.now() >= progress.submissionRetryDeadlineAt) return { state: 'uncertain', message: '立即支付弹框已重试 1 分钟，请核查订单' };
            await checkJDAction(page, payButtons[0]);
            if (run.cancelled) continue;
            const previous = { payClicked: progress.payClicked, submitted: progress.submitted, pending: progress.pending, retrySubmission: progress.retrySubmission };
            progress.payClicked = progress.submitted = true;
            progress.pending = 'submit';
            progress.retrySubmission = false;
            report('正在点击京东立即支付，保留已选地址和付款方式；遇到弹框时最多重试 1 分钟，后续付款由你本人完成');
            try { await payButtons[0].click({ timeout: 1500, noWaitAfter: true }); }
            catch (error) {
              if (clickWasNotSent(error)) {
                Object.assign(progress, previous);
                report('京东立即支付按钮在点击前失效，正在重新识别页面');
                continue;
              }
              return { state: 'uncertain', message: `立即支付点击结果不明确（${error.message}）；请核查订单，不会重复点击` };
            }
          }
        } else if (info.integratedLayout || payments.length) {
          // The pay button can mount after the preceding document inspection.
          // Refresh the snapshot before treating a partially loaded page as
          // an unknown payment control, rather than stopping on the first frame.
          unrecognizedPay = true;
          await wait(pollMs);
          continue;
        }
      } else if (!kind) return { state: progress.submitted ? 'uncertain' : 'handoff', message: '当前不是已知的京东购物车或结算页，请手动核查订单' };
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) return { state: progress.submitted ? 'uncertain' : 'handoff', message: `已暂停，请手动核查：${error.message}` };
    }
    await wait(pollMs);
  }
  if (pageKind(page.url()) === 'cart' && progress.retryDeadlines?.cart && Date.now() >= progress.retryDeadlines.cart) return { state: 'handoff', message: '去结算错误已重试 1 分钟，请核查购物车' };
  return { state: progress.submitted ? 'uncertain' : unrecognizedPay ? 'reviewOrder' : 'handoff', message: progress.submissionRetryDeadlineAt && Date.now() >= progress.submissionRetryDeadlineAt ? '立即支付弹框已重试 1 分钟，请核查订单' : progress.payClicked ? '已点击立即支付，但未确认结果；请核查订单，不会重复点击' : unrecognizedPay ? '等待页面加载后仍未识别立即支付按钮，请手动核查当前页面' : '等待京东结算页面超时，请手动处理当前页面' };
}
