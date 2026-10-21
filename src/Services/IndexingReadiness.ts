import type { Events } from 'obsidian';
import type { VaultQueryAPI } from '../VaultQueryAPI';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { VAULTQUERY_API_READY_EVENT } from '../helpers';
import { renderIndexingProgress } from '../utils/IndexingUtils';
import { isBlockUnloaded } from '../CodeBlockProcessors/ProcessorUtils';

interface WaitingQuery {
  container?: HTMLElement;
  loading?: HTMLElement;
  resolve: (api: VaultQueryAPI) => void;
  reject: (error: Error) => void;
}

export class IndexingReadiness {
  private readonly waiting = new Set<WaitingQuery>();
  private api: VaultQueryAPI | null = null;
  private unsubscribe?: () => void;
  private stopListening?: () => void;
  private timer?: number;
  private apiDeadline = 0;
  private disposed = false;

  public constructor(private readonly plugin: VaultQueryPluginContext) {}

  public wait(container?: HTMLElement): Promise<VaultQueryAPI> {
    if (this.disposed) return Promise.reject(new Error('VaultQuery has been unloaded'));
    if (this.plugin.api?.isIndexReady()) return Promise.resolve(this.plugin.api);

    return new Promise<VaultQueryAPI>((resolve, reject) => {
      const loading = container?.createDiv({ cls: 'vaultquery-loading' });
      if (loading) renderIndexingProgress(loading, this.plugin.api?.getIndexingStatus().progress);
      this.waiting.add({ container, loading, resolve, reject });

      if (!this.stopListening) {
        const workspace: Events = this.plugin.app.workspace;
        const ref = workspace.on(VAULTQUERY_API_READY_EVENT, () => this.update());
        this.stopListening = () => workspace.offref(ref);
        this.apiDeadline = Date.now() + 30_000;
        this.timer = window.setInterval(() => this.update(), 500);
      }

      this.update();
    });
  }

  private update(): void {
    const api = this.plugin.api;

    if (api !== this.api) {
      this.unsubscribe?.();
      this.api = api;
      this.unsubscribe = api?.onIndexingChange(() => this.update());
    }

    const ready = api?.isIndexReady();
    const progress = api?.getIndexingStatus().progress;

    for (const entry of this.waiting) {
      if (entry.container && isBlockUnloaded(entry.container)) {
        this.finish(entry, new Error('Query block has been unloaded'));
      } else if (ready && api) {
        this.finish(entry, api);
      } else if (!api && Date.now() >= this.apiDeadline) {
        this.finish(entry, new Error('VaultQuery API did not become available within 30 seconds'));
      } else if (entry.loading) renderIndexingProgress(entry.loading, progress);
    }

    if (!this.waiting.size) this.stop();
  }

  private finish(entry: WaitingQuery, result: VaultQueryAPI | Error): void {
    this.waiting.delete(entry);
    entry.loading?.remove();
    if (result instanceof Error) entry.reject(result);
    else entry.resolve(result);
  }

  private stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.api = null;
    this.stopListening?.();
    this.stopListening = undefined;
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  public dispose(): void {
    this.disposed = true;
    this.stop();
    for (const entry of this.waiting) this.finish(entry, new Error('VaultQuery has been unloaded'));
  }
}
