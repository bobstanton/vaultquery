import type { TableProviderStatus } from '../Providers/TableProviderTypes';

export const PROVIDER_WAIT_CEILING_MS = 30_000;

const WAITING_LABELS: Partial<Record<NonNullable<TableProviderStatus['snapshotState']>, string>> = {
  pending: 'Loading',
  refreshing: 'Refreshing',
};

export interface ProviderWaitingHandle {
  stop(): void;
}

export function isProviderTableArriving(status: TableProviderStatus | undefined, waitedMs: number): boolean {
  if (!status || status.lastError || waitedMs >= PROVIDER_WAIT_CEILING_MS) return false;

  return status.snapshotState === 'pending' || status.snapshotState === 'refreshing';
}

export function renderProviderWaiting(container: HTMLElement, status: TableProviderStatus, startedAt: number): ProviderWaitingHandle {
  container.empty();
  const waiting = container.createDiv({ cls: 'vaultquery-loading vaultquery-provider-waiting' });
  waiting.createDiv({ cls: 'vaultquery-loading-spinner' });
  const action = WAITING_LABELS[status.snapshotState ?? 'pending'] ?? 'Loading';

  waiting.createDiv({ cls: 'vaultquery-loading-text',
    text: `${action} ${status.tableName} from ${status.displayName}...` });

  const elapsed = waiting.createDiv({ cls: 'vaultquery-provider-waiting-elapsed' });
  const view = container.ownerDocument.defaultView ?? window;

  const tick = () => {
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    elapsed.setText(seconds < 1 ? '' : `${seconds}s`);
  };

  tick();
  const timer = view.setInterval(tick, 1000);

  return { stop: () => view.clearInterval(timer) };
}

export function renderProviderFreshness(container: HTMLElement, statuses: readonly TableProviderStatus[]): void {
  const dated = statuses.filter(status => status.snapshotState === 'stale' || status.snapshotState === 'refreshing');
  if (!dated.length) return;
  const refreshing = dated.some(status => status.snapshotState === 'refreshing');
  const times = dated.flatMap(status => status.dataAsOf ?? []);
  const oldest = times.length ? Math.min(...times) : undefined;

  const parts = [oldest === undefined ? 'Showing stored data' : `Data from ${formatDataAge(oldest)}`];
  if (refreshing) parts.push('refreshing...');
  const notice = container.createDiv({ cls: 'vaultquery-provider-freshness' });
  notice.setText(parts.join('; '));
  notice.setAttr('title', dated.map(status => `${status.tableName}: ${status.snapshotState}`).join('\n'));
}

function formatDataAge(dataAsOf: number): string {
  const date = new Date(dataAsOf);
  if (Number.isNaN(date.getTime())) return 'an earlier refresh';
  const sameDay = new Date().toDateString() === date.toDateString();

  return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString();
}
