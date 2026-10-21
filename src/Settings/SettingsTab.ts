import { App, PluginSettingTab } from 'obsidian';
import type { Setting, SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { IndexingStatsModal } from '../Modals/IndexingStatsModal';
import { LlmProviderModal } from './LlmProviderModal';
import type { LlmProviderConfig } from '../LLM/LlmTypes';
import { normalizeExportFolder } from './Settings';
import type { EnabledFeatures, VaultQuerySettings, WasmSource } from './Settings';
import type { ConsoleLogLevel } from 'obsidian-debug-logger';
import { logger as rootLogger } from '../utils/logger';
import { normalizeFileExtensions } from '../OtherFiles/OtherFileContentSettings';
import { DEFAULT_REFRESH_MINUTES, effectiveRefreshMode, normalizeRefreshMinutes, normalizeRefreshMode, normalizeRootExtensions, normalizeRootPath, retainsRows } from '../External/ExternalRootSettings';
import type { ExternalRefreshMode, ExternalRoot } from '../External/ExternalRootSettings';
import { externalCapabilities } from '../External/ExternalRuntime';
import type { ExternalCapabilities } from '../External/ExternalRuntime';

const logger = rootLogger.scope('Settings');

const FEATURE_KEY_PREFIX = 'feature:';
const EXCLUDE_PATTERN_KEY_PREFIX = 'excludePattern:';
const EXTERNAL_ROOT_PATH_PREFIX = 'externalRootPath:';
const EXTERNAL_ROOT_EXTENSIONS_PREFIX = 'externalRootExtensions:';
const EXTERNAL_ROOT_REFRESH_PREFIX = 'externalRootRefresh:';
const EXTERNAL_ROOT_MINUTES_PREFIX = 'externalRootMinutes:';

const REFRESH_MODE_LABELS: Record<ExternalRefreshMode, string> = {
  watch: 'When files change',
  interval: 'On a schedule',
  manual: 'At startup and on demand',
};

const UNAVAILABLE_FOLDERS = 'This device cannot read folders outside the vault';

/** Settings pages have no public way back; after removing the item a page edits, stay on it and its controls would edit the next item. */
function closeSettingsPage(app: App): void {
  (app as App & { setting?: { closePage?(): void } }).setting?.closePage?.();
}

interface ControlAccessor {
  get: (settings: VaultQuerySettings, id: string) => unknown;
  set: (settings: VaultQuerySettings, value: unknown, id: string) => void;
  accepts?: (value: unknown) => boolean;
  reindex?: boolean;
  refreshState?: boolean;
}

const PLAIN_CONTROL: ControlAccessor = {
  get: (settings, id) => (settings as unknown as Record<string, unknown>)[id],
  set: (settings, value, id) => { (settings as unknown as Record<string, unknown>)[id] = value; },
};

function rootControl<K extends keyof ExternalRoot>(
  field: K, fallback: unknown, parse: (value: unknown) => ExternalRoot[K], format: (value: ExternalRoot[K]) => unknown = value => value
): ControlAccessor {
  return {
    get: (settings, id) => {
      const root = settings.externalRoots[Number(id)];

      return root ? format(root[field]) : fallback;
    },
    set: (settings, value, id) => {
      const root = settings.externalRoots[Number(id)];
      if (root) root[field] = parse(value);
    },
  };
}

function integerControl(key: 'maxFileSizeKB' | 'inlineButtonDebounceMs' | 'viewPreviewLimit', min: number): ControlAccessor {
  return {
    get: settings => settings[key],
    set: (settings, value) => { settings[key] = Math.trunc(Number(value)); },
    accepts: value => {
      const number = Math.trunc(Number(value));

      return Number.isFinite(number) && number >= min;
    },
  };
}

function llmToggle(field: 'enabled' | 'showSql' | 'allowWriteOperations'): ControlAccessor {
  return { get: settings => settings.llm[field], set: (settings, value) => { settings.llm[field] = value === true; } };
}

const PREFIX_CONTROLS: [string, ControlAccessor][] = [
  [FEATURE_KEY_PREFIX, {
    get: (settings, id) => settings.enabledFeatures[id as keyof EnabledFeatures],
    set: (settings, value, id) => { settings.enabledFeatures[id as keyof EnabledFeatures] = value === true; },
    reindex: true,
  }],
  [EXCLUDE_PATTERN_KEY_PREFIX, {
    get: (settings, id) => settings.excludePatterns[Number(id)],
    set: (settings, value, id) => { settings.excludePatterns[Number(id)] = typeof value === 'string' ? value : ''; },
    reindex: true,
  }],
  [EXTERNAL_ROOT_PATH_PREFIX, rootControl('path', '', value => normalizeRootPath(String(value)))],
  [EXTERNAL_ROOT_EXTENSIONS_PREFIX, rootControl('extensions', '', value => normalizeRootExtensions(String(value).split(',')), extensions => extensions.join(', '))],
  [EXTERNAL_ROOT_REFRESH_PREFIX, { ...rootControl('refresh', 'watch', normalizeRefreshMode), refreshState: true }],
  [EXTERNAL_ROOT_MINUTES_PREFIX, rootControl('refreshMinutes', DEFAULT_REFRESH_MINUTES, normalizeRefreshMinutes)],
];

const KEY_CONTROLS: Record<string, ControlAccessor> = {
  otherFileContentExtensions: {
    get: settings => settings.otherFileContentExtensions.join(', '),
    set: (settings, value) => { settings.otherFileContentExtensions = normalizeFileExtensions(String(value).split(',')); },
  },
  maxFileSizeKB: integerControl('maxFileSizeKB', 1),
  inlineButtonDebounceMs: integerControl('inlineButtonDebounceMs', 0),
  viewPreviewLimit: integerControl('viewPreviewLimit', 0),
  exportFolder: { ...PLAIN_CONTROL, set: (settings, value) => { settings.exportFolder = normalizeExportFolder(String(value)); } },
  enableCli: {
    ...PLAIN_CONTROL,
    set: (settings, value) => {
      settings.enableCli = value === true;
      if (!settings.enableCli) settings.enableCliWriteOperations = false;
    },
  },
  wasmSource: { get: settings => settings.wasm.source, set: (settings, value) => { settings.wasm.source = value as WasmSource; } },
  wasmCacheLocally: { get: settings => settings.wasm.cacheLocally, set: (settings, value) => { settings.wasm.cacheLocally = value === true; } },
  wasmCustomPath: { get: settings => settings.wasm.customPath, set: (settings, value) => { settings.wasm.customPath = (typeof value === 'string' ? value : '').trim(); } },
  consoleLogLevel: { get: settings => settings.debugConsoleLogLevel, set: (settings, value) => { settings.debugConsoleLogLevel = value as ConsoleLogLevel; } },
  llmEnabled: llmToggle('enabled'),
  llmShowSql: llmToggle('showSql'),
  llmAllowWriteOperations: llmToggle('allowWriteOperations'),
};

function resolveControl(key: string): { control: ControlAccessor; id: string } {
  const prefixed = PREFIX_CONTROLS.find(([prefix]) => key.startsWith(prefix));
  if (prefixed) return { control: prefixed[1], id: key.slice(prefixed[0].length) };

  return { control: KEY_CONTROLS[key] ?? PLAIN_CONTROL, id: key };
}

const REINDEX_KEYS = new Set(['maxFileSizeKB', 'enableDynamicTableViews', 'enableJavaScriptFunctions', 'enableThirdPartyProviderTables', 'enableRemoteDataReads']);
const UPDATE_KEYS = new Set(['indexingInterval', 'feature:indexContent', 'feature:indexTables', 'allowWriteOperations', 'enableDataFileReads', 'enableInlineButtons', 'enableCli', 'enableCliWriteOperations', 'wasmSource', 'llmEnabled', 'llmAllowWriteOperations']);

interface SettingsUiState {
  settings: VaultQuerySettings;
  isRealtimeIndexing: boolean;
  contentEnabled: boolean;
  writeEnabled: boolean;
}

export class VaultQuerySettingTab extends PluginSettingTab {
  plugin: VaultQueryPluginContext;
  private readonly externalStatusRows = new Map<number, Setting>();

  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    this.externalStatusRows.clear();

    const state: SettingsUiState = {
      settings,
      isRealtimeIndexing: settings.indexingInterval === 'realtime',
      contentEnabled: settings.enabledFeatures.indexContent,
      writeEnabled: settings.allowWriteOperations,
    };

    return [
      this.buildIndexingPage(state),
      this.buildQueriesPage(state),
      this.buildNaturalLanguagePage(state),
      this.buildChangesPage(state),
      this.buildIntegrationsPage(state),
      this.buildAdvancedPage(state),
    ];
  }

  private buildIndexingPage({ settings, contentEnabled }: SettingsUiState): SettingDefinitionPage {
    const enabledSourceCount = Object.values(settings.enabledFeatures).filter(Boolean).length;

    const indexingModeLabel = {
      realtime: 'Real-time',
      startup: 'On startup',
      manual: 'Manual',
    }[settings.indexingInterval];

    return {
      type: 'page',
      name: 'Indexing',
      displayValue: `${enabledSourceCount} sources; ${indexingModeLabel}`,
      items: [
        {
          type: 'group',
          heading: 'Schedule and storage',
          items: [
            {
              name: 'Indexing mode',
              desc: 'Choose when to index notes. Real-time keeps the index always up-to-date, startup indexes once when the app starts, and manual requires clicking the "Rebuild index" button below.',
              control: {
                type: 'dropdown',
                key: 'indexingInterval',
                options: { realtime: 'Real-time', startup: 'On startup only', manual: 'Manual only' },
              },
            },
            {
              name: 'Maximum file size (KB)',
              aliases: ['Maximum file size'],
              desc: 'Maximum file size for Markdown and other-file content indexing. Default is 1000 KB.',
              control: { type: 'number', key: 'maxFileSizeKB', placeholder: '1000', min: 1 },
            },
            {
              name: 'Database storage',
              desc: 'Disk storage saves the index between sessions. Memory storage rebuilds the index on startup.',
              control: {
                type: 'dropdown',
                key: 'databaseStorage',
                options: { disk: 'Disk storage (persistent)', memory: 'Memory storage (faster)' },
              },
            },
            {
              name: 'Index on background thread',
              desc: 'Run initial indexing in a background thread to keep the UI responsive. After indexing completes, switches to main thread for fast queries. Requires restart to take effect.',
              control: { type: 'toggle', key: 'backgroundIndexing' },
            },
          ],
        },
        {
          type: 'group',
          heading: 'Metadata-only indexing',
          items: [
            { name: '', desc: 'These features use Obsidian\'s metadata cache without loading the entire file.' },
            {
              name: 'Index frontmatter',
              desc: 'Index frontmatter properties. Also creates a notes_with_properties view where each property key becomes a column.',
              control: { type: 'toggle', key: 'feature:indexFrontmatter' },
            },
            {
              name: 'Index headings',
              desc: 'Index Markdown headings (h1-h6) into structured data.',
              control: { type: 'toggle', key: 'feature:indexHeadings' },
            },
            {
              name: 'Index links',
              desc: 'Index internal links between notes.',
              control: { type: 'toggle', key: 'feature:indexLinks' },
            },
            {
              name: 'Index unresolved links',
              desc: 'Index links Obsidian cannot resolve to a note.',
              control: { type: 'toggle', key: 'feature:indexUnresolvedLinks' },
            },
            {
              name: 'Index embeds',
              desc: 'Index embedded links such as images, PDFs, and embedded notes.',
              control: { type: 'toggle', key: 'feature:indexEmbeds' },
            },
            {
              name: 'Index blocks',
              desc: 'Index Obsidian block IDs as queryable rows.',
              control: { type: 'toggle', key: 'feature:indexBlocks' },
            },
            {
              name: 'Index tags',
              desc: 'Index hashtags found in notes.',
              control: { type: 'toggle', key: 'feature:indexTags' },
            },
            {
              name: 'Index list items',
              desc: 'Index bulleted and numbered list items. Excludes task items (use Index tasks for those).',
              control: { type: 'toggle', key: 'feature:indexListItems' },
            },
          ],
        },
        {
          type: 'group',
          heading: 'Content-dependent indexing',
          items: [
            { name: '', desc: 'These features require loading the full content of each note, which may impact performance on large vaults.' },
            {
              name: 'Index note content',
              desc: 'Include the full text content of notes in the database. Disabling this will also disable tables and tasks indexing.',
              control: { type: 'toggle', key: 'feature:indexContent' },
            },
            {
              name: 'Index tables',
              desc: 'Parse Markdown tables into structured data. When enabled, each table cell becomes queryable, and tables can be referenced by their position or the heading above them.',
              control: { type: 'toggle', key: 'feature:indexTables', disabled: !contentEnabled },
            },
            {
              name: 'Enable dynamic table views',
              aliases: ['Dynamic table views'],
              desc: 'Automatically create simplified SQL views for each unique table structure. Requires "Index tables" to be enabled. A full reindex is needed for changes to take effect.',
              control: { type: 'toggle', key: 'enableDynamicTableViews', disabled: !contentEnabled || !settings.enabledFeatures.indexTables },
            },
            {
              name: 'Index tasks',
              desc: 'Parse Markdown tasks (checkboxes) into structured data. When enabled, tasks become queryable with metadata like completion status, priority, due dates, and tags.',
              control: { type: 'toggle', key: 'feature:indexTasks', disabled: !contentEnabled },
            },
          ],
        },
        {
          type: 'group',
          heading: 'Other files',
          items: [
            {
              name: 'Index CSV and JSON files',
              desc: `Load CSV and JSON contents into tables for files sized up to ${settings.dataFileMaxSizeMiB} MiB`,
              control: { type: 'toggle', key: 'enableDataFileReads' },
            },
            {
              name: 'Remote CSV and JSON',
              desc: 'Load CSV and JSON tables from public HTTPS URLs',
              control: { type: 'toggle', key: 'enableRemoteDataReads' },
            },
            {
              name: 'Index image metadata',
              desc: 'Index camera, date, and location details from images',
              control: { type: 'toggle', key: 'indexImageMetadata' },
            },
            {
              name: 'Index other file content',
              desc: 'Comma-separated file extensions',
              control: { type: 'text', key: 'otherFileContentExtensions', placeholder: 'gpx, geojson, fit' },
            },
          ],
        },
        {
          type: 'list',
          heading: 'External folders',
          emptyState: this.external.files
            ? 'No external folders. Only files in the vault are indexed.'
            : `${UNAVAILABLE_FOLDERS}.`,
          onDelete: (index) => this.removeExternalRoot(index),
          addItem: {
            name: 'Add external folder',
            action: () => {
              this.plugin.settings.externalRoots.push({ path: '', extensions: [], refresh: 'watch', refreshMinutes: DEFAULT_REFRESH_MINUTES });
              void this.plugin.saveSettings();
              this.update();
            },
          },
          items: settings.externalRoots.map((root, index): SettingGroupItem => ({
            type: 'page',
            name: `Folder ${index + 1}`,
            desc: root.path || 'No folder set',
            displayValue: root.extensions.length ? root.extensions.join(', ') : 'No file types',
            items: [
              {
                name: 'Folder',
                desc: this.externalRootDescription(root.path),
                control: { type: 'text', key: `${EXTERNAL_ROOT_PATH_PREFIX}${index}`, placeholder: '/home/user/Photos' },
              },
              {
                name: 'File types',
                desc: 'Comma-separated file extensions, or * for all supported types',
                control: { type: 'text', key: `${EXTERNAL_ROOT_EXTENSIONS_PREFIX}${index}`, placeholder: 'jpg, heic, csv or *' },
              },
              {
                name: 'Check for changes',
                desc: this.external.watch
                  ? 'When files change uses file notifications. On a schedule rescans at the configured interval.'
                  : 'This device uses scheduled rescans for the When files change mode',
                control: { type: 'dropdown', key: `${EXTERNAL_ROOT_REFRESH_PREFIX}${index}`, options: REFRESH_MODE_LABELS },
              },
              {
                name: 'Minutes between checks',
                desc: 'Default: 15 minutes',
                control: { type: 'number', key: `${EXTERNAL_ROOT_MINUTES_PREFIX}${index}`, min: 1, max: 1440,
                  disabled: () => this.scheduledRefresh(index) !== 'interval' },
              },
              {
                name: 'Status',
                desc: this.externalRootStatus(root.path),
                render: (setting) => this.renderExternalStatus(setting, index),
              },
              {
                name: '',
                render: (setting) => {
                  setting.addButton(button => button.setButtonText('Remove folder').setDestructive().onClick(() => {
                    closeSettingsPage(this.app);
                    this.removeExternalRoot(index);
                  }));
                },
              },
            ],
          })),
        },
        {
          type: 'list',
          heading: 'Exclude patterns',
          emptyState: 'No exclude patterns.',
          onDelete: (index) => {
            this.plugin.settings.excludePatterns.splice(index, 1);
            void this.plugin.saveSettings({ requiresFullReindex: true });
            this.update();
          },
          addItem: {
            name: 'Add exclude pattern',
            action: () => {
              this.plugin.settings.excludePatterns.push('\\.tmp$');
              void this.plugin.saveSettings({ requiresFullReindex: true });
              this.update();
            },
          },
          items: [...settings.excludePatterns.keys()].map((index): SettingGroupItem => ({
            name: `Pattern ${index + 1}`,
            desc: 'Files and folders matching these patterns will not be indexed. Use regular expressions like \\.tmp$ or ^temp/ or archive/',
            control: {
              type: 'text',
              key: `${EXCLUDE_PATTERN_KEY_PREFIX}${index}`,
              validate: (value) => (this.isValidRegex(value) ? undefined : 'Invalid regular expression'),
            },
          })),
        },
        {
          type: 'group',
          heading: 'Indexing actions',
          items: [
            {
              name: 'Rebuild index',
              desc: 'Force a complete rebuild of the vault index',
              render: (setting) => this.renderRebuildButton(setting),
            },
            {
              name: 'View performance stats',
              desc: 'View detailed performance statistics from the last indexing operation',
              render: (setting) => {
                setting.addButton(button => button
                  .setButtonText('View stats')
                  .onClick(() => {
                    const api = this.plugin.api;
                    if (!api) return;

                    const stats = api.getPerformanceStats();
                    new IndexingStatsModal(this.app, stats).open();
                  }));
              },
            },
          ],
        },
      ],
    };
  }

  private buildQueriesPage({ settings }: SettingsUiState): SettingDefinitionPage {
    return {
      type: 'page',
      name: 'Queries and output',
      displayValue: settings.workerQueries ? 'Background queries' : 'Main thread queries',
      items: [
        {
          type: 'group',
          heading: 'Query execution',
          items: [
            {
              name: 'Background query execution',
              desc: 'Run read queries in the background using a separate copy of the index. Requires additional memory and a restart.',
              control: { type: 'toggle', key: 'workerQueries' },
            },
          ],
        },
        {
          type: 'group',
          heading: 'Result display',
          items: [
            {
              name: 'Auto-refresh grids',
              desc: 'Automatically refresh SlickGrid query tables when indexed files change. Defaults to off; individual query blocks can override this with `config: autoRefresh: true` or `config: autoRefresh: false`.',
              control: { type: 'toggle', key: 'autoRefreshOnIndexChange' },
            },
            {
              name: 'View preview limit',
              desc: 'Number of rows to show in vaultquery-view block previews. Set to 0 to disable previews.',
              control: { type: 'number', key: 'viewPreviewLimit', placeholder: '10', min: 0 },
            },
            {
              name: 'Export folder',
              desc: 'Path relative to the vault root',
              control: { type: 'text', key: 'exportFolder', placeholder: 'VaultQuery Exports' },
            },
          ],
        },
      ],
    };
  }

  private buildNaturalLanguagePage({ settings, isRealtimeIndexing, writeEnabled }: SettingsUiState): SettingDefinitionPage {
    const defaultProvider = settings.llm.providers.find(provider => provider.id === settings.llm.defaultProviderId);

    return {
      type: 'page',
      name: 'Natural language',
      displayValue: settings.llm.enabled ? (defaultProvider?.name ?? 'Provider needed') : 'Off',
      status: settings.llm.enabled && !defaultProvider ? 'warning' : null,
      items: [
        {
          type: 'group',
          heading: 'Access and providers',
          items: [
            {
              name: 'Enable natural language queries',
              aliases: ['Natural language', 'LLM'],
              desc: 'Translate plain-language questions into SQL with a language model. Questions and the database schema are sent to the selected provider.',
              control: { type: 'toggle', key: 'llmEnabled' },
            },
            {
              name: 'Show generated query',
              desc: 'Display the generated SQL and output configuration above its results or change preview. A block can override this with `config: showSql: true` or `config: showSql: false`.',
              control: { type: 'toggle', key: 'llmShowSql' },
            },
            {
              name: 'Allow natural language changes',
              aliases: ['Natural language writes', 'LLM writes'],
              desc: writeEnabled
                ? 'Allow plain-language requests to generate INSERT, UPDATE, and DELETE statements.'
                : 'Natural language changes require global write operations to be enabled first.',
              control: { type: 'toggle', key: 'llmAllowWriteOperations', disabled: !isRealtimeIndexing || !writeEnabled },
            },
            {
              name: 'Providers',
                      render: (setting) => {
                setting.addButton(button => button
                  .setButtonText('Add provider')
                  .setCta()
                  .onClick(() => {
                    this.openProviderEditor(null);
                  }));
              },
            },
            {
              name: '',
              desc: 'No providers configured.',
              visible: settings.llm.providers.length === 0,
            },
            ...settings.llm.providers.map((provider): SettingGroupItem => ({
              name: provider.name,
              desc: this.describeProvider(provider),
              searchable: false,
              render: (setting) => this.renderProviderRow(setting, provider),
            })),
          ],
        },
      ],
    };
  }

  private buildChangesPage({ settings, isRealtimeIndexing, writeEnabled }: SettingsUiState): SettingDefinitionPage {
    return {
      type: 'page',
      name: 'Changes and automation',
      displayValue: writeEnabled ? 'Writes enabled' : 'Read-only',
      items: [
        {
          type: 'group',
          heading: 'Write permissions',
          items: [
            {
              name: 'Enable write operations',
              desc: isRealtimeIndexing
                ? 'Allow SQL to create, update, and delete notes, CSV and JSON records, and other files.'
                : 'Write operations require real-time indexing mode. Changes made to files must be immediately re-indexed to keep the database in sync. Switch to real-time indexing to enable this feature.',
              control: { type: 'toggle', key: 'allowWriteOperations', disabled: !isRealtimeIndexing },
            },
            {
              name: 'Allow file deletion',
              aliases: ['File deletion'],
              desc: 'Allow DELETE FROM notes to delete files from the vault. This is a destructive operation. Files are moved to trash, not permanently deleted.',
              control: { type: 'toggle', key: 'allowDeleteNotes', disabled: !isRealtimeIndexing || !writeEnabled },
            },
          ],
        },
        {
          type: 'group',
          heading: 'Inline actions',
          items: [
            {
              name: 'Enable inline buttons',
              aliases: ['Inline buttons'],
              desc: 'Allow inline SQL buttons using the syntax `vq[Label]{SQL}`. Buttons execute SQL immediately without preview. SELECT queries copy results to clipboard. Requires "Enable write operations" to be on.',
              control: { type: 'toggle', key: 'enableInlineButtons', disabled: !isRealtimeIndexing || !writeEnabled },
            },
            {
              name: 'Inline button debounce',
              desc: 'Minimum time between button clicks in milliseconds. Increase if edits are being lost due to rapid button clicks. Default is 500ms.',
              control: { type: 'number', key: 'inlineButtonDebounceMs', placeholder: '500', min: 0, disabled: !isRealtimeIndexing || !writeEnabled || !settings.enableInlineButtons },
            },
          ],
        },
        {
          type: 'group',
          heading: 'Scripts and triggers',
          items: [
            {
              name: 'Enable JavaScript SQL functions',
              aliases: ['JavaScript SQL functions'],
              desc: 'Allow vaultquery-function blocks to register user-authored JavaScript functions for SQL queries.',
              control: { type: 'toggle', key: 'enableJavaScriptFunctions' },
            },
            {
              name: 'Enable JavaScript rendering',
              aliases: ['JavaScript rendering'],
              desc: 'Allow vaultquery blocks to execute user-authored JavaScript rendering code from template sections.',
              control: { type: 'toggle', key: 'enableJavaScriptRendering' },
            },
            {
              name: 'Enable triggers',
              aliases: ['Triggers'],
              desc: 'Allow vaultquery-trigger code blocks to register database triggers that can automatically modify files. Triggers can set properties, rename notes, and replace content when data changes.',
              control: { type: 'toggle', key: 'enableTriggers', disabled: !isRealtimeIndexing || !writeEnabled },
            },
          ],
        },
      ],
    };
  }

  private buildIntegrationsPage({ settings, isRealtimeIndexing, writeEnabled }: SettingsUiState): SettingDefinitionPage {
    return {
      type: 'page',
      name: 'Integrations',
      items: [
        {
          type: 'group',
          heading: 'Obsidian CLI',
          items: [
            {
              name: 'Enable CLI',
              desc: 'Allow Obsidian CLI commands for VaultQuery. Enables `vaultquery:query` for read-only SQL queries.',
              control: { type: 'toggle', key: 'enableCli' },
            },
            {
              name: 'Enable CLI write operations',
              aliases: ['CLI write operations'],
              desc: 'Allow `vaultquery:query` to run INSERT, UPDATE, and DELETE statements from the Obsidian CLI. Requires CLI and write operations to be enabled.',
              control: { type: 'toggle', key: 'enableCliWriteOperations', disabled: !settings.enableCli || !isRealtimeIndexing || !writeEnabled },
            },
          ],
        },
        {
          type: 'group',
          heading: 'Plugin integrations',
          items: [
            {
              name: 'Third-party provider tables',
              desc: 'Allow third-party plugins to register third-party provider tables, discover provider definition code blocks, and refresh provider rows for SQL queries.',
              control: { type: 'toggle', key: 'enableThirdPartyProviderTables' },
            },
          ],
        },
      ],
    };
  }

  private buildAdvancedPage({ settings }: SettingsUiState): SettingDefinitionPage {
    return {
      type: 'page',
      name: 'Advanced',
      items: [
        {
          type: 'group',
          heading: 'SQLite runtime',
          items: [
            {
              name: 'SQL.js WASM source',
              desc: 'Controls how the SQLite WebAssembly binary is loaded. Auto uses a local file when present and falls back to sql.js.org. Local only never uses the network. CDN only always downloads from sql.js.org.',
              control: {
                type: 'dropdown',
                key: 'wasmSource',
                options: { auto: 'Auto (local, then CDN)', local: 'Local only', cdn: 'CDN only' },
              },
            },
            {
              name: 'Cache WASM locally',
              desc: 'Saves a CDN-loaded SQL.js WASM binary to the plugin folder for later local loading.',
              visible: settings.wasm.source !== 'local',
              control: { type: 'toggle', key: 'wasmCacheLocally' },
            },
            {
              name: 'Custom WASM path',
              desc: 'Optional path to sql-wasm.wasm. Empty uses the plugin folder. Absolute paths and vault-relative paths are supported.',
              visible: settings.wasm.source !== 'cdn',
              control: { type: 'text', key: 'wasmCustomPath', placeholder: 'Leave empty for default' },
            },
          ],
        },
        {
          type: 'group',
          heading: 'Debug',
          items: [
            {
              name: 'Console log level',
              desc: 'Controls which VaultQuery logs are written to the developer console. The copied debug log always includes all captured entries.',
              control: {
                type: 'dropdown',
                key: 'consoleLogLevel',
                options: { none: 'None', error: 'Errors', warn: 'Warnings and errors', info: 'Info, warnings, and errors', debug: 'Debug and above' },
              },
            },
          ],
        },
      ],
    };
  }

  private get external(): ExternalCapabilities {
    return externalCapabilities(this.app);
  }

  private removeExternalRoot(index: number): void {
    this.plugin.settings.externalRoots.splice(index, 1);
    void this.plugin.saveSettings();
    this.update();
  }

  private scheduledRefresh(index: number): ExternalRefreshMode {
    return effectiveRefreshMode(normalizeRefreshMode(this.plugin.settings.externalRoots[index]?.refresh), this.external.watch);
  }

  private externalRootStatus(path: string): string {
    if (!this.external.files) return 'Files already indexed stay queryable; this device cannot read the folder';
    const status = this.plugin.api?.getExternalRootStatus().find(root => root.path === normalizeRootPath(path));
    if (!status) return 'Not scanned yet';
    const found = status.filesFound.toLocaleString();
    const indexed = status.filesIndexed.toLocaleString();
    if (status.scanning) return `Scanning. ${found} files found, ${indexed} indexed`;
    const failures = status.failures.length ? `, ${status.failures.length} failed` : '';

    if (status.state !== 'ready') {
      return retainsRows(status.state) ? `${status.error ?? 'Unavailable'} ${indexed} indexed files stay queryable${failures}` : status.error ?? 'Unavailable';
    }

    const scanned = status.lastScanCompleted ? new Date(status.lastScanCompleted).toLocaleString() : 'not yet';

    // The file types above decide what a scan collects; the settings for each
    // kind decide what indexes it. A folder read in full can still hold nothing.
    if (status.filesSkipped > 0 && status.filesIndexed === 0) {
      return `${found} files found, none indexed. Turn on the setting for their file types under Other files${failures}`;
    }

    const skipped = status.filesSkipped ? `, ${status.filesSkipped.toLocaleString()} skipped` : '';
    const progress = status.filesIndexed < status.filesFound ? `${indexed} of ${found} files indexed` : `${found} files indexed`;

    return `${progress}${skipped}${failures}, last scanned ${scanned}`;
  }

  private renderExternalStatus(setting: Setting, index: number): void {
    this.externalStatusRows.set(index, setting);
    setting.setDesc(this.externalRootStatus(this.externalRootPath(index)));

    setting.addButton(button => button
      .setButtonText('Rescan')
      .setDisabled(!this.external.files)
      .onClick(() => {
        const api = this.plugin.api;
        const path = this.externalRootPath(index);
        if (!api || !path) return;
        button.setButtonText('Scanning...');
        button.setDisabled(true);

        api.refreshExternalRoot(path)
          .catch((error: unknown) => logger.error('External folder could not be rescanned', error))
          .finally(() => {
            button.setButtonText('Rescan');
            button.setDisabled(false);
            this.refreshExternalStatus();
          });
      }));
  }

  public refreshExternalStatus(): void {
    for (const [index, setting] of this.externalStatusRows) {
      setting.setDesc(this.externalRootStatus(this.externalRootPath(index)));
    }

    this.refreshDomState();
  }

  private externalRootPath(index: number): string {
    return this.plugin.settings.externalRoots[index]?.path ?? '';
  }

  private externalRootDescription(path: string): string {
    if (!this.external.files) return UNAVAILABLE_FOLDERS;
    const status = this.plugin.api?.getExternalRootStatus().find(root => root.path === normalizeRootPath(path));
    if (!status || status.state === 'ready') return 'Absolute path to a folder outside the vault';

    return status.error ?? 'This folder could not be used';
  }

  public getControlValue(key: string): unknown {
    const { control, id } = resolveControl(key);

    return control.get(this.plugin.settings, id);
  }

  public async setControlValue(key: string, value: unknown): Promise<void> {
    const { control, id } = resolveControl(key);
    if (control.accepts && !control.accepts(value)) return;
    control.set(this.plugin.settings, value, id);

    await this.plugin.saveSettings(control.reindex || REINDEX_KEYS.has(key) ? { requiresFullReindex: true } : undefined);

    if (control.refreshState) this.refreshDomState();

    if (UPDATE_KEYS.has(key)) {
      this.update();
    }
  }

  private describeProvider(provider: LlmProviderConfig): string {
    const parts = ['Endpoint'];
    if (provider.model?.trim()) parts.push(provider.model);
    if (provider.id === this.plugin.settings.llm.defaultProviderId) parts.push('Default');

    return parts.join(' - ');
  }

  private renderProviderRow(setting: Setting, provider: LlmProviderConfig): void {
    const isDefault = provider.id === this.plugin.settings.llm.defaultProviderId;

    setting.addExtraButton(button => button
      .setIcon(isDefault ? 'check' : 'circle')
      .setTooltip(isDefault ? 'Default provider' : 'Set as default')
      .setDisabled(isDefault)
      .onClick(() => {
        void this.setDefaultProvider(provider.id);
      }));

    setting.addExtraButton(button => button
      .setIcon('pencil')
      .setTooltip('Edit provider')
      .onClick(() => {
        this.openProviderEditor(provider);
      }));

    setting.addExtraButton(button => button
      .setIcon('trash')
      .setTooltip('Delete provider')
      .onClick(() => {
        void this.deleteProvider(provider.id);
      }));
  }

  private openProviderEditor(provider: LlmProviderConfig | null): void {
    new LlmProviderModal(this.app, provider, (result) => {
      void this.saveProvider(result);
    }).open();
  }

  private async saveProvider(provider: LlmProviderConfig): Promise<void> {
    const llm = this.plugin.settings.llm;
    const index = llm.providers.findIndex(existing => existing.id === provider.id);

    if (index === -1) {
      llm.providers.push(provider);
    }
    else {
      llm.providers[index] = provider;
    }

    if (llm.defaultProviderId === null) {
      llm.defaultProviderId = provider.id;
    }

    await this.plugin.saveSettings();
    this.update();
  }

  private async deleteProvider(id: string): Promise<void> {
    const llm = this.plugin.settings.llm;
    llm.providers = llm.providers.filter(provider => provider.id !== id);

    await this.plugin.saveSettings();
    this.update();
  }

  private async setDefaultProvider(id: string): Promise<void> {
    this.plugin.settings.llm.defaultProviderId = id;

    await this.plugin.saveSettings();
    this.update();
  }

  private renderRebuildButton(setting: Setting): void {
    setting.addButton(button => button
      .setButtonText('Rebuild index')
      .onClick(() => {
        const api = this.plugin.api;

        if (!api) {
          button.setButtonText('VaultQuery not ready');

          window.setTimeout(() => {
            button.setButtonText('Rebuild index');
          }, 2000);

          return;
        }

        button.setButtonText('Rebuilding...');
        button.setDisabled(true);

        const rebuildPromise = api.forceReindexVault();

        const checkProgress = () => {
          const status = api.getIndexingStatus();

          if (status.isIndexing && status.progress) {
            const percentage = Math.round((status.progress.current / status.progress.total) * 100);
            button.setButtonText(`Rebuilding... ${percentage}%`);
            window.setTimeout(checkProgress, 500);
          }
        };

        window.setTimeout(checkProgress, 100);

        rebuildPromise.then(() => {
          button.setButtonText('Rebuild complete');

          window.setTimeout(() => {
            button.setButtonText('Rebuild index');
            button.setDisabled(false);
          }, 3000);
        }).catch((error: unknown) => {
          logger.error('Failed to rebuild index', error);
          button.setButtonText('Error');

          window.setTimeout(() => {
            button.setButtonText('Rebuild index');
            button.setDisabled(false);
          }, 2000);
        });
      }));
  }

  private isValidRegex(pattern: string): boolean {
    if (!pattern.trim()) return false;

    try {
      new RegExp(pattern);

      return true;
    }
    catch {
      return false;
    }
  }
}
