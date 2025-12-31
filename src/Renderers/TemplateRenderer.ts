import { debounce } from 'obsidian';
import { mergeHelpers, obsidianHelpers, escapeHtml } from 'placeholder-resolver';
import { BaseRenderer } from './BaseRenderer';

export interface TemplateRenderContext {
  results: Record<string, unknown>[];
  query: string;
  count: number;
}

const templateCache = new Map<string, Function>();

// Cache debounced render functions per container (WeakMap for automatic cleanup)
type RenderFn = (template: string, context: TemplateRenderContext, openFile: (path: string) => void) => void;
const debouncedRenderers = new WeakMap<HTMLElement, RenderFn>();
const DEBOUNCE_MS = 50;

function getCompiledTemplate(template: string): Function {
  let fn = templateCache.get(template);
  if (!fn) {
    fn = new Function('results', 'query', 'count', 'h', template);
    templateCache.set(template, fn);

    if (templateCache.size > 100) {
      const firstKey = templateCache.keys().next().value;
      if (firstKey) templateCache.delete(firstKey);
    }
  }
  return fn;
}

function renderWikilinks(text: string): string {
  if (!text) return '';

  const str = String(text);
  const wikilinkRegex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

  const result: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = wikilinkRegex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      result.push(escapeHtml(str.slice(lastIndex, match.index)));
    }

    const target = match[1];
    const display = match[2];
    const displayText = display || target;
    const escapedPath = target.replace(/"/g, '&quot;');
    const escapedDisplay = escapeHtml(displayText);
    result.push(`<a href="${escapedPath}" class="internal-link" data-path="${escapedPath}">${escapedDisplay}</a>`);

    lastIndex = wikilinkRegex.lastIndex;
  }

  if (lastIndex < str.length) {
    result.push(escapeHtml(str.slice(lastIndex)));
  }

  return result.join('');
}

function buildTemplateHelpers() {
  const helpers = mergeHelpers(obsidianHelpers);
  return {
    ...helpers,
    renderWikilinks
  };
}

export class TemplateRenderer extends BaseRenderer {
  static render(template: string, context: TemplateRenderContext, container: HTMLElement, openFile: (path: string) => void): void {
    // Get or create a debounced renderer for this container
    let debouncedRender = debouncedRenderers.get(container);
    if (!debouncedRender) {
      debouncedRender = debounce(
        (t: string, ctx: TemplateRenderContext, open: (path: string) => void) => {
          this.renderImmediate(t, ctx, container, open);
        },
        DEBOUNCE_MS,
        true // resetTimer: restart the timer on each call
      );
      debouncedRenderers.set(container, debouncedRender);
    }

    debouncedRender(template, context, openFile);
  }

  private static renderImmediate(template: string, context: TemplateRenderContext, container: HTMLElement, openFile: (path: string) => void): void {
    try {
      let parent = container.parentElement;
      while (parent) {
        if (parent.classList.contains('vaultquery-container') || parent.classList.contains('vaultquery-results')) {
          console.warn('VaultQuery: Detected nested template render attempt, skipping to prevent recursion');
          container.createDiv({
            cls: 'vaultquery-error',
            text: 'Cannot render nested queries'
          });
          return;
        }
        parent = parent.parentElement;
      }

      const templateFunction = getCompiledTemplate(template);
      const helpers = buildTemplateHelpers();

      const html = templateFunction(context.results, context.query, context.count, helpers);

      container.empty();

      const parser = new DOMParser();
      // eslint-disable-next-line obsidianmd/no-object-to-string -- html is known to be a string from the template function
      const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
      const parsedDiv = doc.body.firstChild as HTMLElement;
      if (parsedDiv) {
        while (parsedDiv.firstChild) {
          container.appendChild(parsedDiv.firstChild);
        }
      }

      this.setupInternalLinks(container, openFile);
    }
    catch (error: unknown) {
      console.error('VaultQuery: Template rendering failed:', error);
      container.empty();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      container.createDiv({
        cls: 'vaultquery-error',
        text: `Template error: ${errorMessage}`
      });
    }
  }

  /** Clear template cache (useful for testing or memory management) */
  static clearCache(): void {
    templateCache.clear();
  }
}