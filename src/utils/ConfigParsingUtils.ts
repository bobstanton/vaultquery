import { escapeRegex } from './StringUtils';

export interface DimensionParseOptions {
  allowNumber?: boolean;
  allowAuto?: boolean;
  bareNumber?: 'number' | 'px';
  units?: string[];
}

const DEFAULT_DIMENSION_UNITS = ['px', 'rem', 'em', 'vh', 'vw', 'vmin', 'vmax', 'svh', 'lvh', 'dvh', '%'];

export function parseBooleanOption(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true;
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false;
    default:
      return undefined;
  }
}

export function parseBooleanOptionOrNull(value: unknown): boolean | null {
  return parseBooleanOption(value) ?? null;
}

export function parseCssDimension(value: unknown, options: DimensionParseOptions = {}): string | number | undefined {
  const bareNumber = options.bareNumber ?? 'px';

  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return options.allowNumber === true ? value : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (options.allowAuto === true && trimmed.toLowerCase() === 'auto') {
    return 'auto';
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return bareNumber === 'number' ? Number(trimmed) : `${trimmed}px`;
  }

  const units = options.units ?? DEFAULT_DIMENSION_UNITS;
  const unitPattern = units.map(escapeRegex).join('|');
  return new RegExp(`^\\d+(\\.\\d+)?(${unitPattern})$`, 'i').test(trimmed)
    ? trimmed
    : undefined;
}

export function parseCssDimensionOrNull(value: unknown, options: DimensionParseOptions = {}): string | number | null {
  return parseCssDimension(value, options) ?? null;
}
