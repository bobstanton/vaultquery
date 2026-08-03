import { App, PluginSettingTab } from 'obsidian';
import type { Setting, SettingDefinitionItem, SettingGroupItem } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { IndexingStatsModal } from '../Modals/IndexingStatsModal';
import type { ContentRenderingMode, WasmSource } from './Settings';
import type { ConsoleLogLevel } from 'obsidian-debug-logger';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('Settings');

const FEATURE_KEY_PREFIX = 'feature:';
const EXCLUDE_PATTERN_KEY_PREFIX = 'excludePattern:';
const REINDEX_KEYS = new Set(['maxFileSizeKB', 'enableDynamicTableViews', 'enableJavaScriptFunctions', 'enableThirdPartyProviderTables']);
const UPDATE_KEYS = new Set(['indexingInterval', 'feature:indexContent', 'feature:indexTables', 'allowWriteOperations', 'enableInlineButtons', 'enableCli', 'enableCliWriteOperations', 'wasmSource']);

export class VaultQuerySettingTab extends PluginSettingTab {
  plugin: VaultQueryPluginContext;

  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const isRealtimeIndexing = settings.indexingInterval === 'realtime';
    const contentEnabled = settings.enabledFeatures.indexContent;
    const writeEnabled = settings.allowWriteOperations;

    return [
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
        desc: 'Files larger than this size in kilobytes will be skipped during indexing. Default is 1000 kb (1 mb).',
        control: { type: 'number', key: 'maxFileSizeKB', placeholder: '1000', min: 1 },
      },
      {
        name: 'Database storage',
        desc: 'Choose how to store the database. Disk storage persists between sessions. Memory storage is faster but requires re-indexing on startup.',
        control: {
          type: 'dropdown',
          key: 'databaseStorage',
          options: { disk: 'Disk storage (persistent)', memory: 'Memory storage (faster)' },
        },
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
        type: 'list',
        heading: 'Exclude patterns',
        emptyState: 'No exclude patterns. Every file is indexed.',
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
        heading: 'Write operations',
        items: [
          {
            name: 'Enable write operations',
            desc: isRealtimeIndexing
              ? 'Allow update and insert SQL commands to modify notes in the vault. There is no undo or version history built into VaultQuery. Use Obsidian Sync for version history.'
              : 'Write operations require real-time indexing mode. Changes made to files must be immediately re-indexed to keep the database in sync. Switch to real-time indexing to enable this feature.',
            control: { type: 'toggle', key: 'allowWriteOperations', disabled: !isRealtimeIndexing },
          },
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
          {
            name: 'Allow file deletion',
            aliases: ['File deletion'],
            desc: 'Allow DELETE FROM notes to delete files from the vault. This is a destructive operation. Files are moved to trash, not permanently deleted.',
            control: { type: 'toggle', key: 'allowDeleteNotes', disabled: !isRealtimeIndexing || !writeEnabled },
          },
          {
            name: 'Background query execution',
            desc: 'Serve read queries from a worker mirror of the index so large queries do not freeze the UI. Takes effect after restart.',
            control: { type: 'toggle', key: 'workerQueries' },
          },
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
          {
            name: 'Third-party provider tables',
            desc: 'Allow third-party plugins to register third-party provider tables, discover provider definition code blocks, and refresh provider rows for SQL queries.',
            control: { type: 'toggle', key: 'enableThirdPartyProviderTables' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Result display',
        items: [
          {
            name: 'Content column display',
            desc: 'Choose how note content is displayed in query results. Plain text is recommended because rendered Markdown can recurse when a query returns the current note.',
            control: {
              type: 'dropdown',
              key: 'contentRenderingMode',
              options: { 'plain-text': 'Plain text (recommended)', 'rendered-markdown': 'Rendered Markdown' },
            },
          },
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
        ],
      },
      {
        type: 'group',
        heading: 'Advanced',
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
          {
            name: 'Index on background thread',
            desc: 'Run initial indexing in a background thread to keep the UI responsive. After indexing completes, switches to main thread for fast queries. Requires restart to take effect.',
            control: { type: 'toggle', key: 'backgroundIndexing' },
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
                  if (!api) {
                    return;
                  }

                  const stats = api.getPerformanceStats();
                  new IndexingStatsModal(this.app, stats).open();
                }));
            },
          },
        ],
      },
    ];
  }

  public getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    if (key.startsWith(FEATURE_KEY_PREFIX)) {
      return settings.enabledFeatures[key.slice(FEATURE_KEY_PREFIX.length) as keyof typeof settings.enabledFeatures];
    }
    if (key.startsWith(EXCLUDE_PATTERN_KEY_PREFIX)) {
      return settings.excludePatterns[Number(key.slice(EXCLUDE_PATTERN_KEY_PREFIX.length))];
    }
    switch (key) {
      case 'wasmSource': return settings.wasm.source;
      case 'wasmCacheLocally': return settings.wasm.cacheLocally;
      case 'wasmCustomPath': return settings.wasm.customPath;
      case 'consoleLogLevel': return settings.debugConsoleLogLevel;
      default: return (settings as unknown as Record<string, unknown>)[key];
    }
  }

  public async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    let requiresFullReindex = REINDEX_KEYS.has(key);

    if (key.startsWith(FEATURE_KEY_PREFIX)) {
      settings.enabledFeatures[key.slice(FEATURE_KEY_PREFIX.length) as keyof typeof settings.enabledFeatures] = value === true;
      requiresFullReindex = true;
    }
    else if (key.startsWith(EXCLUDE_PATTERN_KEY_PREFIX)) {
      settings.excludePatterns[Number(key.slice(EXCLUDE_PATTERN_KEY_PREFIX.length))] = typeof value === 'string' ? value : '';
      requiresFullReindex = true;
    }
    else {
      switch (key) {
        case 'indexingInterval':
          settings.indexingInterval = value as 'realtime' | 'manual' | 'startup';
          break;
        case 'maxFileSizeKB': {
          const size = Math.trunc(Number(value));
          if (!Number.isFinite(size) || size <= 0) return;
          settings.maxFileSizeKB = size;
          break;
        }
        case 'inlineButtonDebounceMs': {
          const ms = Math.trunc(Number(value));
          if (!Number.isFinite(ms) || ms < 0) return;
          settings.inlineButtonDebounceMs = ms;
          break;
        }
        case 'viewPreviewLimit': {
          const limit = Math.trunc(Number(value));
          if (!Number.isFinite(limit) || limit < 0) return;
          settings.viewPreviewLimit = limit;
          break;
        }
        case 'enableCli':
          settings.enableCli = value === true;
          if (!settings.enableCli) {
            settings.enableCliWriteOperations = false;
          }
          break;
        case 'wasmSource':
          settings.wasm.source = value as WasmSource;
          break;
        case 'wasmCacheLocally':
          settings.wasm.cacheLocally = value === true;
          break;
        case 'wasmCustomPath':
          settings.wasm.customPath = (typeof value === 'string' ? value : '').trim();
          break;
        case 'contentRenderingMode':
          settings.contentRenderingMode = value as ContentRenderingMode;
          break;
        case 'consoleLogLevel':
          settings.debugConsoleLogLevel = value as ConsoleLogLevel;
          break;
        default:
          (settings as unknown as Record<string, unknown>)[key] = value;
      }
    }

    await this.plugin.saveSettings(requiresFullReindex ? { requiresFullReindex: true } : undefined);

    if (UPDATE_KEYS.has(key)) {
      this.update();
    }
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
