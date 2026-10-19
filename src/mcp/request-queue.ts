/** A fixed per-server bound, shared by individual requests and JSON-RPC batches. */
export class RequestQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  readonly concurrency: number;
  readonly capacity: number;
  constructor(concurrency = 4, capacity = 32) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(capacity) || capacity < 0) throw new Error('Invalid request queue limits.');
    this.concurrency = concurrency; this.capacity = capacity;
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Request cancelled.');
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.capacity) throw new Error('Server busy: request queue is full.');
      await new Promise<void>((resolve, reject) => {
        const start = () => { signal?.removeEventListener('abort', abort); this.active++; resolve(); };
        const abort = () => {
          const index = this.waiting.indexOf(start);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error('Request cancelled before execution.'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        this.waiting.push(start);
      });
    } else this.active++;
    try {
      if (signal?.aborted) throw new Error('Request cancelled before execution.');
      const result = await work();
      if (signal?.aborted) throw new Error('Request cancelled; an already running operation may have completed. Inspect state before retrying.');
      return result;
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
