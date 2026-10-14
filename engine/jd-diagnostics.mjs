// Report only endpoint names and error categories, never cookies, request bodies,
// query values, or cart/account data. Observing responses sends no extra requests.
export function observeJDCartRequests(page, report) {
  const reported = new Set();
  const emit = message => {
    if (reported.has(message)) return;
    reported.add(message);
    report(message);
  };
  const endpoint = request => {
    const url = new URL(request.url());
    if (!(url.hostname === 'jd.com' || url.hostname.endsWith('.jd.com'))) return null;
    if (!['xhr', 'fetch'].includes(request.resourceType())) return null;
    const functionID = url.searchParams.get('functionId') || '';
    if (!/cart/i.test(url.pathname + functionID)) return null;
    return url.hostname;
  };
  page.on('requestfailed', request => {
    const host = endpoint(request);
    if (!host) return;
    const reason = request.failure()?.errorText?.match(/net::ERR_[A-Z_]+/)?.[0] || '网络请求失败';
    emit(`京东购物车诊断：${host} ${reason}`);
  });
  page.on('response', async response => {
    const host = endpoint(response.request());
    if (!host) return;
    if (response.status() >= 400) emit(`京东购物车诊断：${host} HTTP ${response.status()}`);
    if (!/json/i.test(response.headers()['content-type'] || '')) return;
    try {
      const data = await response.json();
      const message = [data?.message, data?.msg, data?.errorMessage, data?.result?.message, data?.result?.msg].filter(value => typeof value === 'string').join(' ');
      const category = /频繁|限流/.test(message) ? '接口提示请求频繁，请稍后手动恢复'
        : /登录|登陆/.test(message) ? '接口提示需要重新登录'
        : /验证码|滑块|安全验证|风控/.test(message) ? '接口提示需要手动完成安全验证'
        : /失败|异常|错误|繁忙/.test(message) ? '接口返回业务错误' : null;
      if (!category) return;
      const code = String(data?.code ?? data?.resultCode ?? '').match(/^[-\d]{1,12}$/)?.[0];
      emit(`京东购物车诊断：${host} ${category}${code ? `（代码 ${code}）` : ''}`);
    } catch { /* Non-JSON or closed-page responses are not evidence of a JD block. */ }
  });
}
