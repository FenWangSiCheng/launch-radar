// Explicit live integration test: real Safari + project scheduler + checkout
// engine. Never submits an order; run only with --live-checkout.
import { SafariPage } from '../engine/safari.mjs';
import { Scheduler } from '../engine/scheduler.mjs';
import { continueAppleCheckout, initialAppleProgress } from '../engine/apple-flow.mjs';
import { setTimeout as wait } from 'node:timers/promises';

if (!process.argv.includes('--live-checkout')) {
  throw new Error('真实官网测试需显式指定 --live-checkout；本测试始终在下单前停止');
}
const resumeWindow = process.argv.find(value => value.startsWith('--resume-window='))?.split('=')[1];
if (resumeWindow) {
  if (!/^\d+$/.test(resumeWindow)) throw new Error('窗口编号无效');
  const page = new SafariPage(resumeWindow);
  const outcome = await continueAppleCheckout(page, {cancelled:false}, message => console.log(JSON.stringify({message})), {submitOrder:false});
  console.log(JSON.stringify({outcome,url:page.url(),windowID:page.windowID}));
  process.exit(outcome.state === 'reviewOrder' ? 0 : 1);
}
const page = await SafariPage.open('https://www.apple.com.cn/shop/bag');
let button;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  const buttons = await page.getByRole('button', { name: /^结账$/ }).all();
  const visible = [];
  for (const candidate of buttons) if (await candidate.isVisible()) visible.push(candidate);
  if (visible.length) {
    const targets = await Promise.all(visible.map(candidate => candidate.evaluate(element => JSON.stringify({ href: element.getAttribute('href'), action: element.closest('form')?.getAttribute('action') ?? null }))));
    if (new Set(targets).size !== 1) throw new Error('存在不同结账入口，停止测试');
    button = visible[0];
    break;
  }
  await wait(200);
}
if (!button) throw new Error('购物袋未显示结账按钮');
let outcome;
const scheduler = new Scheduler({ emit: event => console.log(JSON.stringify(event)) });
await scheduler.arm([{ page, button }], Date.now() + 2000,
  async task => {
    await task.button.click({ trial: true });
    await initialAppleProgress(task.button, task.page.url());
  },
  async task => {
    const progress = await initialAppleProgress(task.button, task.page.url());
    await task.button.click();
    outcome = await continueAppleCheckout(task.page, scheduler.run, message => console.log(JSON.stringify({ message })), { progress, submitOrder: false });
    console.log(JSON.stringify({ outcome, url: task.page.url(), windowID: task.page.windowID }));
  });
while (scheduler.run) await wait(200);
if (!outcome || outcome.state !== 'reviewOrder') process.exitCode = 1;
