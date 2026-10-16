import { setTimeout as wait } from 'node:timers/promises';
import { selectAllCartItems, resolveSelectAllButton, isSelectAllButton } from './cart-selection.mjs';
import { inspectNotice, recoverNotice, recoverSubmissionDialog } from './checkout-recovery.mjs';

export function isTmallURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['taobao.com', 'tmall.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

export function isTmallCartURL(value) { return pageKind(value) === 'cart'; }

function pageKind(value) {
  if (!isTmallURL(value)) return null;
  const url = new URL(value);
  if (url.hostname === 'cart.taobao.com' && /^\/cart\.htm$/.test(url.pathname)) return 'cart';
  if (['buy.taobao.com', 'buy.tmall.com'].includes(url.hostname) && /confirm[_-]?order|order\/confirm/i.test(url.pathname)) return 'confirm';
  return null;
}

function isPaymentURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'alipay.com' || url.hostname.endsWith('.alipay.com'));
  } catch { return false; }
}

const checkoutNames = /^(结算|去结算)(\s*[（(]\s*\d+\s*[）)])?$/;
const submitNames = /^提交订单$/;
// The confirmation page labels its order-creating control with the cart total,
// e.g. “立即支付 ￥12,999.00”; the amount changes with the selected goods.
const immediatePayNames = /^立即支付(?:\s*[¥￥]\s*\d[\d,]*(?:\.\d{1,2})?)?$/;
const paymentNames = /^(立即支付|确认支付|确认付款|立即付款|去支付|付款|支付)(?:\s*[¥￥]\s*\d[\d,]*(?:\.\d{1,2})?)?$/;
const submitOrderNames = new RegExp(`(?:${submitNames.source})|(?:${immediatePayNames.source})`);
// The live confirmation page submits through this trade-buy control.
const tmallSubmitControl = '#submitOrder .trade-buy-btn-submit [class*="btn--"]';
const tmallSubmitLayout = '#submitOrder .trade-buy-btn-submit';

export async function resolveTmallButton(button) {
  const handle = await button.evaluateHandle((element, selector) => element.closest(selector) || element, tmallSubmitControl);
  return resolveSelectAllButton(handle.asElement());
}

// “立即支付” on the confirmation page creates the order. The legacy
// “提交订单” button does the same; neither is the cashier's pay button.
function isOrderCreation(kind, name, info) {
  if (kind !== 'confirm' || info.payment) return false;
  if (submitNames.test(name)) return true;
  return immediatePayNames.test(name) && Boolean(info.orderReview || info.submitLayout || info.submitControl);
}

