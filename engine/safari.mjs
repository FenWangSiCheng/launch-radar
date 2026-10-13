import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';

const exec = promisify(execFile);

// Pass URL and JavaScript as argv data; neither is interpolated into AppleScript.
const script = `on run argv
  tell application "Safari"
    if item 1 of argv is "open" then
      make new document with properties {URL:item 2 of argv}
      return id of front window as text
    end if
    set windowID to item 2 of argv as integer
    if not (exists window id windowID) then error "RADAR_WINDOW_CLOSED"
    set targetWindow to window id windowID
    if (count of tabs of targetWindow) is not 1 then error "RADAR_TABS_CHANGED"
    if item 1 of argv is "evaluate" then
      return do JavaScript (item 3 of argv) in tab 1 of targetWindow
    else if item 1 of argv is "url" then
      return URL of tab 1 of targetWindow
    else if item 1 of argv is "focus" then
      set index of targetWindow to 1
      activate
    else if item 1 of argv is "close" then
      close targetWindow
    end if
  end tell
end run`;

async function command(action, target, source = '') {
  try {
    const { stdout } = await exec('/usr/bin/osascript', ['-e', script, action, String(target), source], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    if (/RADAR_WINDOW_CLOSED/.test(error.stderr || '')) throw new Error('Safari 窗口已关闭，请重新打开页面');
    if (/RADAR_TABS_CHANGED/.test(error.stderr || '')) throw new Error('请保持任务的 Safari 窗口只有一个标签页，再重新绑定');
    if (/-1743|not authorized|not allowed to send Apple events/i.test(error.stderr || '')) throw new Error('请在系统设置 → 隐私与安全性 → 自动化中允许 Launch Radar 控制 Safari');
    if (/JavaScript.*Apple|Apple.*JavaScript|来自 Apple 事件/i.test(error.stderr || '')) throw new Error('请在 Safari 设置 → 高级开启网页开发者功能，再在开发者设置中开启「允许来自 Apple 事件的 JavaScript」');
    throw new Error('Safari 操作失败，请检查自动化权限及「允许来自 Apple 事件的 JavaScript」设置');
  }
}

// This small adapter implements only the DOM operations used by Launch Radar.
// It deliberately rejects iframe targets and never guesses another window/tab.
export class SafariPage {
  constructor(windowID, transport = command) {
    this.windowID = windowID;
    this.transport = transport;
    this.currentURL = '';
    this.closed = false;
  }
  static async open(url) {
    const page = new SafariPage(await command('open', url));
    page.currentURL = url;
    await page.bringToFront();
    return page;
  }
  url() { return this.currentURL; }
  isClosed() { return this.closed; }
  async refreshURL() {
    try { this.currentURL = await this.transport('url', this.windowID); }
    catch (error) { if (error.message.includes('已关闭')) this.closed = true; throw error; }
    return this.currentURL;
  }
  async bringToFront() { await this.transport('focus', this.windowID); }
  async close() {
    if (!this.closed) await this.transport('close', this.windowID);
    this.closed = true;
  }
  async evaluate(fn, arg) {
    const source = `JSON.stringify((() => { try { return {ok:true, value:(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})}; } catch(e) { return {ok:false, error:e.message}; } })())`;
    const result = JSON.parse(await this.transport('evaluate', this.windowID, source));
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  frames() { return [this]; }
  async $(selector) { return (await this.locator(selector).all())[0]; }
  locator(selector) { return new SafariLocator(this, [{ selector }]); }
  getByRole(role, { name }) {
    return new SafariLocator(this, [{ role, name: name instanceof RegExp ? { source: name.source, flags: name.flags } : { text: name } }]);
  }
}

class SafariLocator {
  constructor(page, queries) { this.page = page; this.queries = queries; }
  or(other) { return new SafariLocator(this.page, [...this.queries, ...other.queries]); }
  async all() {
    const ids = await this.page.evaluate(queries => {
      const registry = window.__radarRegistry ??= { elements: new Map(), ids: new WeakMap(), nonce: `${Date.now()}-${Math.random()}`, next: 0 };
      const found = new Set();
      for (const query of queries) {
        const selector = query.selector || (query.role === 'button' ? 'button, input[type="submit"], input[type="button"], [role="button"]' : 'a[href], [role="link"]');
        for (const element of document.querySelectorAll(selector)) {
          if (!query.selector) {
            const role = element.getAttribute('role');
            if (role && role !== query.role) continue;
            const label = element.getAttribute('aria-label') || element.innerText || element.textContent || element.value || '';
            if (query.name.source ? !new RegExp(query.name.source, query.name.flags).test(label.trim()) : label.trim() !== query.name.text) continue;
          }
          found.add(element);
        }
      }
      return [...found].map(element => {
        if (!registry.ids.has(element)) {
          const id = `${registry.nonce}-${registry.next++}`;
          registry.ids.set(element, id); registry.elements.set(id, element);
        }
        return registry.ids.get(element);
      });
    }, this.queries);
    return ids.map(id => new SafariElement(this.page, id));
  }
  async innerText() { const element = (await this.all())[0]; if (!element) throw new Error('找不到目标按钮'); return element.innerText(); }
}

class SafariElement {
  constructor(page, id) { this.page = page; this.id = id; }
  async evaluate(fn) {
    const evaluateElement = new Function('id', `
      const element = window.__radarRegistry?.elements.get(id);
      if (!element) throw new Error('目标按钮已失效，请重新绑定');
      return (${fn.toString()})(element);
    `);
    return this.page.evaluate(evaluateElement, this.id);
  }

  async innerText() { return this.evaluate(element => element.innerText || element.value || ''); }
  async getAttribute(name) {
    return this.page.evaluate(({ id, name }) => {
      const element = window.__radarRegistry?.elements.get(id);
      if (!element) throw new Error('目标按钮已失效');
      return element.getAttribute(name);
    }, { id: this.id, name });
  }
  async isVisible() { return this.evaluate(element => element.isConnected && Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden'); }
  async isEnabled() { return this.evaluate(element => !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true'); }
  async click({ trial = false, timeout = 1500 } = {}) {
    const end = Date.now() + timeout;
    do {
      const state = await this.page.evaluate(({ id, trial }) => {
        const element = window.__radarRegistry?.elements.get(id);
        if (!element?.isConnected) throw new Error('目标按钮已失效，请重新绑定');
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const style = getComputedStyle(element);
        if (!element.getClientRects().length || style.visibility === 'hidden' || style.pointerEvents === 'none' || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return false;
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
        if (!hit || !(hit === element || element.contains(hit))) return false;
        if (!trial) element.click();
        return true;
      }, { id: this.id, trial });
      if (state) return;
      await wait(50);
    } while (Date.now() < end);
    throw new Error('目标按钮未启用、隐藏或被遮挡');
  }
}

export function browserChoice(command) {
  if (command.browser !== undefined && !['safari', 'chrome'].includes(command.browser)) throw new Error('请选择 Safari 或 Chrome');
  // Legacy protocol callers and automated demos remain on Chrome.
  return command.browser || 'chrome';
}

export function pickScript() {
  return () => {
    window.__radarCleanup?.();
    window.__radarPicked = null;
    const banner = document.createElement('div');
    banner.textContent = 'Launch Radar · 点击目标按钮进行绑定（此次不会下单） · Esc 取消 · 仅支持当前页面按钮';
    Object.assign(banner.style, { position: 'fixed', top: '16px', left: '16px', right: '16px', zIndex: '2147483647', padding: '16px', background: '#23221f', color: 'white', borderRadius: '8px', font: '16px system-ui', pointerEvents: 'none' });
    document.documentElement.appendChild(banner);
    let highlighted, outline;
    const clear = () => { if (highlighted) highlighted.style.outline = outline; };
    function move(event) { clear(); highlighted = event.target.closest('button, a, input[type="submit"], input[type="button"], [role="button"]') || event.target; outline = highlighted.style.outline; highlighted.style.outline = '3px solid #C65B32'; }
    function cleanup() { clear(); banner.remove(); document.removeEventListener('click', click, true); document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointermove', move, true); document.removeEventListener('keydown', key, true); delete window.__radarCleanup; }
    function click(event) {
      event.preventDefault(); event.stopImmediatePropagation();
      const element = event.target.closest('button, a, input[type="submit"], input[type="button"], [role="button"]') || event.target;
      const token = `r${Date.now()}${Math.random().toString(16).slice(2)}`;
      element.setAttribute('data-launch-radar', token);
      window.__radarPicked = { token, url: location.href };
      cleanup();
    }
    function down(event) { if (event.target.closest(':disabled')) click(event); }
    function key(event) { if (event.key === 'Escape') { window.__radarPicked = { cancelled: true }; cleanup(); } }
    document.addEventListener('click', click, true); document.addEventListener('pointerdown', down, true); document.addEventListener('pointermove', move, true); document.addEventListener('keydown', key, true);
    window.__radarCleanup = cleanup;
  };
}
