import { performance } from 'node:perf_hooks';

// Wall-clock deadlines are converted once to a monotonic deadline.
export class Scheduler {
  constructor({ now = () => performance.now(), wallNow = () => Date.now(), emit = () => {} } = {}) {
    this.now = now;
    this.wallNow = wallNow;
    this.emit = emit;
    this.run = null;
  }

  async arm(tasks, target, prepare, execute) {
    if (this.run) throw new Error('已有倒计时正在运行');
    if (!tasks.length || !Number.isFinite(target) || target - this.wallNow() < 1000) {
      throw new Error('请选择任务，并设置至少一秒后的时间');
    }
    const run = { target, deadline: this.now() + target - this.wallNow(), cancelled: false, timer: null, fired: false };
    this.run = run;
    try {
      await Promise.all(tasks.map(prepare));
      if (run.cancelled) return;
      if (run.deadline <= this.now()) throw new Error('准备检查耗时过长，请重新设置时间');
      run.dispatch = (immediate = false) => {
        if (run.cancelled || run.fired) return;
        clearTimeout(run.timer);
        run.fired = true;
        if (immediate) run.target = this.wallNow();
        const lateness = immediate ? 0 : this.now() - run.deadline;
        if (lateness > 500) {
          this.emit({ type: 'error', message: '系统暂停或调度延迟超过 500ms，已取消此次提交' });
          this.finish(run);
          return;
        }
        this.emit({ type: 'triggered', immediate });
        // Issue each task independently; never await one platform before starting another.
        Promise.allSettled(tasks.map(task => execute(task, run, lateness)))
          .then(() => this.finish(run));
      };
      this.emit({ type: 'armed', target });
      const tick = () => {
        if (run.cancelled) return;
        const remaining = run.deadline - this.now();
        if (remaining > 0) {
          run.timer = setTimeout(tick, remaining > 1000 ? Math.min(remaining - 500, 1000) : Math.min(remaining, 4));
          return;
        }
        run.dispatch();
      };
      tick();
    } catch (error) {
      this.finish(run);
      throw error;
    }
  }

  finish(run) {
    if (this.run !== run) return;
    this.run = null;
    this.emit({ type: 'finished' });
  }

  async resume(task, prepare, execute) {
    if (this.run) throw new Error('已有操作正在运行');
    const run = { target: this.wallNow(), cancelled: false, fired: false, timer: null };
    this.run = run;
    try {
      await prepare(task);
      if (run.cancelled) return;
      run.fired = true;
      this.emit({ type: 'armed', immediate: true });
      await execute(task, run);
    } finally { this.finish(run); }
  }

  triggerNow() {
    const run = this.run;
    if (!run?.dispatch || run.cancelled || run.fired) throw new Error('当前没有可提前运行的定时任务');
    run.dispatch(true);
  }

  async runNow(tasks, prepare, execute) {
    if (this.run) throw new Error('已有操作正在运行');
    if (!tasks.length) throw new Error('请选择任务');
    const run = { target: this.wallNow(), cancelled: false, fired: false, timer: null };
    this.run = run;
    try {
      await Promise.all(tasks.map(prepare));
      if (run.cancelled) return;
      run.target = this.wallNow();
      run.fired = true;
      this.emit({ type: 'armed', immediate: true });
      this.emit({ type: 'triggered', immediate: true });
      await Promise.allSettled(tasks.map(task => execute(task, run, 0)));
    } finally { this.finish(run); }
  }

  cancel() {
    const run = this.run;
    if (!run) return;
    run.cancelled = true;
    clearTimeout(run.timer);
    this.emit({ type: 'cancelled', message: run.fired ? '已停止剩余操作；已发出的点击无法撤回，请检查订单' : '倒计时已停止' });
    // Do not allow a new run while an issued action is still resolving.
    if (!run.fired) this.finish(run);
  }
}
