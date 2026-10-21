export interface ConfigValueSuggestion {
  label: string;
  displayLabel?: string;
  apply?: string;
  detail?: string;
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
  detail?: string;
  values?: ConfigValueSuggestion[];
}

function enumValues(...labels: string[]): ConfigValueSuggestion[] {
  return labels.map((label) => ({ label, type: 'enum' }));
}

function sampleValue(label: string, detail?: string): ConfigValueSuggestion {
  return { label, detail, type: 'text' };
}

function boundedIntegerValues(option: string, describe?: (value: number) => string): ConfigValueSuggestion[] {
  const bounds = CALENDAR_OPTION_BOUNDS[option];
  const values: ConfigValueSuggestion[] = [];

  for (let value = bounds.min; value <= (bounds.max ?? bounds.min); value++) {
    values.push({ label: String(value), detail: describe?.(value), type: 'number' });
  }

  return values;
}

const BOOLEAN_VALUES: ConfigValueSuggestion[] = [
  { label: 'true', type: 'constant' },
  { label: 'false', type: 'constant' },
];

const CSS_SIZE_HINTS: ConfigValueSuggestion[] = [
  sampleValue('400px'),
  sampleValue('70vh'),
  sampleValue('400', 'Pixels'),
];

const SHARED_CONFIG_KEYS: ConfigKeyDefinition[] = [
  {
    key: 'autoRefresh',
    detail: 'Re-run this query when indexed files change, overriding the global setting',
    values: BOOLEAN_VALUES,
  },
];

const MARKDOWN_COLUMNS_KEY: ConfigKeyDefinition = {
  key: 'markdown',
  detail: 'Columns to render as Markdown; defaults to none',
  values: [
    sampleValue('title, summary'),
    { label: 'all', type: 'enum' },
    { label: 'none', detail: 'Default', type: 'enum' },
  ],
};

const TABLE_CONFIG_KEYS: ConfigKeyDefinition[] = [
  MARKDOWN_COLUMNS_KEY,
  { key: 'height', detail: 'Pixels or CSS size', values: CSS_SIZE_HINTS },
  { key: 'minHeight', detail: 'Pixels or CSS size; applies to grids', values: CSS_SIZE_HINTS },
  { key: 'maxHeight', detail: 'Pixels or CSS size; applies to grids', values: CSS_SIZE_HINTS },
];

const MARKDOWN_CONFIG_KEYS: ConfigKeyDefinition[] = [
  MARKDOWN_COLUMNS_KEY,
  {
    key: 'columns',
    detail: 'Comma-separated column list, to reorder or limit the output columns',
    values: [sampleValue('title, path')],
  },
  {
    key: 'alignment',
    detail: 'Comma-separated column alignments, one per column',
    values: enumValues('left', 'center', 'right'),
  },
];

const CHART_CONFIG_KEYS: ConfigKeyDefinition[] = [
  {
    key: 'type',
    detail: 'Required',
    values: enumValues(...CHART_TYPES),
  },
  { key: 'title', detail: 'Shown above the chart', values: [sampleValue('Notes per month')] },
  { key: 'datasetLabel', detail: 'Legend label for the dataset', values: [sampleValue('Notes')] },
  { key: 'xLabel', detail: 'X-axis label for bar, line, and scatter charts', values: [sampleValue('Month')] },
  { key: 'yLabel', detail: 'Y-axis label for bar, line, and scatter charts', values: [sampleValue('Count')] },
  {
    key: 'datasetBackgroundColor',
    detail: 'Fill color when the result has no series column',
    values: [
      sampleValue('rgba(54, 162, 235, 0.8)'),
      sampleValue('#3388ff'),
    ],
  },
  {
    key: 'datasetBorderColor',
    detail: 'Border or line color when the result has no series column',
    values: [sampleValue('#3388ff')],
  },
];