async function label(button) {
  return button.evaluate(element => (element.innerText || element.value || element.textContent || element.getAttribute('aria-label') || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim());
}

async function inspectDocument(page, button) {
  const inspect = element => {
    // Navigation can expose the new URL before its document body exists.
    // Treat that interval as loading, not an invalid order or payment page.
    if (!document.body) return { loading: true };
    const shown = node => Boolean(node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
    const text = document.body.innerText;
    if (/操作太频繁|操作过于频繁|访问过于频繁|请求过于频繁/.test(text)) return { blocked: '淘宝提示操作太频繁，请停止刷新，稍后手动恢复购物车；自动结账已暂停' };
    if ([...document.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"], iframe[src*="captcha"], iframe[src*="login"]')].some(shown)
      || /请完成验证|拖动滑块|扫码登录|请先登录|手机扫码安全登录/.test(text)) return { blocked: '需要登录或验证码，请手动处理' };
    if ([...document.querySelectorAll('[role="alert"]')].some(node => shown(node) && node.innerText.trim())) return { blocked: '页面有提示，请手动核查库存和订单信息' };
    if ([...document.querySelectorAll('input,select,textarea')].some(node => shown(node) && !node.disabled
      && ((node.willValidate && !node.validity.valid) || (node.getAttribute('aria-required') === 'true' && !node.value?.trim())))) return { blocked: '必填信息尚未完整，请核对地址和配送选项' };
    const totals = [...text.matchAll(/(?:合计|实付款|应付总额|商品总价)\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/g)].map(match => Number(match[1].replaceAll(',', '')));
    // Literals, not module constants: this function runs inside the page.
    const submitLayout = '#submitOrder .trade-buy-btn-submit';
    return { documentURL: location.href, total: totals.at(-1),
      submitLayout: Boolean(document.querySelector(submitLayout)),
      submitControl: Boolean(element?.closest(submitLayout)),
      orderReview: /确认收货地址/.test(text) && /确认订单信息/.test(text) && /付款详情/.test(text),
      payment: /收银台|订单支付|等待买家付款/.test(text), submitted: /订单提交成功|订单已提交/.test(text),
      name: element ? (element.innerText || element.value || element.textContent || element.getAttribute('aria-label') || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : undefined };
  };
  return button ? button.evaluate(inspect) : page.evaluate(inspect);
}

export async function prepareTmallAction(page, button, options = {}, run = { cancelled: false }) {
  const cart = pageKind(page.url()) === 'cart';
  if (cart) {
    if (button) await checkTmallAction(page, button, { ...options, binding: true });
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
      try {
        const kind = await checkTmallAction(page, button, options);
        if (await button.isEnabled()) return options.returnKind ? { button, kind } : button;
      } catch (error) {
        // Selecting all updates the readable total asynchronously; keep polling
        // briefly instead of failing on the first frame.
        if (!/大于 0/.test(error.message) || Date.now() >= deadline) throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error('全选后结算按钮仍不可用，请核查商品是否可购买');
    await wait(30);
  }
}

// The cart receives stock/checkability from its query.bag response. A visible
// countdown does not fetch a fresh cart, so reload until selection and
// checkout become available. Never click checkout here; the worker guards that.
export async function prepareTmallCartAtRelease(page, run, report = () => {}, { timeoutMs = 60000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (run.cancelled) throw new Error('已停止刷新淘宝购物车');
    if (page.refreshURL) await page.refreshURL();
    if (!isTmallCartURL(page.url())) throw new Error('页面已离开淘宝购物车，已停止自动结算');
    attempts++;
    if (attempts === 1 || attempts % 5 === 0) report(`正在刷新淘宝购物车并尝试全选（第 ${attempts} 次，最多 1 分钟）`);
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(8000, Math.max(1000, deadline - Date.now())) });
    } catch (error) {
      if (!/Timeout|ERR_ABORTED|刷新页面超时/.test(error.message)) throw error;
      continue;
    }
    const loadDeadline = Math.min(deadline, Date.now() + 2000);
    while (Date.now() < loadDeadline) {
      if (run.cancelled) throw new Error('已停止刷新淘宝购物车');
      const info = await inspectDocument(page);
      if (info.documentURL && !isTmallCartURL(info.documentURL)) throw new Error('页面已离开淘宝购物车，已停止自动结算');
      if (info.blocked) throw new Error(info.blocked);
      if (!info.loading) {
        try {
          return await prepareTmallAction(page, undefined, { returnKind: true }, run);
        } catch (error) {
          if (!/未找到购物车全选按钮|全选未生效|结算按钮仍不可用|按钮已禁用|未能确认大于 0|Timeout/.test(error.message)) throw error;
        }
      }
      await wait(Math.min(pollMs, Math.max(1, loadDeadline - Date.now())));
    }
  }
  throw new Error('刷新淘宝购物车已持续 1 分钟，商品仍不可选或无法结算；请手动核查库存');
}

export async function checkTmallAction(page, button, { binding = false } = {}) {
  const url = page.url();
  const kind = pageKind(url);
  const info = await inspectDocument(page, button);
  const name = info.name;
  if (info.loading) throw new Error('订单页面正在加载，请等待页面显示完整后再运行');
  if (info.blocked) throw new Error(info.blocked);
  const createsOrder = isOrderCreation(kind, name, info);
  if (/支付|付款/.test(name) && !createsOrder) throw new Error('付款需要你本人操作；自动点击只支持淘宝结算页的立即支付');
  if (!(kind === 'cart' && (checkoutNames.test(name) || binding && name === '全选')) && !createsOrder) throw new Error('淘宝自动流程只支持购物车的全选、结算或结算页的立即支付，请重新绑定');
  if (info.payment || info.submitted || (info.submitLayout && !createsOrder)) throw new Error('当前页面需要本人核查订单和付款，请勿自动提交');
  if (!(binding && kind === 'cart') && !(info.total > 0)) throw new Error('未能确认大于 0 的订单金额；请选中有货商品并核对合计金额');
  // Inspecting can race a navigation. A check is valid only on the same route.
  if (page.url() !== url || info.documentURL && info.documentURL !== url) throw new Error('页面已变化，请重新绑定按钮');
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

function clickWasNotSent(error) {
  return /^(目标按钮已失效(?:，请重新绑定)?|目标按钮未启用、隐藏或被遮挡)$/.test(error.message);
}

// The bound cart click is issued by the worker. This follows only the known
// confirmation page, preserving defaults. Its “立即支付 ￥xxx” (or the legacy
// “提交订单”) creates the order; controls on the cashier/payment page stay
// manual. Errors and dialogs retry like JD: at most one minute per stage.
export async function continueTmallCheckout(page, run, report, { timeoutMs = 45000, pollMs = 200, getPage = () => page, progress = {}, checkoutRetryWindowMs = 60000, queueTimeoutMs, submissionRetryDelayMs, submissionRetryWindowMs = 60000 } = {}) {
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
      if (isPaymentURL(url)) return { state: 'paymentReady', message: '已到支付宝页面，请本人核对订单金额并完成付款' };
      if (!isTmallURL(url)) return { state: 'handoff', message: '页面已离开淘宝/天猫，自动操作已停止，请手动核查' };
      const kind = pageKind(url);
      const snapshot = await inspectDocument(page);
      if (page.url() !== url || snapshot.documentURL && snapshot.documentURL !== url) continue;
      if (kind === 'cart' && progress.retryDeadlines?.cart && Date.now() >= progress.retryDeadlines.cart) return { state: 'handoff', message: '去结算错误已重试 1 分钟，请核查购物车' };
      if (progress.submissionRetryDeadlineAt && Date.now() >= progress.submissionRetryDeadlineAt) return { state: 'uncertain', message: '立即支付弹框已重试 1 分钟，请核查订单' };
      // An in-page cashier keeps the confirmation URL. Recognize that payment
      // state before dialog recovery could dismiss its modal and authorize
      // another order submission.
      if (progress.submitted && kind === 'confirm' && !snapshot.submitted && !snapshot.payment) {
        const recovery = await recoverSubmissionDialog(page, run, progress, report, { submissionRetryDelayMs, submissionRetryWindowMs });
        if (recovery?.stop) return { state: 'uncertain', message: recovery.stop };
        if (recovery?.retry) { progress.retrySubmission = true; deadline = progress.submissionRetryDeadlineAt; }
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
      if (info.payment) return { state: 'paymentReady', message: '已到付款页面，请本人核对订单和金额并点击支付' };
      if (progress.submitted && info.submitted) return { state: 'orderSubmitted', message: '页面显示订单已提交，请手动查看订单并完成付款' };
      if (kind === 'cart' && progress.retryCart && !progress.submitted) {
        const buttons = await visibleActions(page, checkoutNames);
        if (buttons.length !== 1) return { state: 'handoff', message: '重试结算按钮不明确，请手动核查' };
        const retryButton = await prepareTmallAction(page, buttons[0], {}, run);
        if (run.cancelled) continue;
        if (progress.retryDeadlines?.cart && Date.now() >= progress.retryDeadlines.cart) return { state: 'handoff', message: '去结算错误已重试 1 分钟，请核查购物车' };
        progress.retryCart = false;
        await retryButton.click({ timeout: 1500, noWaitAfter: true });
      } else if (kind !== 'cart') progress.retryCart = false;
      if (kind === 'confirm') {
        const payments = await visibleActions(page, paymentNames);
        const payButtons = [];
        for (const candidate of await visibleActions(page, submitOrderNames)) {
          if (isOrderCreation(kind, await label(candidate), info)) payButtons.push(candidate);
        }
        if (payButtons.length > 1) return { state: 'handoff', message: '发现多个提交订单按钮，请手动选择' };
        if (payButtons.length === 1) {
          // On this confirmation page “立即支付” and “提交订单” create the order
          // before handing payment to the user. Only dialog recovery permits a retry.
          if ((!progress.submitted || progress.retrySubmission) && await payButtons[0].isEnabled()) {
            if (progress.retrySubmission && Date.now() >= progress.submissionRetryDeadlineAt) return { state: 'uncertain', message: '立即支付弹框已重试 1 分钟，请核查订单' };
            await checkTmallAction(page, payButtons[0]);
            if (run.cancelled) continue;
            const previous = { payClicked: progress.payClicked, submitted: progress.submitted, pending: progress.pending, retrySubmission: progress.retrySubmission };
            progress.payClicked = progress.submitted = true;
            progress.pending = 'submit';
            progress.retrySubmission = false;
            report('正在点击淘宝立即支付，保留已选地址和付款方式；遇到弹框时最多重试 1 分钟，后续付款由你本人完成');
            try { await payButtons[0].click({ timeout: 1500, noWaitAfter: true }); }
            catch (error) {
              if (clickWasNotSent(error)) {
                Object.assign(progress, previous);
                report('淘宝立即支付按钮在点击前失效，正在重新识别页面');
                continue;
              }
              return { state: 'uncertain', message: `立即支付点击结果不明确（${error.message}）；请核查订单，不会重复点击` };
            }
          }
        } else if (payments.length) {
          // The pay control can mount after the preceding document inspection.
          // Refresh the snapshot before treating a partially loaded page as an
          // unknown payment control, rather than stopping on the first frame.
          unrecognizedPay = true;
          await wait(pollMs);
          continue;
        }
      } else if (!kind) return { state: progress.submitted ? 'uncertain' : 'handoff', message: '当前不是已知的淘宝购物车或结算页，请手动核查订单' };
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) return { state: progress.submitted ? 'uncertain' : 'handoff', message: `已暂停，请手动核查：${error.message}` };
    }
    await wait(pollMs);
  }
  if (pageKind(page.url()) === 'cart' && progress.retryDeadlines?.cart && Date.now() >= progress.retryDeadlines.cart) return { state: 'handoff', message: '去结算错误已重试 1 分钟，请核查购物车' };
  return { state: progress.submitted ? 'uncertain' : unrecognizedPay ? 'reviewOrder' : 'handoff', message: progress.submissionRetryDeadlineAt && Date.now() >= progress.submissionRetryDeadlineAt ? '立即支付弹框已重试 1 分钟，请核查订单' : progress.payClicked ? '已点击立即支付，但未确认结果；请核查订单，不会重复点击' : unrecognizedPay ? '等待页面加载后仍未识别立即支付按钮，请手动核查当前页面' : '等待淘宝结算页面超时，请手动处理当前页面' };
}
