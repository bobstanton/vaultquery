
export interface ConfigValueSuggestion {
  label: string;
  displayLabel?: string;
  apply?: string;
  detail: string;
  type?: string;
}

export const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut', 'scatter'] as const;

export type ChartTypeName = (typeof CHART_TYPES)[number];

export interface OptionBounds {
  min: number;
  max?: number;
}

export const CALENDAR_OPTION_BOUNDS: Record<string, OptionBounds> = {
  firstDay: { min: 0, max: 6 },
  visibleWeeks: { min: 1, max: 6 },
  mobileVisibleDays: { min: 1, max: 7 },
  dayMinHeight: { min: 40 },
  eventMaxStack: { min: 0 },
  dayMaxEvents: { min: 0 },
  dayMaxEventRows: { min: 0 },
};

const WEEKDAY_NAMES = ['Sunday (default)', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface ConfigKeyDefinition {
  key: string;
  detail: string;
  values?: ConfigValueSuggestion[];
}

function enumValues(detail: string, ...labels: string[]): ConfigValueSuggestion[] {
  return labels.map((label) => ({ label, detail, type: 'enum' }));
}

function formatHint(shape: string, detail: string, sample: string): ConfigValueSuggestion {
  return {
    label: sample,
    displayLabel: shape,
    detail: `${detail}. Inserts sample: ${sample}`,
    type: 'text',
  };
}

function boundedIntegerValues(option: string, detail: string, describe?: (value: number) => string): ConfigValueSuggestion[] {
  const bounds = CALENDAR_OPTION_BOUNDS[option];
  const values: ConfigValueSuggestion[] = [];

  for (let value = bounds.min; value <= (bounds.max ?? bounds.min); value++) {
    values.push({ label: String(value), detail: describe?.(value) ?? detail, type: 'number' });
  }

  return values;
}

const BOOLEAN_VALUES: ConfigValueSuggestion[] = [
  { label: 'true', detail: 'Enabled', type: 'constant' },
  { label: 'false', detail: 'Disabled', type: 'constant' },
];

const CSS_SIZE_HINTS: ConfigValueSuggestion[] = [
  formatHint('<number>px', 'A fixed pixel height', '400px'),
  formatHint('<number>vh', 'A share of the viewport height', '70vh'),
  formatHint('<number>', 'A bare number is read as pixels', '400'),
];

const SHARED_CONFIG_KEYS: ConfigKeyDefinition[] = [
  {
    key: 'autoRefresh',
    detail: 'Re-run this query when indexed files change, overriding the global setting',
    values: BOOLEAN_VALUES,
  },
];

const TABLE_CONFIG_KEYS: ConfigKeyDefinition[] = [
  { key: 'height', detail: 'Fixed grid height', values: CSS_SIZE_HINTS },
  { key: 'minHeight', detail: 'Minimum grid height', values: CSS_SIZE_HINTS },
  { key: 'maxHeight', detail: 'Maximum grid height', values: CSS_SIZE_HINTS },
];

const MARKDOWN_CONFIG_KEYS: ConfigKeyDefinition[] = [
  {
    key: 'columns',
    detail: 'Comma-separated column list, to reorder or limit the output columns',
    values: [formatHint('<a>, <b>, <c>', 'Comma-separated result column names', 'title, path')],
  },
  {
    key: 'alignment',
    detail: 'Comma-separated column alignments, one per column',
    values: enumValues('Column alignment', 'left', 'center', 'right'),
  },
];

const CHART_CONFIG_KEYS: ConfigKeyDefinition[] = [
  {
    key: 'type',
    detail: 'Chart type (required)',
    values: enumValues('Chart type', ...CHART_TYPES),
  },
  { key: 'title', detail: 'Chart title', values: [formatHint('<text>', 'Free text shown above the chart', 'Notes per month')] },
  { key: 'datasetLabel', detail: 'Legend label for the dataset', values: [formatHint('<text>', 'Free text shown in the legend', 'Notes')] },
  { key: 'xLabel', detail: 'X-axis label for bar, line, and scatter charts', values: [formatHint('<text>', 'Free text shown under the X axis', 'Month')] },
  { key: 'yLabel', detail: 'Y-axis label for bar, line, and scatter charts', values: [formatHint('<text>', 'Free text shown beside the Y axis', 'Count')] },
  {
    key: 'datasetBackgroundColor',
    detail: 'Dataset fill color; use result columns instead when the color varies per row',
    values: [
      formatHint('rgba(<r>, <g>, <b>, <a>)', 'A translucent fill', 'rgba(54, 162, 235, 0.8)'),
      formatHint('#RRGGBB', 'A hex color', '#3388ff'),
    ],
  },
  {
    key: 'datasetBorderColor',
    detail: 'Dataset border/line color',
    values: [formatHint('#RRGGBB', 'A hex color', '#3388ff')],
  },
];

const CALENDAR_CONFIG_KEYS: ConfigKeyDefinition[] = [
  {
    key: 'initialView',
    detail: 'Calendar starting view',
    values: [
      ...enumValues('Calendar view', 'dayGridMonth', 'timeGridWeek', 'timeGridDay'),
      ...enumValues('Short alias for the matching view', 'month', 'week', 'day'),
    ],
  },
  {
    key: 'initialDate',
    detail: 'Date the calendar opens on',
    values: [
      { label: 'first', detail: 'The earliest event date', type: 'enum' },
      { label: 'last', detail: 'The latest event date', type: 'enum' },
      formatHint('YYYY-MM-DD', 'A fixed calendar date', '2026-01-01'),
    ],
  },
  {
    key: 'height',
    detail: 'Height of the whole calendar, toolbar included',
    values: [{ label: 'auto', detail: 'Size to the content (default)', type: 'enum' }, ...CSS_SIZE_HINTS],
  },
  { key: 'contentHeight', detail: 'Height of the content area, excluding the toolbar', values: CSS_SIZE_HINTS },
  {
    key: 'aspectRatio',
    detail: 'Width-to-height ratio used when the height is not fixed',
    values: [formatHint('<number>', 'A positive ratio; larger is wider', '1.35')],
  },
  { key: 'expandRows', detail: 'Expand rows to fill the available height', values: BOOLEAN_VALUES },
  {
    key: 'firstDay',
    detail: 'Week start day, 0 = Sunday through 6 = Saturday',
    values: boundedIntegerValues('firstDay', 'Week start day', (value) => WEEKDAY_NAMES[value]),
  },
  { key: 'weekNumbers', detail: 'Show week numbers', values: BOOLEAN_VALUES },
  {
    key: 'visibleWeeks',
    detail: 'Week rows shown by the Month button; omitted means the normal month range',
    values: boundedIntegerValues('visibleWeeks', 'Week rows shown at once'),
  },
  {
    key: 'mobileVisibleDays',
    detail: 'On narrow screens, target this many day columns and page Month/Week by that many days',
    values: boundedIntegerValues('mobileVisibleDays', 'Day columns targeted on narrow screens'),
  },
  {
    key: 'skipBlankPeriods',
    detail: 'Make previous/next jump to the nearest period that actually contains events',
    values: BOOLEAN_VALUES,
  },
  {
    key: 'dayMaxEvents',
    detail: 'Events shown in a month cell before overflow',
    values: [
      { label: 'true', detail: 'Fit as many as the cell height allows', type: 'constant' },
      formatHint('<number>', 'A fixed maximum per cell', '3'),
    ],
  },
  {
    key: 'dayMaxEventRows',
    detail: 'Event rows shown in a day-grid cell before overflow',
    values: [
      { label: 'true', detail: 'Fit as many as the cell height allows', type: 'constant' },
      formatHint('<number>', 'A fixed maximum per cell', '4'),
    ],
  },
  {
    key: 'dayMinHeight',
    detail: 'Minimum month day-cell height, in pixels',
    values: [formatHint('<number>', `Pixels; ${CALENDAR_OPTION_BOUNDS.dayMinHeight.min} is the smallest accepted`, '120')],
  },
  {
    key: 'eventMaxStack',
    detail: 'Maximum stacked events in time-grid views',
    values: [formatHint('<number>', 'Events allowed to overlap side by side', '3')],
  },
  {
    key: 'slotMinTime',
    detail: 'Earliest visible time in week/day views',
    values: [formatHint('HH:MM:SS', 'A time of day', '08:00:00')],
  },
  {
    key: 'slotMaxTime',
    detail: 'Latest visible time in week/day views',
    values: [formatHint('HH:MM:SS', 'A time of day', '18:00:00')],
  },
  {
    key: 'slotDuration',
    detail: 'Time slot interval in week/day views',
    values: [formatHint('HH:MM:SS', 'A duration', '00:30:00')],
  },
];

const CONFIG_KEYS_BY_LANGUAGE: Record<string, ConfigKeyDefinition[]> = {
  'vaultquery': TABLE_CONFIG_KEYS,
  'vaultquery-markdown': MARKDOWN_CONFIG_KEYS,
  'vaultquery-chart': CHART_CONFIG_KEYS,
  'vaultquery-calendar': CALENDAR_CONFIG_KEYS,
};

export function getConfigKeys(language: string): ConfigKeyDefinition[] {
  const languageKeys = CONFIG_KEYS_BY_LANGUAGE[language];
  if (!languageKeys) {
    return [];
  }

  return [...languageKeys, ...SHARED_CONFIG_KEYS];
}

export function getConfigValues(language: string, key: string): ConfigValueSuggestion[] {
  const normalizedKey = key.trim().toLowerCase();
  return getConfigKeys(language)
    .find((definition) => definition.key.toLowerCase() === normalizedKey)
    ?.values ?? [];
}

export function getAllConfigKeysLowercased(): Set<string> {
  const keys = new Set<string>();
  for (const language of Object.keys(CONFIG_KEYS_BY_LANGUAGE)) {
    for (const definition of getConfigKeys(language)) {
      keys.add(definition.key.toLowerCase());
    }
  }
  return keys;
}
