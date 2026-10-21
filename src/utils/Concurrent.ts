type Completion<T, R> = { index: number; item: T } & ({ ok: true; value: R } | { ok: false; error: unknown });

export async function* mapConcurrent<T, R>(items: Iterable<T>, concurrency: number, map: (item: T, index: number) => Promise<R>,
  cancelled: () => boolean = () => false): AsyncGenerator<{ item: T; index: number; value: R }> {
  const iterator = items[Symbol.iterator]();
  const completed: Completion<T, R>[] = [];
  const limit = Math.max(1, Math.trunc(concurrency) || 1);
  let nextIndex = 0;
  let outstanding = 0;
  let wake: (() => void) | undefined;
  let done = false;
  let stopped = false;

  const finish = (result: Completion<T, R>) => {
    if (stopped) return;
    completed.push(result);
    wake?.();
    wake = undefined;
  };

  const fill = () => {
    while (!done && outstanding < limit && !cancelled()) {
      const next = iterator.next();
      if (next.done) { done = true; break; }
      const item = next.value, index = nextIndex++;
      outstanding++;

      // Work can reject after cancellation, so attach rejection handlers before it starts.
      void Promise.resolve().then(() => map(item, index)).then(
        value => finish({ index, item, ok: true, value }),
        (error: unknown) => finish({ index, item, ok: false, error }),
      );
    }
  };

  try {
    fill();

    while (outstanding) {
      if (!completed.length) await new Promise<void>(resolve => { wake = resolve; });
      if (cancelled()) return;
      const result = completed.shift()!;
      outstanding--;
      if (!result.ok) throw result.error;
      fill();

      yield { item: result.item, index: result.index, value: result.value };
    }
  } finally {
    stopped = true; iterator.return?.();
  }
}

export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);

  for await (const { index, value } of mapConcurrent(items, concurrency, map)) {
    results[index] = value;
  }

  return results;
}
