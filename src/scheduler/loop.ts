import { SchedulerRuntime } from "./runner.js";

export type SchedulerLoopOptions = {
  runtime: SchedulerRuntime;
  intervalMs?: number;
};

export class SchedulerLoop {
  private readonly runtime: SchedulerRuntime;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = true;

  constructor(opts: SchedulerLoopOptions) {
    this.runtime = opts.runtime;
    this.intervalMs = opts.intervalMs ?? 30_000;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.runtime.tick();
    } finally {
      this.ticking = false;
    }
  }
}
