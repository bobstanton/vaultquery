import type { ParsedQuery } from '../types';

export interface ParsedQuerySections {
  sqlQuery: string;
  templateConfigText: string | null;
  configSection: string | null;
}

export type { ParsedQuery };

export function splitQuerySections(source: string): ParsedQuerySections {
  const content = source.trim();
  const templateSectionRegex = /^template:\s*|\ntemplate:\s*/m;
  const hasTemplateSection = templateSectionRegex.test(content);

  if (!hasTemplateSection) {
    const configIndex = content.toLowerCase().indexOf('\nconfig:');
    if (configIndex !== -1) {
      return {
        sqlQuery: content.substring(0, configIndex).trim(),
        templateConfigText: null,
        configSection: content.substring(configIndex + 8).trim()
      };
    }

    const lines = content.split('\n');
    const configLineIndex = lines.findIndex(line => line.trim().toLowerCase() === 'config:');
    if (configLineIndex !== -1) {
      return {
        sqlQuery: lines.slice(0, configLineIndex).join('\n').trim(),
        templateConfigText: null,
        configSection: lines.slice(configLineIndex + 1).join('\n').trim()
      };
    }

    return {
      sqlQuery: content,
      templateConfigText: null,
      configSection: null
    };
  }

  const semicolonIndex = content.indexOf(';');

  if (semicolonIndex === -1) {
    throw new Error('Template configuration requires SQL query to end with a semicolon (;)');
  }

  const sqlQuery = content.substring(0, semicolonIndex).trim();
  const afterSemicolon = content.substring(semicolonIndex + 1).trim();

  let templateConfigText: string | null = null;

  if (afterSemicolon.startsWith('template:')) {
    templateConfigText = afterSemicolon.substring(9).trim();
  }

  return {
    sqlQuery,
    templateConfigText,
    configSection: null
  };
}

export function parseQueryBlock(source: string): ParsedQuery {
  const sections = splitQuerySections(source);

  const result: ParsedQuery = {
    query: sections.sqlQuery
  };

  if (sections.templateConfigText) {
    result.template = sections.templateConfigText;
  }

  return result;
}

export function parseConfigSection(configText: string): Record<string, string> {
  const config: Record<string, string> = {};

  for (const line of configText.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim().toLowerCase();
    const value = line.substring(colonIndex + 1).trim();

    if (key && value) {
      config[key] = value;
    }
  }

  return config;
}
