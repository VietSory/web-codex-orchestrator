import type { JobMode } from "../orchestration/job-mode.js";

export interface InteractiveTaskSnapshot {
  mode: JobMode;
  goal: string;
  pause_requested: boolean;
}

interface ActiveInteractiveTask {
  token: symbol;
  mode: JobMode;
  goal: string;
  controller: AbortController;
  pauseRequested: boolean;
  promise: Promise<void>;
  pauseAtSafeBoundary?: () => Promise<void>;
}

export interface StartInteractiveTaskOptions {
  mode: JobMode;
  goal: string;
  run(signal: AbortSignal): Promise<string>;
  pauseAtSafeBoundary?: () => Promise<void>;
}

export class InteractiveTaskSlot {
  private activeTask: ActiveInteractiveTask | null = null;

  constructor(private readonly write: (value: string) => void) {}

  snapshot(): InteractiveTaskSnapshot | null {
    const task = this.activeTask;
    return task ? { mode: task.mode, goal: task.goal, pause_requested: task.pauseRequested } : null;
  }

  isActive(): boolean {
    return this.activeTask !== null;
  }

  start(options: StartInteractiveTaskOptions): { started: boolean; message: string } {
    if (this.activeTask) {
      return {
        started: false,
        message: `${this.activeTask.mode} is already running. Use /status, /review, or /pause before starting another task.`,
      };
    }

    const controller = new AbortController();
    const token = Symbol("interactive-task");
    const task: ActiveInteractiveTask = {
      token,
      mode: options.mode,
      goal: options.goal,
      controller,
      pauseRequested: false,
      promise: Promise.resolve(),
      ...(options.pauseAtSafeBoundary ? { pauseAtSafeBoundary: options.pauseAtSafeBoundary } : {}),
    };
    this.activeTask = task;

    task.promise = Promise.resolve()
      .then(async () => await options.run(controller.signal))
      .then((message) => {
        if (message) this.write(`\n${message}\n`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.write(`\n${options.mode} stopped safely.\n${message}\nNothing was merged. Use /status and /doctor for the next step.\n`);
      })
      .finally(() => {
        if (this.activeTask?.token === token) this.activeTask = null;
      });

    return {
      started: true,
      message: `${options.mode} started. The prompt stays available; use /status, /review, or /pause while it runs.`,
    };
  }

  async requestPause(): Promise<string> {
    const task = this.activeTask;
    if (!task) return "No background task is running.";
    if (task.pauseRequested) return "Pause is already requested. WCO will stop after the current safe step.";

    task.pauseRequested = true;
    task.controller.abort();
    try {
      await task.pauseAtSafeBoundary?.();
    } catch (error) {
      task.pauseRequested = false;
      const message = error instanceof Error ? error.message : String(error);
      return `Pause could not be recorded safely: ${message}`;
    }
    return "Pause requested. WCO will finish the current safe step, save progress, and stop before starting another step.";
  }

  async pauseAndWait(): Promise<void> {
    const task = this.activeTask;
    if (!task) return;
    await this.requestPause();
    await task.promise;
  }

  async waitForIdle(): Promise<void> {
    const task = this.activeTask;
    if (task) await task.promise;
  }
}
