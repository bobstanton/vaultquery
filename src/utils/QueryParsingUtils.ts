import type { ParsedQuery } from '../types';
import { stripTrailingSemicolon } from './SQLParsingUtils';

interface ParsedQuerySections {
  sqlQuery: string;
  templateConfigText: string | null;
  configSection: string | null;
}

export interface ParseQueryBlockOptions {
  forceOutputKind?: 'table' | 'markdown' | 'chart' | 'calendar';
}

export type { ParsedQuery };

function findSectionStart(lines: string[], sectionName: 'template' | 'config'): number {
  return lines.findIndex(line => line.trim().toLowerCase() === `${sectionName}:`);
}

function parseInlineSection(content: string, sectionName: 'template' | 'config'): { before: string; after: string } | null {
  const marker = `${sectionName}:`;
  const normalized = content.trim();
  const lower = normalized.toLowerCase();
  const markerIndex = lower.indexOf(`\n${marker}`);

  if (markerIndex !== -1) {
    return {
      before: normalized.substring(0, markerIndex).trim(),
      after: normalized.substring(markerIndex + marker.length + 1).trim()
    };
  }

  if (lower.startsWith(marker)) {
    return {
      before: '',
      after: normalized.substring(marker.length).trim()
    };
  }

  return null;
}

export function splitQuerySections(source: string): ParsedQuerySections {
  const content = source.trim();
  const hasTemplateMarker = /^template:\s*|\ntemplate:\s*/im.test(content);
  const hasConfigMarker = /^config:\s*|\nconfig:\s*/im.test(content);

  if (hasTemplateMarker && hasConfigMarker) {
    throw new Error('Use either template: or config:, not both in the same query block.');
  }

  const inlineTemplate = parseInlineSection(content, 'template');
  if (inlineTemplate) {
    return {
      sqlQuery: stripTrailingSemicolon(inlineTemplate.before).trim(),
      templateConfigText: inlineTemplate.after,
      configSection: null
    };
  }

  const inlineConfig = parseInlineSection(content, 'config');
  if (inlineConfig) {
    return {
      sqlQuery: stripTrailingSemicolon(inlineConfig.before).trim(),
      templateConfigText: null,
      configSection: inlineConfig.after
    };
  }

  const lines = content.split('\n');
  const templateLineIndex = findSectionStart(lines, 'template');
  const configLineIndex = findSectionStart(lines, 'config');

  if (templateLineIndex !== -1) {
    return {
      sqlQuery: stripTrailingSemicolon(lines.slice(0, templateLineIndex).join('\n').trim()).trim(),
      templateConfigText: lines.slice(templateLineIndex + 1).join('\n').trim(),
      configSection: null
    };
  }

  if (configLineIndex !== -1) {
    return {
      sqlQuery: stripTrailingSemicolon(lines.slice(0, configLineIndex).join('\n').trim()).trim(),
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

function parseConfigSection(configText: string): Record<string, string> {
  const config: Record<string, string> = {};

  for (const line of configText.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim().toLowerCase();
    const value = line.substring(colonIndex + 1).trim();

    if (key === 'output') {
      continue;
    }

    if (key && value) {
      config[key] = value;
    }
  }

  return config;
}

export function parseQueryBlock(source: string, options: ParseQueryBlockOptions = {}): ParsedQuery {
  const sections = splitQuerySections(source);
  const result: ParsedQuery = {
    query: sections.sqlQuery
  };

  if (sections.templateConfigText) {
    result.template = sections.templateConfigText;
    result.output = { kind: 'template' };
    return result;
  }

  const parsedConfig = sections.configSection ? parseConfigSection(sections.configSection) : undefined;
  const outputOptions = parsedConfig && Object.keys(parsedConfig).length > 0 ? parsedConfig : undefined;

  if (options.forceOutputKind) {
    result.output = {
      kind: options.forceOutputKind,
      options: outputOptions
    };
    return result;
  }

  if (outputOptions) {
    result.output = {
      kind: 'table',
      options: outputOptions
    };
  }

  return result;
}
