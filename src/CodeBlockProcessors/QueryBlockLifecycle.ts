import type { App, MarkdownPostProcessorContext } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { cleanupRenderedOutput } from '../Renderers/RendererCleanup';
import { createVaultQueryCodeBlockContainer, isBlockUnloaded } from './ProcessorUtils';

interface QueryBlockLifecycle<T> {
  app: App;
  plugin: VaultQueryPluginContext;
  prepare: (container: HTMLElement) => T | undefined;
  render: (container: HTMLElement, parsed: T) => Promise<void>;
  cleanup?: (container: HTMLElement) => void;
}

export async function processQueryBlock<T>(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, options: QueryBlockLifecycle<T>): Promise<void> {
  const container = createVaultQueryCodeBlockContainer(el, ctx);
  if (!container) return;

  const renderError = (error: unknown): void => {
    if (isBlockUnloaded(container)) return;
    (options.cleanup ?? cleanupRenderedOutput)(container);
    BaseRenderer.renderQueryError(options.app, container, error, source);
  };

  try {
    const parsed = options.prepare(container);
    if (parsed === undefined) return;

    if (options.plugin.api?.isIndexReady()) {
      // Obsidian can wait for this processor before attaching the block.
      // Rendering may itself wait for attachment, so return while it runs.
      void options.render(container, parsed).catch(renderError);
    } else {
      // Return while waiting so Obsidian can attach the block before rendering resumes.
      void options.plugin.indexingReadiness.wait(container).then(() => {
        if (!isBlockUnloaded(container)) return options.render(container, parsed);
      }).catch(renderError);
    }
  }
  catch (error: unknown) {
    renderError(error);
  }
}
