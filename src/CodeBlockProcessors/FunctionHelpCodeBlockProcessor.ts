import { App, Component, MarkdownPostProcessorContext, MarkdownRenderer, setIcon } from 'obsidian';
import VaultQueryPlugin from '../main';
import * as functionHelp from '../generated-help/vaultquery-function-help.generated';
import type { RenderContext } from '../generated-help/index.generated';

interface FunctionDef {
  name: string;
  signature: string;
  description: string;
  example?: string;
}

const BUILTIN_FUNCTIONS: Record<string, FunctionDef[]> = {
  'Regex Functions': [
    {
      name: 'regexp',
      signature: 'regexp(pattern, text)',
      description: 'Returns 1 if text matches regex pattern, 0 otherwise. Enables REGEXP operator.',
      example: "WHERE title REGEXP '^Daily'"
    },
    {
      name: 'regexp_replace',
      signature: 'regexp_replace(text, pattern, replacement)',
      description: 'Replaces all matches of pattern. Supports \\n, \\t, \\r, \\\\ escapes.',
      example: "regexp_replace(content, '\\\\s+', ' ')"
    }
  ],
  'Date Functions': [
    {
      name: 'parse_date',
      signature: 'parse_date(text)',
      description: 'Extracts date from text, returns YYYY-MM-DD or null.',
      example: "parse_date('Meeting on Dec 25, 2024')"
    },
    {
      name: 'format_date',
      signature: 'format_date(date, format)',
      description: 'Formats ISO date using specifiers: %Y, %m, %d, %B, %b, %A, %a, etc.',
      example: "format_date('2024-12-25', '%B %e, %Y')"
    }
  ],
  'Link Functions': [
    {
      name: 'link',
      signature: 'link(path) / link(path, display)',
      description: 'Creates wikilink [[path]] or [[path|display]].',
      example: "link(path, title)"
    },
    {
      name: 'link_heading',
      signature: 'link_heading(path, heading) / link_heading(path, heading, display)',
      description: 'Creates heading link [[path#heading]] or [[path#heading|display]].',
      example: "link_heading(path, 'Section', 'Go to section')"
    },
    {
      name: 'link_block',
      signature: 'link_block(path, block_id) / link_block(path, block_id, display)',
      description: 'Creates block link [[path#^id]] or [[path#^id|display]].',
      example: "link_block(path, block_id, task_text)"
    }
  ],
  'Path Functions': [
    {
      name: 'filename',
      signature: 'filename(path)',
      description: 'Extracts filename with extension from path.',
      example: "'folder/note.md' → 'note.md'"
    },
    {
      name: 'path_name',
      signature: 'path_name(path)',
      description: 'Extracts filename with extension (alias for filename).',
      example: "'folder/note.md' → 'note.md'"
    },
    {
      name: 'path_basename',
      signature: 'path_basename(path)',
      description: 'Extracts filename without extension.',
      example: "'folder/note.md' → 'note'"
    },
    {
      name: 'path_extension',
      signature: 'path_extension(path)',
      description: 'Extracts file extension without dot.',
      example: "'folder/note.md' → 'md'"
    },
    {
      name: 'path_parent',
      signature: 'path_parent(path)',
      description: 'Extracts parent folder path.',
      example: "'folder/sub/note.md' → 'folder/sub'"
    }
  ],
  'Geolocation Functions': [
    {
      name: 'geo_lat',
      signature: 'geo_lat(text)',
      description: 'Extracts latitude from coordinate string.',
      example: "geo_lat('40.7128, -74.0060')"
    },
    {
      name: 'geo_lng',
      signature: 'geo_lng(text)',
      description: 'Extracts longitude from coordinate string.',
      example: "geo_lng('40.7128, -74.0060')"
    },
    {
      name: 'geo_distance_mi',
      signature: 'geo_distance_mi(lat1, lng1, lat2, lng2)',
      description: 'Haversine distance between two points in miles.',
      example: 'geo_distance_mi(40.71, -74.00, 34.05, -118.24)'
    },
    {
      name: 'geo_distance_km',
      signature: 'geo_distance_km(lat1, lng1, lat2, lng2)',
      description: 'Haversine distance between two points in kilometers.',
      example: 'geo_distance_km(40.71, -74.00, 34.05, -118.24)'
    }
  ]
};

export class FunctionHelpCodeBlockProcessor {
  private component: Component;

  public constructor(private app: App, private plugin: VaultQueryPlugin) {
    this.component = new Component();
    this.component.load();
  }

  public process(_source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    el.empty();
    const container = el.createDiv({ cls: 'vaultquery-function-help' });

    functionHelp.render(container, this.createRenderContext());
  }

  private createRenderContext(): RenderContext {
    return {
      renderCode: (parent: HTMLElement, language: string, code: string) => {
        const wrapper = parent.createDiv();
        const codeBlockMarkdown = '```' + language + '\n' + code + '\n```';
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Fire-and-forget render in sync callback
        MarkdownRenderer.render(this.app, codeBlockMarkdown, wrapper, '', this.component);
      },
      renderDynamic: (parent: HTMLElement, key: string) => {
        this.renderDynamicContent(parent, key);
      },
      setIcon: (element: HTMLElement, iconId: string) => {
        setIcon(element, iconId);
      },
    };
  }

  private renderDynamicContent(container: HTMLElement, key: string): void {
    if (key === 'functions') {
      this.renderFunctions(container);
    }

    else {
      container.createDiv({
        cls: 'vaultquery-help-error',
        text: `Unknown dynamic content: ${key}`
      });
    }
  }

  private renderFunctions(container: HTMLElement): void {
    const markdown = this.generateFunctionsMarkdown();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- Fire-and-forget render
    MarkdownRenderer.render(this.app, markdown, container, '', this.component);
  }

  private generateFunctionsMarkdown(): string {
    const sections: string[] = [];

    sections.push('## Built-in Functions\n');

    for (const [category, functions] of Object.entries(BUILTIN_FUNCTIONS)) {
      sections.push(`### ${category}\n`);
      sections.push('| Function | Description |');
      sections.push('|----------|-------------|');

      for (const fn of functions) {
        // Escape pipe characters in signature and description
        const sig = fn.signature.replace(/\|/g, '\\|');
        const desc = fn.description.replace(/\|/g, '\\|');
        sections.push(`| \`${sig}\` | ${desc} |`);
      }
      sections.push('');
    }

    const userFunctions = this.plugin.api?.getAllUserFunctions() ?? [];

    if (userFunctions.length > 0) {
      sections.push('## User-defined Functions\n');
      sections.push('| Function | Source File | Definition |');
      sections.push('|----------|-------------|------------|');

      for (const { function_name, path, source } of userFunctions.sort((a, b) => a.function_name.localeCompare(b.function_name))) {
        const sigMatch = source.match(/function\s+\w+\s*\([^)]*\)/);
        const signature = sigMatch ? sigMatch[0] : function_name;
        const truncated = source.length > 50 ? source.substring(0, 47) + '...' : source;
        const escaped = truncated.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const fileName = path.split('/').pop() || path;
        sections.push(`| \`${signature}\` | ${fileName} | \`${escaped}\` |`);
      }
      sections.push('');
    }

    else {
      sections.push('## User-defined Functions\n');
      sections.push('> No user-defined functions. Use `vaultquery-function` blocks to create custom functions.\n');
    }

    return sections.join('\n');
  }
}
