import { MarkdownRenderer, setIcon } from 'obsidian';
import type { App, Component } from 'obsidian';
import type { RenderContext } from '../generated-help/index.generated';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { getErrorMessage } from '../utils/ErrorMessages';

export function renderUnknownDynamicContent(container: HTMLElement, key: string): void {
  container.createDiv({ cls: 'vaultquery-help-error', text: `Unknown dynamic content: ${key}` });
}

export function createHelpRenderContext(app: App, component: Component, renderDynamic: RenderContext['renderDynamic'] = renderUnknownDynamicContent): RenderContext {
  return { app, component, renderDynamic, setIcon: (element, iconId) => { setIcon(element, iconId); } };
}

export async function renderHelpSchema(app: App, plugin: VaultQueryPluginContext, component: Component, container: HTMLElement, loadingMessage = ''): Promise<void> {
  const api = plugin.api;

  if (!api) {
    container.createDiv({
      cls: 'vaultquery-help-loading',
      text: `${loadingMessage ? `${loadingMessage} ` : ''}VaultQuery is initializing. Reopen this note to load the schema.`
    });

    return;
  }

  try {
    const schema = await api.getSchemaInfo();
    await MarkdownRenderer.render(app, schema, container, '', component);
  }
  catch (error: unknown) {
    container.empty();
    container.createDiv({ cls: 'vaultquery-help-error', text: `Failed to load schema: ${getErrorMessage(error)}` });
  }
}
