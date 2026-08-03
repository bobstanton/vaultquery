import { logger as rootLogger } from './logger';
import { parseBooleanOption } from './ConfigParsingUtils';

import type { FrontmatterValue } from '../EditPlanner';

const logger = rootLogger.scope('FrontmatterValueParser');

function isFrontmatterValue(value: unknown): value is FrontmatterValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isFrontmatterValue);
  }

  if (typeof value !== 'object') {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every(isFrontmatterValue);
}

function isFrontmatterValueArray(value: unknown): value is FrontmatterValue[] {
  return Array.isArray(value) && value.every(isFrontmatterValue);
}

export function parseFrontmatterValue(value: string | null, type: string | null): FrontmatterValue {
  if (value === null) {
    return null;
  }

  switch (type?.toLowerCase()) {
    case 'number': {
      const num = Number(value);
      return isNaN(num) ? value : num;
    }

    case 'boolean':
      return parseBooleanOption(value) ?? value;

    case 'date':
    case 'datetime':
      return value;

    case 'list':
    case 'array':
    case 'aliases':
    case 'tags':
      try {
        const parsed: unknown = JSON.parse(value);
        if (isFrontmatterValueArray(parsed)) return parsed;
      }
      catch (e) {
        logger.warn('Failed to parse array property value', value, e);
        if (value.includes(',')) {
          return value.split(',').map(s => s.trim());
        }
      }
      return value;

    default:
      return value;
  }
}
