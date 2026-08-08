import { OrchestrationError } from "./contracts.js";

interface QueueItem<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface ResourcePoolSnapshot {
  active: number;
  queued: number;
  maximum_active: number;
  maximum_queue: number;
  completed: number;
  rejected: number;
}

export class BoundedResourcePool {
  private active = 0;
  private completed = 0;
  private rejected = 0;
  private readonly queue: Array<QueueItem<unknown>> = [];

  constructor(private readonly maximumActive: number, private readonly maximumQueue: number) {
    if (!Number.isSafeInteger(maximumActive) || maximumActive < 1 || maximumActive > 64 || !Number.isSafeInteger(maximumQueue) || maximumQueue < 0 || maximumQueue > 10_000) throw new OrchestrationError("ORCHESTRATION_POOL_INVALID", "Resource pool bounds are invalid.");
  }

  snapshot(): ResourcePoolSnapshot {
    return { active: this.active, queued: this.queue.length, maximum_active: this.maximumActive, maximum_queue: this.maximumQueue, completed: this.completed, rejected: this.rejected };
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new OrchestrationError("ORCHESTRATION_CANCELLED", "Queued work was cancelled before admission.");
    if (this.active < this.maximumActive) return await this.execute(work);
    if (this.queue.length >= this.maximumQueue) {
      this.rejected += 1;
      throw new OrchestrationError("ORCHESTRATION_BACKPRESSURE", "Resource pool queue is full; caller must retry later instead of spawning more work.");
    }
    return await new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = { run: work, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        item.abort = () => {
          const index = this.queue.indexOf(item as QueueItem<unknown>);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new OrchestrationError("ORCHESTRATION_CANCELLED", "Queued work was cancelled."));
        };
        signal.addEventListener("abort", item.abort, { once: true });
      }
      this.queue.push(item as QueueItem<unknown>);
    });
  }

  private async execute<T>(work: () => Promise<T>): Promise<T> {
    this.active += 1;
    try { return await work(); }
    finally {
      this.active -= 1;
      this.completed += 1;
      this.pump();
    }
  }

  private pump(): void {
    while (this.active < this.maximumActive && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.abort && item.signal) item.signal.removeEventListener("abort", item.abort);
      if (item.signal?.aborted) { item.reject(new OrchestrationError("ORCHESTRATION_CANCELLED", "Queued work was cancelled.")); continue; }
      void this.execute(item.run).then(item.resolve, item.reject);
    }
  }
}
