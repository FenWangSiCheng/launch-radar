import { setTimeout as wait } from 'node:timers/promises';

export async function resolveSelectAllButton(button) {
  const handle = await button.evaluateHandle(element => {
    const named = node => (node.getAttribute('aria-label') || node.innerText || node.textContent || '').trim() === '全选';
    const inputLabel = element.matches('input[type="checkbox"]') ? [...element.labels || []].find(named) : null;
    // A named wrapper can have no click handler. Preserve the actual label or
    // checkbox rather than climbing into JD's surrounding select-all div.
    const control = inputLabel || element.closest('label,[role="checkbox"]')
      || [...element.querySelectorAll('label,[role="checkbox"]')].find(named) || element;
    const text = (control.getAttribute('aria-label') || control.innerText || control.textContent || '').trim();
    return text === '全选' ? control : element;
  });
  return handle.asElement();
}

export async function isSelectAllButton(button) {
  return button.evaluate(element => (element.getAttribute('aria-label') || element.innerText || element.textContent || '').trim() === '全选');
}

// Resolve only controls labelled “全选”; never click item/shop checkboxes.
export async function selectAllCartItems(page, run = { cancelled: false }, button) {
  if (button) {
    await button.evaluate(node => {
      document.querySelectorAll('[data-radar-bound-all]').forEach(element => element.removeAttribute('data-radar-bound-all'));
      node.setAttribute('data-radar-bound-all', 'true');
    });
  }
  const inspect = () => page.evaluate(() => {
    const shown = node => Boolean(node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
    const bound = [...document.querySelectorAll('[data-radar-bound-all]')].find(node => shown(node) && (node.getAttribute('aria-label') || node.innerText || node.textContent || '').trim() === '全选');
    const labels = (bound ? [bound] : [...document.querySelectorAll('label,button,a,span,div,input,[role="checkbox"]')]).filter(shown)
      .filter(node => (node.getAttribute('aria-label') || node.innerText || node.textContent || '').trim() === '全选');
    const controls = [...new Set(labels.map(node => node.closest('label,button,a,[role="checkbox"]')
      || [...node.querySelectorAll('label,[role="checkbox"]')].find(element => (element.getAttribute('aria-label') || element.innerText || element.textContent || '').trim() === '全选') || node))]
      .filter(node => !labels.some(other => other !== node && node.contains(other) && other.matches('label,button,a,[role="checkbox"]')));
    const choices = controls.map(node => {
      const input = node.matches('input[type="checkbox"]') ? node : node.querySelector('input[type="checkbox"]');
      const checkbox = node.matches('[role="checkbox"]') ? node : node.querySelector('[role="checkbox"]');
      const aria = (checkbox || node).getAttribute('aria-checked');
      const classSelected = [node, ...node.querySelectorAll('[class]')].some(element => /(?:^|[\s_-])(checked|selected)(?:$|[\s_-])/i.test(element.className || '') && !/(unchecked|unselected)/i.test(element.className || ''));
      const selected = input ? input.checked : aria !== null ? aria === 'true' : classSelected;
      return { node, selected };
    });
    // Carts often repeat select-all at the top and bottom. Prefer the first
    // visible control; either one selects the same cart.
    const choice = choices.find(choice => choice.node.hasAttribute('data-radar-bound-all')) || choices[0];
    if (!choice) return null;
    document.querySelectorAll('[data-radar-select-all]').forEach(node => node.removeAttribute('data-radar-select-all'));
    choice.node.setAttribute('data-radar-select-all', 'true');
    return { selected: choice.selected, bound: choice.node === bound };
  });
  if (run.cancelled) throw new Error('已停止全选');
  const state = await inspect();
  if (!state) throw new Error('未找到购物车全选按钮，请确认购物车页面已加载');
  if (run.cancelled) throw new Error('已停止全选');
  if (state.selected) return;
  const selectAll = state.bound ? button : page.locator('[data-radar-select-all="true"]').first();
  await selectAll.click({ timeout: 1500, noWaitAfter: true });
  const deadline = Date.now() + 1500;
  while (!run.cancelled && Date.now() < deadline) {
    if ((await inspect())?.selected) return;
    await wait(30);
  }
  throw new Error(run.cancelled ? '已停止全选' : '全选未生效，请核查商品是否可购买');
}
