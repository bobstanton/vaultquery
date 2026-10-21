export interface KeyedRun<T> {
  token: number;
  promise: Promise<T>;
}

export class LatestRuns<T> {
  private readonly tokens = new Map<string, number>();
  private readonly inFlight = new Map<string, KeyedRun<T>>();

  public constructor(private readonly commit: (key: string, value: T) => Promise<void>) {}

  public current(key: string): KeyedRun<T> | undefined {
    return this.inFlight.get(key);
  }

  public isLatest(key: string, token: number): boolean {
    return this.tokens.get(key) === token;
  }

  public start(key: string, execute: () => Promise<T>): KeyedRun<T> {
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);

    const promise = (async () => {
      const value = await execute();

      if (this.isLatest(key, token)) {
        await this.commit(key, value);
      }

      return value;
    })();

    const run = { token, promise };
    this.inFlight.set(key, run);
    const release = (): void => { if (this.inFlight.get(key) === run) this.inFlight.delete(key); };
    promise.then(release, release);

    return run;
  }

  public async settle(key: string, run: KeyedRun<T>): Promise<T | null> {
    let current: KeyedRun<T> | undefined = run;

    while (current) {
      try {
        const value = await current.promise;
        if (this.isLatest(key, current.token)) return value;
      }
      catch (error: unknown) {
        if (this.isLatest(key, current.token)) throw error;
      }

      const newer = this.inFlight.get(key);
      current = newer !== current ? newer : undefined;
    }

    return null;
  }
}
