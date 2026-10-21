import type { Database } from 'sql.js';

export type SyncHandler = (...args: unknown[]) => number;

const syncHandlers: Map<string, SyncHandler> = new Map();

export function registerSyncHandler(name: string, handler: SyncHandler): void {
  syncHandlers.set(name, handler);
}

export function clearSyncHandlers(): void {
  syncHandlers.clear();
}

export function registerSyncBridge(db: Database): void {
  db.create_function('_vq_sync', (type: string, arg1: unknown, arg2: unknown, arg3: unknown, arg4: unknown) => {
    const handler = syncHandlers.get(type);

    if (handler) {
      const args = [arg1, arg2, arg3, arg4].filter(a => a !== undefined);

      return handler(...args);
    }

    return 0;
  });
}
