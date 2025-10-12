export type QueueTask<T> = {
  item: T;
  attempt: number;
};

export type QueueOptions = {
  concurrency?: number; // 最大并发数
  maxRetries?: number; // 最大重试次数
  retryDelayMs?: number; // 重试延迟
};

export class RequestQueue<T> {
  private queue: QueueTask<T>[] = [];
  private running = 0;
  private options: Required<QueueOptions> = {
    concurrency: 8,
    maxRetries: 2,
    retryDelayMs: 100,
  };

  constructor(options?: QueueOptions) {
    if (options) {
      this.options = { ...this.options, ...options };
    }
  }

  enqueue(item: T): void {
    this.queue.push({ item, attempt: 0 });
  }

  enqueueAll(items: T[]): void {
    for (const it of items) this.enqueue(it);
  }

  dequeue(): QueueTask<T> | undefined {
    return this.queue.shift();
  }

  size(): number {
    return this.queue.length;
  }

  async run(
    handler: (item: T, attempt: number) => Promise<void>,
    token?: { isCancellationRequested: boolean }
  ): Promise<void> {
    const workers: Promise<void>[] = [];
    const startWorker = async () => {
      while (!token?.isCancellationRequested) {
        const task = this.dequeue();
        if (!task) break;
        try {
          this.running++;
          await handler(task.item, task.attempt);
        } catch (err) {
          if (task.attempt < this.options.maxRetries && !token?.isCancellationRequested) {
            await new Promise((res) => setTimeout(res, this.options.retryDelayMs));
            this.queue.push({ item: task.item, attempt: task.attempt + 1 });
          }
        } finally {
          this.running--;
        }
      }
    };

    const workerCount = Math.max(1, this.options.concurrency);
    for (let i = 0; i < workerCount; i++) workers.push(startWorker());
    await Promise.all(workers);
  }
}