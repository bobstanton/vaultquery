import { Events } from 'obsidian';
import type { EventRef } from 'obsidian';

export type { EventRef };

type EventCallback<Payload> = (event: Payload) => void;

export class EventBus<EventMap extends object> {
  private events = new Events();
  private eventNames: Set<string>;

  public constructor(
    eventNames: Array<keyof EventMap & string>,
    private onListenerError?: (event: string, error: unknown) => void
  ) {
    this.eventNames = new Set(eventNames);
  }

  public on<EventName extends keyof EventMap & string>(
    event: EventName,
    callback: EventCallback<EventMap[EventName]>
  ): EventRef {
    if (!this.eventNames.has(event)) {
      throw new Error(`Unknown event: ${event}`);
    }

    return this.events.on(event, (...data: unknown[]) => {
      try {
        callback(data[0] as EventMap[EventName]);
      }
      catch (error) {
        this.onListenerError?.(event, error);
      }
    });
  }

  public off(ref: EventRef): void {
    this.events.offref(ref);
  }

  public emit<EventName extends keyof EventMap & string>(
    event: EventName,
    data: EventMap[EventName]
  ): void {
    if (!this.eventNames.has(event)) {
      return;
    }

    this.events.trigger(event, data);
  }
}
