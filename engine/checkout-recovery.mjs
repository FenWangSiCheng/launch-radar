import { setTimeout as wait } from 'node:timers/promises';

export function isCheckoutErrorText(text) {
  return /失败|错误|异常|繁忙|拥挤|稍后再试|重试/.test(text)
    && !/售罄|无货|缺货|库存不足|登录|验证码|验证身份|滑块|排队|请勿刷新|处理中|成功|已提交|已创建|等待.*付款/.test(text);
}

// Read visible notices, not product descriptions or hidden templates.
export async function inspectNotice(page, { checkoutErrors = false } = {}) {
  if (checkoutErrors && page.radarCheckoutDialog) return { kind: 'retryable', text: page.radarCheckoutDialog, native: true };
  if (page.radarDialog) return { kind: 'blocked', text: `浏览器弹框：${page.radarDialog}` };
  return page.evaluate(checkoutErrors => {
    const shown = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const candidates = [...document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [aria-modal="true"], dialog[open], .form-message-wrapper, .next-dialog, .ant-modal, .el-message-box, .ui-dialog, .next-message, .ant-message-notice')].filter(shown).filter(node => node.getAttribute('role') !== 'status' || /排队|请勿刷新|正在处理|处理中|失败|繁忙|拥挤|异常|错误/.test(node.innerText || node.textContent || ''));
    const nodes = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
    if (!nodes.length) {
      const text = document.body?.innerText?.trim() || '';
      if (text.length < 500 && /排队中|正在排队|请勿刷新/.test(text)) return { kind: 'queue', text };
      return null;
    }
    const text = nodes.map(node => node.innerText || node.textContent || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 800);
    if (!text) return null;
    if (/售罄|无货|缺货|库存不足|登录|验证码|验证身份|滑块/.test(text)) return { kind: 'blocked', text };
    if (/排队中|正在排队|请勿刷新|正在处理|处理中，请稍/.test(text)) return { kind: 'queue', text };
    // Cart errors are retryable after checkout; other flows require explicit failure.
    const checkoutError = checkoutErrors && /失败|错误|异常|繁忙|拥挤|稍后再试|重试/.test(text) && !/成功|已提交|已创建|等待.*付款/.test(text);
    const retryable = checkoutError || /系统繁忙|拥挤|网络异常|服务繁忙/.test(text) && /操作失败|结算失败|请求失败/.test(text) && /重试|稍后再试/.test(text);
    if (nodes.length !== 1) return { kind: 'blocked', text };
    const controls = nodes.flatMap(node => [...node.querySelectorAll('button, [role="button"], [aria-label], .next-dialog-close, .ant-modal-close, .el-message-box__headerbtn, .ui-dialog-close')]).filter(shown).filter(button => /^(确定|知道了|关闭|好|取消|Close|Cancel|OK|×|✕)$/i.test((button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim())
      && !(button.tagName === 'BUTTON' && button.form && button.type === 'submit')
      && (!button.hasAttribute('href') || ['#', ''].includes(button.getAttribute('href'))));
    const closes = controls.filter(button => /^(关闭|取消|Close|Cancel|×|✕)$/i.test((button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim()));
    const dismiss = checkoutErrors && closes.length ? closes : controls;
    if (retryable && dismiss.length === 1) {
      const token = `notice-${Date.now()}`;
      dismiss[0].setAttribute('data-radar-notice', token);
      return { kind: 'retryable', text, token };
    }
    return { kind: 'blocked', text };
  }, checkoutErrors);
}

export async function recoverNotice(page, notice, run, progress, key, report, { retryDelays = [1000, 2000, 4000], queueTimeoutMs = 180000 } = {}) {
  progress.retries ??= {};
  if (notice.kind === 'queue') {
    progress.queueStarted ??= Date.now();
    if (Date.now() - progress.queueStarted >= queueTimeoutMs) return { stop: '排队等待已达上限，请手动核查当前页面' };
    if (!progress.queueReported) { report(`正在等待平台排队：${notice.text}`); progress.queueReported = true; }
    return { waiting: true };
  }
  progress.queueStarted = undefined;
  progress.queueReported = false;
  // Never repeat additions or order submissions based on a generic failure notice.
  if (notice.kind !== 'retryable' || !key || ['addBag', 'submit'].includes(key)) return { stop: `页面提示需要处理：${notice.text}` };
  const attempts = progress.retries[key] || 0;
  if (attempts >= retryDelays.length) return { stop: `已达到 ${retryDelays.length} 次重试上限：${notice.text}` };
  if (run.cancelled) return { stop: '已停止异常恢复' };
  const button = notice.native ? null : await page.$(`[data-radar-notice="${notice.token}"]`);
  if (!notice.native && !button) return { stop: '错误提示已变化，请手动核查' };
  // Consume the allowance before dismissal, including ambiguous click results.
  progress.retries[key] = attempts + 1;
  if (notice.native) page.radarCheckoutDialog = undefined;
  else await button.click({ timeout: 1500, noWaitAfter: true });
  report(`平台明确提示操作失败，准备第 ${attempts + 1}/${retryDelays.length} 次重试：${notice.text}`);
  const end = Date.now() + retryDelays[attempts];
  while (!run.cancelled && Date.now() < end) await wait(Math.min(100, end - Date.now()));
  if (run.cancelled) return { stop: '已停止异常恢复' };
  return { retry: true };
}

// Final-order recovery is explicitly authorized: dismiss a modal regardless of
// its message, then allow one new submission. Keep the budget across resumes.
export async function recoverSubmissionDialog(page, run, progress, report, { submissionRetryDelayMs = 0, submissionRetryLimit = 10 } = {}) {
  const native = page.radarSubmissionDialog;
  const modal = native ? { native: true } : await page.evaluate(() => {
    const shown = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const candidates = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open], .next-dialog, .ant-modal, .el-message-box, .ui-dialog')].filter(shown);
    const nodes = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
    if (!nodes.length) return null;
    if (nodes.length !== 1) return { blocked: true };
    const controls = [...nodes[0].querySelectorAll('button, [role="button"], [aria-label], .next-dialog-close, .ant-modal-close, .el-message-box__headerbtn, .ui-dialog-close')].filter(shown);
    const closes = controls.filter(button => /^(关闭|Close|取消|Cancel|×|✕)$/i.test((button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim()) || button.matches('.next-dialog-close, .ant-modal-close, .el-message-box__headerbtn, .ui-dialog-close'));
    const acknowledgements = controls.filter(button => /^(确定|知道了|好|OK)$/i.test((button.innerText || button.textContent || '').trim()));
    const buttons = closes.length ? closes : acknowledgements;
    if (buttons.length !== 1 || (buttons[0].tagName === 'BUTTON' && buttons[0].form && buttons[0].type === 'submit')) return { blocked: true };
    const token = `submit-dialog-${Date.now()}`;
    buttons[0].setAttribute('data-radar-submit-dialog', token);
    return { token };
  });
  if (!modal) return null;
  if (run.cancelled) return { stop: '已停止订单重试' };
  if (modal.blocked) return { stop: '无法确定弹框关闭按钮，请手动关闭后继续' };
  const attempts = progress.submissionRetries || 0;
  if (attempts >= submissionRetryLimit) return { stop: `已达到 ${submissionRetryLimit} 次订单重试上限，请核查订单` };
  // Consume the attempt before dismissal, so failures cannot reset the budget.
  progress.submissionRetries = attempts + 1;
  if (native) page.radarSubmissionDialog = undefined;
  else {
    const button = await page.$(`[data-radar-submit-dialog="${modal.token}"]`);
    if (!button) return { stop: '弹框已变化，请手动核查' };
    await button.click({ timeout: 1500, noWaitAfter: true });
  }
  report(`已关闭下单弹框，准备第 ${attempts + 1}/${submissionRetryLimit} 次订单重试`);
  const end = Date.now() + submissionRetryDelayMs;
  while (!run.cancelled && Date.now() < end) await wait(Math.min(100, end - Date.now()));
  return run.cancelled ? { stop: '已停止订单重试' } : { retry: true };
}
