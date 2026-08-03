import { App, MarkdownRenderer } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import * as functionHelp from '../generated-help/vaultquery-function-help.generated';
import { BaseHelpCodeBlockProcessor } from './BaseHelpCodeBlockProcessor';

interface FunctionDef {
  name: string;
  signature: string;
  description: string;
}

const BUILTIN_FUNCTIONS: Record<string, FunctionDef[]> = {
  'Regex Functions': [
    {
      name: 'regexp',
      signature: 'regexp(pattern, text)',
      description: 'Returns 1 if text matches regex pattern, 0 otherwise. Enables REGEXP operator.'
    },
    {
      name: 'regexp_replace',
      signature: 'regexp_replace(text, pattern, replacement)',
      description: 'Replaces all matches of pattern. Supports \\n, \\t, \\r, \\\\ escapes.'
    }
  ],
  'Date Functions': [
    {
      name: 'parse_date',
      signature: 'parse_date(text)',
      description: 'Extracts date from text, returns YYYY-MM-DD or null.'
    },
    {
      name: 'format_date',
      signature: 'format_date(date, format)',
      description: 'Formats ISO YYYY-MM-DD or compact YYYYMMDD dates using specifiers: %Y, %m, %d, %B, %b, %A, %a, etc.'
    }
  ],
  'Link Functions': [
    {
      name: 'link',
      signature: 'link(path) / link(path, display)',
      description: 'Creates wikilink [[path]] or [[path|display]].'
    },
    {
      name: 'link_heading',
      signature: 'link_heading(path, heading) / link_heading(path, heading, display)',
      description: 'Creates heading link [[path#heading]] or [[path#heading|display]].'
    },
    {
      name: 'link_block',
      signature: 'link_block(path, block_id) / link_block(path, block_id, display)',
      description: 'Creates block link [[path#^id]] or [[path#^id|display]].'
    },
    {
      name: 'resolve_link',
      signature: 'resolve_link(wikilink) / resolve_link(wikilink, sourcePath)',
      description: 'Resolves a wikilink or note name to a vault-relative file path using Obsidian link resolution.'
    }
  ],
  'Path Functions': [
    {
      name: 'filename',
      signature: 'filename(path)',
      description: 'Extracts filename with extension from path.'
    },
    {
      name: 'path_name',
      signature: 'path_name(path)',
      description: 'Extracts filename with extension (alias for filename).'
    },
    {
      name: 'path_basename',
      signature: 'path_basename(path)',
      description: 'Extracts filename without extension.'
    },
    {
      name: 'path_extension',
      signature: 'path_extension(path)',
      description: 'Extracts file extension without dot.'
    },
    {
      name: 'path_parent',
      signature: 'path_parent(path)',
      description: 'Extracts parent folder path.'
    }
  ],
  'Geolocation Functions': [
    {
      name: 'geo_lat',
      signature: 'geo_lat(text)',
      description: 'Extracts latitude from coordinate string.'
    },
    {
      name: 'geo_lng',
      signature: 'geo_lng(text)',
      description: 'Extracts longitude from coordinate string.'
    },
    {
      name: 'geo_distance_mi',
      signature: 'geo_distance_mi(lat1, lng1, lat2, lng2)',
      description: 'Haversine distance between two points in miles.'
    },
    {
      name: 'geo_distance_km',
      signature: 'geo_distance_km(lat1, lng1, lat2, lng2)',
      description: 'Haversine distance between two points in kilometers.'
    }
  ]
};

export class FunctionHelpCodeBlockProcessor extends BaseHelpCodeBlockProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin, 'vaultquery-function-help', functionHelp);
  }

  protected renderDynamicContent(container: HTMLElement, key: string): void {
    if (key === 'functions') {
      void this.generateFunctionsMarkdown().then(markdown => {
        void MarkdownRenderer.render(this.app, markdown, container, '', this.component);
      });
    }
    else {
      super.renderDynamicContent(container, key);
    }
  }

  private async generateFunctionsMarkdown(): Promise<string> {
    const sections: string[] = [];

    sections.push('## Built-in Functions\n');

    for (const [category, functions] of Object.entries(BUILTIN_FUNCTIONS)) {
      sections.push(`### ${category}\n`);
      sections.push('| Function | Description |');
      sections.push('|----------|-------------|');

      for (const fn of functions) {
        const sig = fn.signature.replace(/\|/g, '\\|');
        const desc = fn.description.replace(/\|/g, '\\|');
        sections.push(`| \`${sig}\` | ${desc} |`);
      }
      sections.push('');
    }

    const userFunctions = await this.plugin.api?.getAllUserFunctions() ?? [];

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
