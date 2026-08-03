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

interface SectionMarker {
  lineIndex: number;
  sameLineText: string;
}

function findSectionMarker(lines: string[], sectionName: 'template' | 'config'): SectionMarker | null {
  const marker = `${sectionName}:`;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.toLowerCase().startsWith(marker)) {
      return { lineIndex, sameLineText: line.slice(marker.length) };
    }
    if (line.trim().toLowerCase() === marker) {
      return { lineIndex, sameLineText: '' };
    }
  }

  return null;
}

export function splitQuerySections(source: string): ParsedQuerySections {
  const lines = source.trim().split('\n');
  const templateMarker = findSectionMarker(lines, 'template');
  const configMarker = findSectionMarker(lines, 'config');

  if (templateMarker && configMarker) {
    throw new Error('Use either template: or config:, not both in the same query block.');
  }

  const marker = templateMarker ?? configMarker;
  if (!marker) {
    return {
      sqlQuery: lines.join('\n'),
      templateConfigText: null,
      configSection: null
    };
  }

  const sqlQuery = stripTrailingSemicolon(lines.slice(0, marker.lineIndex).join('\n').trim()).trim();
  const sectionText = [marker.sameLineText, ...lines.slice(marker.lineIndex + 1)].join('\n').trim();

  return {
    sqlQuery,
    templateConfigText: templateMarker ? sectionText : null,
    configSection: templateMarker ? null : sectionText
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
