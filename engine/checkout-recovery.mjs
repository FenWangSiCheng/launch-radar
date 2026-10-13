import { setTimeout as wait } from 'node:timers/promises';

// Read visible notices, not product descriptions or hidden templates.
export async function inspectNotice(page) {
  if (page.radarDialog) return { kind: 'blocked', text: `浏览器弹框：${page.radarDialog}` };
  return page.evaluate(() => {
    const shown = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const candidates = [...document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [aria-modal="true"], dialog[open], .form-message-wrapper, .next-dialog, .ant-modal, .el-message-box, .next-message, .ant-message-notice')].filter(shown).filter(node => node.getAttribute('role') !== 'status' || /排队|请勿刷新|正在处理|处理中|失败|繁忙|拥挤|异常|错误/.test(node.innerText || node.textContent || ''));
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
    // Congestion alone does not prove an operation failed. Require explicit failure.
    const retryable = /系统繁忙|拥挤|网络异常|服务繁忙/.test(text) && /操作失败|结算失败|请求失败/.test(text) && /重试|稍后再试/.test(text);
    if (nodes.length !== 1) return { kind: 'blocked', text };
    const controls = nodes.flatMap(node => [...node.querySelectorAll('button, [role="button"]')]).filter(shown).filter(button => /^(确定|知道了|关闭|好)$/.test((button.innerText || button.textContent || '').trim())
      && !(button.tagName === 'BUTTON' && button.form && button.type === 'submit')
      && (!button.hasAttribute('href') || ['#', ''].includes(button.getAttribute('href'))));
    if (retryable && controls.length === 1) {
      const token = `notice-${Date.now()}`;
      controls[0].setAttribute('data-radar-notice', token);
      return { kind: 'retryable', text, token };
    }
    return { kind: 'blocked', text };
  });
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
  const button = await page.$(`[data-radar-notice="${notice.token}"]`);
  if (!button) return { stop: '错误提示已变化，请手动核查' };
  // Consume the allowance before dismissal, including ambiguous click results.
  progress.retries[key] = attempts + 1;
  await button.click({ timeout: 1500, noWaitAfter: true });
  report(`平台明确提示操作失败，准备第 ${attempts + 1}/${retryDelays.length} 次重试：${notice.text}`);
  const end = Date.now() + retryDelays[attempts];
  while (!run.cancelled && Date.now() < end) await wait(Math.min(100, end - Date.now()));
  if (run.cancelled) return { stop: '已停止异常恢复' };
  return { retry: true };
}
