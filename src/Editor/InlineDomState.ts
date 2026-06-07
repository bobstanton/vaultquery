import { Notice } from 'obsidian';
import { getErrorMessage } from '../utils/ErrorMessages';

export function createInlineSpan(owner: Document, className: string, dataSql: string): HTMLElement {
  const span = owner.createElement('span');
  span.className = `${className} ${className}-loading`;
  span.textContent = '...';
  span.setAttribute('data-sql', dataSql);
  return span;
}

export function setInlineSpanValue(span: HTMLElement, baseClass: string, value: string): void {
  if (!span.isConnected) return;

  span.textContent = value;
  span.classList.remove(`${baseClass}-loading`, `${baseClass}-error`);
}

export function setInlineSpanError(span: HTMLElement, baseClass: string, error: unknown, label: string): void {
  if (!span.isConnected) return;

  span.textContent = label;
  span.title = getErrorMessage(error);
  span.classList.remove(`${baseClass}-loading`);
  span.classList.add(`${baseClass}-error`);
}

export function setButtonLoading(button: HTMLButtonElement, className: string, loading: boolean): void {
  button.disabled = loading;
  button.classList.toggle(className, loading);
}

export function showQueryFailedNotice(error: unknown): void {
  new Notice(`Query failed: ${getErrorMessage(error)}`, 5000);
}
