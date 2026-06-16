type TimerKey = string;

interface DomEventRegistration<K extends keyof DocumentEventMap = keyof DocumentEventMap> {
  target: Document;
  type: K;
  listener: (event: DocumentEventMap[K]) => void;
  options?: AddEventListenerOptions;
}

interface ElementEventRegistration<K extends keyof HTMLElementEventMap = keyof HTMLElementEventMap> {
  target: HTMLElement;
  type: K;
  listener: (event: HTMLElementEventMap[K]) => void;
  options?: AddEventListenerOptions;
}

type EventRegistration = DomEventRegistration | ElementEventRegistration;

export class LifecycleManager {
  private intervals = new Map<TimerKey, number>();
  private timeouts = new Map<TimerKey, number>();
  private events: EventRegistration[] = [];

  public setInterval(key: TimerKey, handler: () => void, delayMs: number): void {
    this.clearInterval(key);
    this.intervals.set(key, window.setInterval(handler, delayMs));
  }

  public clearInterval(key: TimerKey): void {
    const interval = this.intervals.get(key);
    if (interval === undefined) {
      return;
    }

    window.clearInterval(interval);
    this.intervals.delete(key);
  }

  public setTimeout(key: TimerKey, handler: () => void, delayMs: number): void {
    this.clearTimeout(key);
    this.timeouts.set(key, window.setTimeout(() => {
      this.timeouts.delete(key);
      handler();
    }, delayMs));
  }

  public clearTimeout(key: TimerKey): void {
    const timeout = this.timeouts.get(key);
    if (timeout === undefined) {
      return;
    }

    window.clearTimeout(timeout);
    this.timeouts.delete(key);
  }

  public addDomEvent<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void;
  public addDomEvent<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void;
  public addDomEvent(target: Document | HTMLElement, type: string, listener: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(type, listener, options);
    this.events.push({ target, type, listener, options } as EventRegistration);
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

    for (const event of this.events) {
      event.target.removeEventListener(
        event.type,
        event.listener as EventListener,
        event.options
      );
    }
    this.events = [];
  }
}
