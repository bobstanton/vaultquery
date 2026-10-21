export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const operation = this.tail.then(work);
    this.tail = operation.catch(() => {});

    return operation;
  }

  async waitForIdle(...others: SerialQueue[]): Promise<void> {
    const queues = [this, ...others];
    let pending: Promise<unknown>[];

    do {
      pending = queues.map(queue => queue.tail);
      await Promise.all(pending);
    } while (queues.some((queue, index) => queue.tail !== pending[index]));
  }
}
