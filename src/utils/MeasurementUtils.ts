interface Measurement {
  value: number;
  unit: string;
}

const MEASUREMENT = /^([+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%'′"″]*)$/;

function parseMeasurement(input: unknown): Measurement | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? { value: input, unit: '' } : null;
  }

  if (typeof input !== 'string') return null;
  const match = MEASUREMENT.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));

  return Number.isFinite(value) ? { value, unit: match[2].toLowerCase() } : null;
}

export function parseNumber(input: unknown): number | null {
  return parseMeasurement(input)?.value ?? null;
}

const METERS_PER_UNIT = new Map<string, number>([
  ...['m', 'meter', 'meters', 'metre', 'metres'].map(unit => [unit, 1] as const),
  ...['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'].map(unit => [unit, 1000] as const),
  ...['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'].map(unit => [unit, 0.01] as const),
  ...['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'].map(unit => [unit, 0.001] as const),
  ...['ft', 'foot', 'feet', "'", '′'].map(unit => [unit, 0.3048] as const),
  ...['in', 'inch', 'inches', '"', '″'].map(unit => [unit, 0.0254] as const),
  ...['yd', 'yard', 'yards'].map(unit => [unit, 0.9144] as const),
  ...['mi', 'mile', 'miles'].map(unit => [unit, 1609.344] as const),
]);

function unitScale(unit: unknown): number | undefined {
  return typeof unit === 'string' ? METERS_PER_UNIT.get(unit.trim().toLowerCase()) : undefined;
}

export function convertDistance(input: unknown, targetUnit: unknown, bareUnit?: unknown): number | null {
  const measurement = parseMeasurement(input);
  if (!measurement) return null;
  const source = unitScale(measurement.unit || bareUnit);
  const target = unitScale(targetUnit);
  if (source === undefined || target === undefined) return null;
  const result = measurement.value * source / target;

  return Number.isFinite(result) ? result : null;
}
