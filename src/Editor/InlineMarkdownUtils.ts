import type { VaultQueryPluginContext } from '../types/PluginContext';

export function getActiveSourcePath(plugin: VaultQueryPluginContext): string {
  return plugin.app.workspace.getActiveFile()?.path || '';
}

export function isCodeElementInsidePre(codeEl: Element): boolean {
  return codeEl.closest('pre') !== null;
}

export function processReadingViewInlineCode(element: HTMLElement, createReplacement: (text: string) => Node | null): void {
  const codeElements = element.querySelectorAll('code');

  for (const codeEl of Array.from(codeElements)) {
    if (isCodeElementInsidePre(codeEl)) continue;

    const text = codeEl.textContent?.trim();
    if (!text) continue;

    const replacement = createReplacement(text);
    if (!replacement) continue;

    codeEl.replaceWith(replacement);
  }
}