const CALENDAR_CONFIG_KEYS: ConfigKeyDefinition[] = [
  {
    key: 'initialView',
    detail: 'Defaults to month',
    values: [
      { label: 'dayGridMonth', detail: 'Month (default)', type: 'enum' },
      { label: 'timeGridWeek', detail: 'Week', type: 'enum' },
      { label: 'timeGridDay', detail: 'Day', type: 'enum' },
      { label: 'month', detail: 'Same as dayGridMonth (default)', type: 'enum' },
      { label: 'week', detail: 'Same as timeGridWeek', type: 'enum' },
      { label: 'day', detail: 'Same as timeGridDay', type: 'enum' },
    ],
  },
  {
    key: 'initialDate',
    detail: 'Defaults to the earliest event date',
    values: [
      { label: 'first', detail: 'Earliest event date (default)', type: 'enum' },
      { label: 'last', detail: 'The latest event date', type: 'enum' },
      sampleValue('2026-01-01'),
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
    values: [sampleValue('1.35', 'Width divided by height; greater than 0')],
  },
  { key: 'expandRows', detail: 'Expand rows to fill the available height', values: BOOLEAN_VALUES },
  {
    key: 'firstDay',
    detail: 'Week start day, 0 = Sunday through 6 = Saturday',
    values: boundedIntegerValues('firstDay', (value) => WEEKDAY_NAMES[value]),
  },
  { key: 'weekNumbers', detail: 'Hidden by default', values: BOOLEAN_VALUES },
  {
    key: 'visibleWeeks',
    detail: 'Weeks in the Month view (1-6); omit to show calendar months',
    values: boundedIntegerValues('visibleWeeks'),
  },
  {
    key: 'mobileVisibleDays',
    detail: 'Days shown and advanced per page in Month/Week on narrow screens (1-7)',
    values: boundedIntegerValues('mobileVisibleDays'),
  },
  {
    key: 'skipBlankPeriods',
    detail: 'Previous/next skips periods without events',
    values: BOOLEAN_VALUES,
  },
  {
    key: 'dayMaxEvents',
    detail: 'Maximum events per month cell; additional events appear in a popover',
    values: [
      { label: 'true', detail: 'Fit as many as the cell height allows', type: 'constant' },
      sampleValue('3'),
    ],
  },
  {
    key: 'dayMaxEventRows',
    detail: 'Maximum event rows per day-grid cell; additional events appear in a popover',
    values: [
      { label: 'true', detail: 'Fit as many as the cell height allows', type: 'constant' },
      sampleValue('4'),
    ],
  },
  {
    key: 'dayMinHeight',
    detail: 'Minimum month day-cell height, in pixels',
    values: [sampleValue('120', `Minimum ${CALENDAR_OPTION_BOUNDS.dayMinHeight.min}px`)],
  },
  {
    key: 'eventMaxStack',
    detail: 'Maximum side-by-side events in week/day time grids',
    values: [sampleValue('3')],
  },
  {
    key: 'slotMinTime',
    detail: 'Earliest visible time in week/day views',
    values: [sampleValue('08:00:00')],
  },
  {
    key: 'slotMaxTime',
    detail: 'Latest visible time in week/day views',
    values: [sampleValue('18:00:00')],
  },
  {
    key: 'slotDuration',
    detail: 'Time slot interval in week/day views',
    values: [sampleValue('00:30:00', 'HH:MM:SS')],
  },
];

const NATURAL_LANGUAGE_CONFIG_KEYS: ConfigKeyDefinition[] = [
  {
    key: 'output',
    detail: 'auto selects the output from the request (default)',
    values: [
      { label: 'auto', detail: 'Default', type: 'enum' },
      { label: 'table', detail: 'Interactive grid', type: 'enum' },
      { label: 'markdown', detail: 'Markdown table', type: 'enum' },
      ...enumValues('chart', 'calendar'),
    ],
  },
  {
    key: 'showSql',
    detail: 'Overrides the global Show generated query setting',
    values: BOOLEAN_VALUES,
  },
  { key: 'type', detail: 'Applies to chart output', values: enumValues(...CHART_TYPES) },
  { key: 'title', detail: 'Shown above chart output', values: [sampleValue('Tasks by status')] },
  { key: 'datasetLabel', detail: 'Shown in the chart legend', values: [sampleValue('Tasks')] },
  { key: 'xLabel', detail: 'Applies to bar, line, and scatter charts', values: [sampleValue('Date')] },
  { key: 'yLabel', detail: 'Applies to bar, line, and scatter charts', values: [sampleValue('Count')] },
  { key: 'initialView', detail: 'Defaults to month', values: [{ label: 'month', detail: 'Default', type: 'enum' }, { label: 'week', type: 'enum' }, { label: 'day', type: 'enum' }] },
  {
    key: 'initialDate',
    detail: 'Defaults to the earliest event date',
    values: [
      { label: 'first', detail: 'Earliest event date (default)', type: 'enum' },
      { label: 'last', detail: 'The latest event date', type: 'enum' },
      sampleValue('2026-01-01'),
    ],
  },
  MARKDOWN_COLUMNS_KEY,
  { key: 'columns', detail: 'Comma-separated names; limits and reorders Markdown columns', values: [sampleValue('title, path')] },
  { key: 'alignment', detail: 'Comma-separated alignments, one per Markdown column', values: enumValues('left', 'center', 'right') },
  { key: 'height', detail: 'Pixels or CSS size; applies to grids and calendars', values: CSS_SIZE_HINTS },
  { key: 'minHeight', detail: 'Pixels or CSS size; applies to grids', values: CSS_SIZE_HINTS },
  { key: 'maxHeight', detail: 'Pixels or CSS size; applies to grids', values: CSS_SIZE_HINTS },
];

const CONFIG_KEYS_BY_LANGUAGE: Record<string, ConfigKeyDefinition[]> = {
  'vaultquery': TABLE_CONFIG_KEYS,
  'vaultquery-markdown': MARKDOWN_CONFIG_KEYS,
  'vaultquery-chart': CHART_CONFIG_KEYS,
  'vaultquery-calendar': CALENDAR_CONFIG_KEYS,
  'vaultquery-nl': NATURAL_LANGUAGE_CONFIG_KEYS,
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
