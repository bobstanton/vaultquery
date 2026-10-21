import { parseImagePrefix } from './ImageMetadataParser';
import type { ImagePrefixProcessor, ImagePrefixResult } from './ImageMetadataParser';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('Images');
const TIMEOUT_MS = 30_000;
type Reply = { buffer: ArrayBuffer; result: ImagePrefixResult };

async function createWorker(): Promise<Worker> {
  // @ts-expect-error - esbuild-plugin-inline-worker generates the default worker constructor.
  const { default: WorkerImport } = await import('./image.worker');
  const ImageWorker = WorkerImport as { new (): Worker };

  return new ImageWorker();
}

export class ImageMetadataWorker {
  private worker?: Worker;
  private starting?: Promise<void>;
  private failed = false;
  private disposed = false;
  private nextId = 0;
  private cancelStartup?: (error: Error) => void;
  private pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();

  public constructor(private readonly factory: () => Promise<Worker> = createWorker) {}

  public readonly process: ImagePrefixProcessor = async (buffer, extension, size) => {
    if (this.disposed) throw new Error('Image parser was disposed.');

    if (!this.starting && !this.failed && (typeof Worker !== 'undefined' || this.factory !== createWorker)) {
      this.starting = this.start().catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
    }

    await this.starting;
    if (this.disposed) throw new Error('Image parser was disposed.');
    if (!this.worker) return { buffer, result: parseImagePrefix(buffer, extension, size, true) };

    const worker = this.worker, id = ++this.nextId;

    return new Promise<Reply>((resolve, reject) => {
      const timer = window.setTimeout(() => this.fail(new Error('Image parser timed out.')), TIMEOUT_MS);

      this.pending.set(id, {
        resolve: reply => { window.clearTimeout(timer); resolve(reply); },
        reject: error => { window.clearTimeout(timer); reject(error); },
      });

      try {
        worker.postMessage({ id, buffer, extension, size }, [buffer]);
      }
      catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  private async start(): Promise<void> {
    const worker = await this.factory();

    if (this.disposed) { worker.terminate();

 return; }

    this.worker = worker;

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Image parser startup timed out.')), TIMEOUT_MS);
      this.cancelStartup = error => { window.clearTimeout(timer); reject(error); };
      worker.onerror = event => this.fail(new Error(event.message || 'Image parser worker failed.'));
      worker.onmessageerror = () => this.fail(new Error('Image parser returned an unreadable message.'));

      worker.onmessage = (event: MessageEvent<Reply & { id: number; ready?: boolean; error?: string }>) => {
        const reply = event.data;

        if (reply.ready) {
          window.clearTimeout(timer); this.cancelStartup = undefined; resolve();
          logger.debug('Image parser ready', { thread: 'worker' });

 return;
        }

        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        if (reply.error) pending.reject(new Error(reply.error));
        else pending.resolve(reply);
      };
    });
  }

  private fail(error: Error): void {
    if (!this.failed && !this.disposed) logger.warn('Image parser worker unavailable; subsequent reads use the main thread', { error: error.message });
    this.failed = true;
    this.cancelStartup?.(error); this.cancelStartup = undefined;
    this.worker?.terminate(); this.worker = undefined;

    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    this.pending.clear();
  }

  public dispose(): void {
    this.disposed = true;
    this.fail(new Error('Image parser was disposed.'));
  }
}
