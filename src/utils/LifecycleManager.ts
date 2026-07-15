type TimerKey = string;

/**
 * Keyed timers with reschedule-on-repeat semantics, which Obsidian's Component
 * registration does not provide. DOM event listeners go through the platform's
 * Plugin.registerDomEvent instead; only timers live here.
 */
export class LifecycleManager {
  private intervals = new Map<TimerKey, number>();
  private timeouts = new Map<TimerKey, number>();

  public scheduleInterval(key: TimerKey, handler: () => void, delayMs: number): void {
    this.cancelInterval(key);
    this.intervals.set(key, window.setInterval(handler, delayMs));
  }

  public cancelInterval(key: TimerKey): void {
    const interval = this.intervals.get(key);
    if (interval === undefined) {
      return;
    }

    window.clearInterval(interval);
    this.intervals.delete(key);
  }

  public scheduleTimeout(key: TimerKey, handler: () => void, delayMs: number): void {
    this.cancelTimeout(key);
    this.timeouts.set(key, window.setTimeout(() => {
      this.timeouts.delete(key);
      handler();
    }, delayMs));
  }

  public cancelTimeout(key: TimerKey): void {
    const timeout = this.timeouts.get(key);
    if (timeout === undefined) {
      return;
    }

    window.clearTimeout(timeout);
    this.timeouts.delete(key);
  }

  public cleanup(): void {
    for (const interval of this.intervals.values()) {
      window.clearInterval(interval);
    }
    this.intervals.clear();

    for (const timeout of this.timeouts.values()) {
      window.clearTimeout(timeout);
    }
    this.timeouts.clear();
  }
}
