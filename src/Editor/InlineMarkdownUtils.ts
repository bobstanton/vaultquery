import type { VaultQueryPluginContext } from '../types/PluginContext';
export { findCodeBlockRanges, isInsideCodeBlock } from '../utils/MarkdownFenceUtils';

export function getActiveSourcePath(plugin: VaultQueryPluginContext): string {
  return plugin.app.workspace.getActiveFile()?.path || '';
}

export function isCodeElementInsidePre(codeEl: Element): boolean {
  return codeEl.closest('pre') !== null;
}
