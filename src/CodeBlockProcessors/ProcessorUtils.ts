export function createVaultQueryCodeBlockContainer(el: HTMLElement): HTMLElement | null {
  if (el.closest('.display-only')) {
    return null;
  }

  el.empty();
  return el.createDiv({ cls: 'vaultquery-container' });
}
