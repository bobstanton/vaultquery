export interface EventRef<EventName extends string = string> {
  /** @internal */
  _event: EventName;
  /** @internal */
  _listener: EventListener;
}

type EventCallback<Payload> = (event: Payload) => void;

export class EventBus<Events extends object> {
  private target = new EventTarget();
  private eventNames = new Set<keyof Events & string>();
  private currentErrorHandler: ((error: unknown) => void) | null = null;

  public constructor(eventNames: Array<keyof Events & string>) {
    for (const eventName of eventNames) {
      this.eventNames.add(eventName);
    }
  }

  public on<EventName extends keyof Events & string>(
    event: EventName,
    callback: EventCallback<Events[EventName]>
  ): EventRef<EventName> {
    const eventName: string = event;
    if (!this.eventNames.has(event)) {
      throw new Error(`Unknown event: ${eventName}`);
    }

    const listener: EventListener = (domEvent) => {
      try {
        callback((domEvent as CustomEvent<Events[EventName]>).detail);
      }
      catch (error) {
        this.currentErrorHandler?.(error);
      }
    };
    this.target.addEventListener(event, listener);
    return { _event: event, _listener: listener };
  }

  public off(ref: EventRef): void {
    this.target.removeEventListener(ref._event, ref._listener);
  }

  public emit<EventName extends keyof Events & string>(
    event: EventName,
    data: Events[EventName],
    onError?: (error: unknown) => void
  ): void {
    if (!this.eventNames.has(event)) {
      return;
    }

    this.currentErrorHandler = onError ?? null;
    try {
      this.target.dispatchEvent(new CustomEvent(event, { detail: data }));
    }
    finally {
      this.currentErrorHandler = null;
    }
  }
}
