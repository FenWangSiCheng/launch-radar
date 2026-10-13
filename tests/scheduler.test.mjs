import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { Scheduler } from '../engine/scheduler.mjs';

test('manual trigger replaces the scheduled dispatch without a second execution', async () => {
  const starts = [], events = [];
  const scheduler = new Scheduler({ emit: event => events.push(event) });
  await scheduler.arm([1, 2], Date.now() + 1050, async () => {}, async (id, run) => {
    starts.push(id);
    assert.ok(Math.abs(Date.now() - run.target) < 100);
    await wait(50);
  });
  scheduler.triggerNow();
  assert.deepEqual(starts, [1, 2]);
  assert.throws(() => scheduler.triggerNow());
  await wait(1150);
  assert.deepEqual(starts, [1, 2]);
  assert.equal(events.filter(event => event.type === 'finished').length, 1);
});

test('immediate run checks all tasks before dispatch and locks out duplicate runs', async () => {
  const starts = [], checked = [];
  const scheduler = new Scheduler();
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const running = scheduler.runNow([1, 2], async id => { checked.push(id); }, async id => {
    assert.deepEqual(checked, [1, 2]);
    starts.push(id);
    await completion;
  });
  await wait(0);
  assert.deepEqual(starts, [1, 2]);
  await assert.rejects(scheduler.runNow([1], async () => {}, async () => {}));
  finish();
  await running;
  assert.equal(scheduler.run, null);
});

test('failed or cancelled immediate preparation never dispatches', async () => {
  const scheduler = new Scheduler();
  let clicks = 0;
  await assert.rejects(scheduler.runNow([1, 2], async id => {
    if (id === 2) throw new Error('stale');
  }, async () => { clicks++; }));
  assert.equal(scheduler.run, null);
  let prepared;
  const preparation = new Promise(resolve => { prepared = resolve; });
  const running = scheduler.runNow([1], () => preparation, async () => { clicks++; });
  assert.throws(() => scheduler.triggerNow());
  scheduler.cancel();
  prepared();
  await running;
  assert.equal(clicks, 0);
  assert.equal(scheduler.run, null);
});

test('rejects past deadlines and empty tasks', async () => {
  const scheduler = new Scheduler();
  await assert.rejects(scheduler.arm([], Date.now() + 2000, async () => {}, async () => {}));
  await assert.rejects(scheduler.arm([1], Date.now(), async () => {}, async () => {}));
  assert.equal(scheduler.run, null);
});

test('parallel dispatch does not wait for a slow platform', async () => {
  const starts = [], events = [];
  const scheduler = new Scheduler({ emit: event => events.push(event) });
  const deadline = Date.now() + 1050;
  await scheduler.arm([1, 2, 3], deadline, async () => {}, async id => {
    starts.push({ id, time: Date.now() });
    if (id === 1) await wait(150);
  });
  await wait(1300);
  assert.equal(starts.length, 3);
  assert.ok(Math.max(...starts.map(item => item.time)) - Math.min(...starts.map(item => item.time)) < 25);
  assert.ok(starts.every(item => item.time >= deadline));
  assert.equal(events.filter(item => item.type === 'finished').length, 1);
});

test('cancel prevents dispatch and permits rearming', async () => {
  let clicks = 0;
  const scheduler = new Scheduler();
  await scheduler.arm([1], Date.now() + 1050, async () => {}, async () => { clicks++; });
  scheduler.cancel();
  await wait(1100);
  assert.equal(clicks, 0);
  assert.equal(scheduler.run, null);
});

test('failed preflight prevents all submissions', async () => {
  let clicks = 0;
  const scheduler = new Scheduler();
  await assert.rejects(scheduler.arm([1, 2], Date.now() + 1050, async id => {
    if (id === 2) throw new Error('stale');
  }, async () => { clicks++; }));
  await wait(1100);
  assert.equal(clicks, 0);
  assert.equal(scheduler.run, null);
});

test('duplicate arming is rejected', async () => {
  const scheduler = new Scheduler();
  await scheduler.arm([1], Date.now() + 1050, async () => {}, async () => {});
  await assert.rejects(scheduler.arm([1], Date.now() + 1050, async () => {}, async () => {}));
  scheduler.cancel();
});

test('late wakeup cancels instead of submitting stale tasks', async () => {
  let clock = 0, clicks = 0;
  const events = [];
  const scheduler = new Scheduler({ now: () => clock, wallNow: () => 0, emit: event => events.push(event) });
  await scheduler.arm([1], 1000, async () => {}, async () => { clicks++; });
  clock = 2000;
  await wait(520);
  assert.equal(clicks, 0);
  assert.ok(events.some(event => event.type === 'error'));
});

test('resuming keeps the scheduler locked until remaining steps finish', async () => {
  const scheduler = new Scheduler();
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const resumed = scheduler.resume(1, async () => {}, async (_, run) => {
    await completion;
    assert.equal(run.cancelled, true);
  });
  await wait(0);
  await assert.rejects(scheduler.arm([1], Date.now() + 2000, async () => {}, async () => {}));
  scheduler.cancel();
  assert.ok(scheduler.run, 'issued work must resolve before unlocking');
  complete();
  await resumed;
  assert.equal(scheduler.run, null);
});

test('cancel during resume preparation prevents remaining actions', async () => {
  const scheduler = new Scheduler();
  let clicks = 0;
  let prepared;
  const preparation = new Promise(resolve => { prepared = resolve; });
  const resumed = scheduler.resume(1, () => preparation, async () => { clicks++; });
  scheduler.cancel();
  prepared();
  await resumed;
  assert.equal(clicks, 0);
  assert.equal(scheduler.run, null);
});
