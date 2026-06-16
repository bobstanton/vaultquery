import { App, PluginSettingTab, Setting } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { IndexingStatsModal } from '../Modals/IndexingStatsModal';
import type { ContentRenderingMode, WasmSource } from './Settings';
import type { ConsoleLogLevel } from 'obsidian-debug-logger';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('Settings');

export class VaultQuerySettingTab extends PluginSettingTab {
  plugin: VaultQueryPluginContext;

  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderSettings();
  }

  /**
   * Re-render settings while preserving scroll position
   */
  private refreshDisplay(): void {
    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    this.renderSettings();
    containerEl.scrollTop = scrollTop;
  }

  private renderSettings(): void {
    const { containerEl } = this;

    new Setting(containerEl)
      .setName('Indexing mode')
      .setDesc('Choose when to index notes. Real-time keeps the index always up-to-date, startup indexes once when the app starts, and manual requires clicking the "Rebuild index" button below.')
      .addDropdown(dropdown => dropdown
        .addOption('realtime', 'Real-time')
        .addOption('startup', 'On startup only')
        .addOption('manual', 'Manual only')
        .setValue(this.plugin.settings.indexingInterval)
        .onChange((value: string) => {
          this.plugin.settings.indexingInterval = value as 'realtime' | 'manual' | 'startup';

          if (value !== 'realtime') {
            this.plugin.settings.allowWriteOperations = false;
            this.plugin.settings.allowDeleteNotes = false;
            this.plugin.settings.enableTriggers = false;
            this.plugin.settings.enableInlineButtons = false;
            this.plugin.settings.enableCliWriteOperations = false;
          }

          void this.plugin.saveSettings();
          this.refreshDisplay();
        }));

    new Setting(containerEl)
      .setName('Maximum file size (KB)')
      .setDesc('Files larger than this size in kilobytes will be skipped during indexing. Default is 1000 kb (1 mb).')
      .addText(text => text
        .setPlaceholder('1000')
        .setValue(this.plugin.settings.maxFileSizeKB.toString())
        .onChange((value) => {
          const size = parseInt(value);
          if (!isNaN(size) && size > 0) {
            this.plugin.settings.maxFileSizeKB = size;
            void this.plugin.saveSettings({ requiresFullReindex: true });
          }
        }));

    new Setting(containerEl)
      .setName('Database storage')
      .setDesc('Choose how to store the database. Disk storage persists between sessions. Memory storage is faster but requires re-indexing on startup.')
      .addDropdown(dropdown => dropdown
        .addOption('disk', 'Disk storage (persistent)')
        .addOption('memory', 'Memory storage (faster)')
        .setValue(this.plugin.settings.databaseStorage)
        .onChange((value: string) => {
          this.plugin.settings.databaseStorage = value as 'memory' | 'disk';
          void this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Metadata-only indexing')
      .setHeading()
      .setDesc('These features use Obsidian\'s metadata cache without loading the entire file.');

    new Setting(containerEl)
      .setName('Index frontmatter')
      .setDesc('Index frontmatter properties. Also creates a notes_with_properties view where each property key becomes a column.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexFrontmatter)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexFrontmatter = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        }));

    new Setting(containerEl)
      .setName('Index headings')
      .setDesc('Index Markdown headings (h1-h6) into structured data.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexHeadings)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexHeadings = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        }));

    new Setting(containerEl)
      .setName('Index links')
      .setDesc('Index internal links between notes.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexLinks)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexLinks = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        }));

    new Setting(containerEl)
      .setName('Index tags')
      .setDesc('Index hashtags found in notes.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexTags)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexTags = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        }));

    new Setting(containerEl)
      .setName('Index list items')
      .setDesc('Index bulleted and numbered list items. Excludes task items (use Index tasks for those).')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexListItems)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexListItems = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        }));

    new Setting(containerEl)
      .setName('Content-dependent indexing')
      .setHeading()
      .setDesc('These features require loading the full content of each note, which may impact performance on large vaults.');

    const contentEnabled = this.plugin.settings.enabledFeatures.indexContent;

    new Setting(containerEl)
      .setName('Index note content')
      .setDesc('Include the full text content of notes in the database. Disabling this will also disable tables and tasks indexing.')
      .addToggle(toggle => {
        toggle
          .setValue(contentEnabled)
          .onChange((value) => {
            this.plugin.settings.enabledFeatures.indexContent = value;
            // When disabling content indexing, also disable dependent features
            if (!value) {
              this.plugin.settings.enabledFeatures.indexTables = false;
              this.plugin.settings.enabledFeatures.indexTasks = false;
              this.plugin.settings.enableDynamicTableViews = false;
            }
            void this.plugin.saveSettings({ requiresFullReindex: true });
            this.refreshDisplay();
          });
      });

    new Setting(containerEl)
      .setName('Index tables')
      .setDesc('Parse Markdown tables into structured data. When enabled, each table cell becomes queryable, and tables can be referenced by their position or the heading above them.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexTables)
        .setDisabled(!contentEnabled)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexTables = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
          this.refreshDisplay();
        }));

    new Setting(containerEl)
      .setName('Enable dynamic table views')
      .setDesc('Automatically create simplified SQL views for each unique table structure. Requires "Index tables" to be enabled. A full reindex is needed for changes to take effect.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableDynamicTableViews)
        .setDisabled(!contentEnabled || !this.plugin.settings.enabledFeatures.indexTables)
        .onChange((value) => {
          this.plugin.settings.enableDynamicTableViews = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        })
      );

    new Setting(containerEl)
      .setName('Index tasks')
      .setDesc('Parse Markdown tasks (checkboxes) into structured data. When enabled, tasks become queryable with metadata like completion status, priority, due dates, and tags.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexTasks)
        .setDisabled(!contentEnabled)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexTasks = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        }));


    new Setting(containerEl)
      .setName('Exclude patterns')
      .setHeading()
      .setDesc('Files and folders matching these patterns will not be indexed. Use regular expressions like \\.tmp$ or ^temp/ or archive/');

    this.plugin.settings.excludePatterns.forEach((pattern, index) => {
      new Setting(containerEl)
        .setName(`Pattern ${index + 1}`)
        .addText(text => {
          text.setValue(pattern);
          
          if (!this.isValidRegex(pattern)) {
            text.inputEl.addClass('mod-warning');
            text.inputEl.title = 'Invalid regular expression';
          }
          
          text.onChange((value) => {
            if (!this.isValidRegex(value)) {
              text.inputEl.addClass('mod-warning');
              text.inputEl.title = 'Invalid regular expression';
              return;
            }

            text.inputEl.removeClass('mod-warning');
            text.inputEl.title = '';

            this.plugin.settings.excludePatterns[index] = value;
            void this.plugin.saveSettings({ requiresFullReindex: true });
          });
        })
        .addButton(button => button
          .setButtonText('Remove')
          .setWarning()
          .onClick(() => {
            this.plugin.settings.excludePatterns.splice(index, 1);
            void this.plugin.saveSettings({ requiresFullReindex: true });
            this.refreshDisplay();
          }));
    });

    new Setting(containerEl)
      .addButton(button => button
        .setButtonText('Add exclude pattern')
        .setCta()
        .onClick(() => {
          this.plugin.settings.excludePatterns.push('\\.tmp$');
          void this.plugin.saveSettings({ requiresFullReindex: true });
          this.refreshDisplay();
        }));

    new Setting(containerEl)
      .setName('Write operations')
      .setHeading();

    const isRealtimeIndexing = this.plugin.settings.indexingInterval === 'realtime';
    const writeEnabled = this.plugin.settings.allowWriteOperations;

    new Setting(containerEl)
      .setName('Enable write operations')
      .setDesc(isRealtimeIndexing
        ? 'Allow update and insert SQL commands to modify notes in the vault. There is no undo or version history built into VaultQuery. Use Obsidian Sync for version history.'
        : 'Write operations require real-time indexing mode. Changes made to files must be immediately re-indexed to keep the database in sync. Switch to real-time indexing to enable this feature.')
      .addToggle(toggle => toggle
        .setValue(writeEnabled)
        .setDisabled(!isRealtimeIndexing)
        .onChange((value) => {
          this.plugin.settings.allowWriteOperations = value;
          // When disabling write operations, also disable dependent features
          if (!value) {
            this.plugin.settings.enableInlineButtons = false;
            this.plugin.settings.allowDeleteNotes = false;
            this.plugin.settings.enableTriggers = false;
            this.plugin.settings.enableCliWriteOperations = false;
          }
          void this.plugin.saveSettings();
          this.refreshDisplay();
        })
      );

    const inlineButtonsEnabled = isRealtimeIndexing && writeEnabled && this.plugin.settings.enableInlineButtons;

    new Setting(containerEl)
      .setName('Enable inline buttons')
      .setDesc('Allow inline SQL buttons using the syntax `vq[Label]{SQL}`. Buttons execute SQL immediately without preview. SELECT queries copy results to clipboard. Requires "Enable write operations" to be on.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableInlineButtons)
        .setDisabled(!isRealtimeIndexing || !writeEnabled)
        .onChange((value) => {
          this.plugin.settings.enableInlineButtons = value;
          void this.plugin.saveSettings();
          this.refreshDisplay(); 
        })
      );

    new Setting(containerEl)
      .setName('Inline button debounce')
      .setDesc('Minimum time between button clicks in milliseconds. Increase if edits are being lost due to rapid button clicks. Default is 500ms.')
      .addText(text => text
        .setPlaceholder('500')
        .setValue(this.plugin.settings.inlineButtonDebounceMs.toString())
        .setDisabled(!inlineButtonsEnabled)
        .onChange((value) => {
          const ms = parseInt(value);
          if (!isNaN(ms) && ms >= 0) {
            this.plugin.settings.inlineButtonDebounceMs = ms;
            void this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Allow file deletion')
      .setDesc('Allow DELETE FROM notes to delete files from the vault. This is a destructive operation. Files are moved to trash, not permanently deleted.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.allowDeleteNotes)
        .setDisabled(!isRealtimeIndexing || !writeEnabled)
        .onChange((value) => {
          this.plugin.settings.allowDeleteNotes = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Enable JavaScript SQL functions')
      .setDesc('Allow vaultquery-function blocks to register user-authored JavaScript functions for SQL queries.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableJavaScriptFunctions)
        .onChange((value) => {
          this.plugin.settings.enableJavaScriptFunctions = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        })
      );

    new Setting(containerEl)
      .setName('Enable JavaScript rendering')
      .setDesc('Allow vaultquery blocks to execute user-authored JavaScript rendering code from template sections.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableJavaScriptRendering)
        .onChange((value) => {
          this.plugin.settings.enableJavaScriptRendering = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Enable triggers')
      .setDesc('Allow vaultquery-trigger code blocks to register database triggers that can automatically modify files. Triggers can set properties, rename notes, and replace content when data changes.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTriggers)
        .setDisabled(!isRealtimeIndexing || !writeEnabled)
        .onChange((value) => {
          this.plugin.settings.enableTriggers = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Obsidian CLI')
      .setHeading();

    new Setting(containerEl)
      .setName('Enable CLI')
      .setDesc('Allow Obsidian CLI commands for VaultQuery. Enables `vaultquery:query` for read-only SQL queries.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableCli)
        .onChange((value) => {
          this.plugin.settings.enableCli = value;
          if (!value) {
            this.plugin.settings.enableCliWriteOperations = false;
          }
          void this.plugin.saveSettings();
          this.refreshDisplay();
        })
      );

    new Setting(containerEl)
      .setName('Enable CLI write operations')
      .setDesc('Allow `vaultquery:query` to run INSERT, UPDATE, and DELETE statements from the Obsidian CLI. Requires CLI and write operations to be enabled.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableCliWriteOperations)
        .setDisabled(!this.plugin.settings.enableCli || !isRealtimeIndexing || !writeEnabled)
        .onChange((value) => {
          this.plugin.settings.enableCliWriteOperations = value;
          void this.plugin.saveSettings();
          this.refreshDisplay();
        })
      );

    new Setting(containerEl)
      .setName('Third-party provider tables')
      .setDesc('Allow third-party plugins to register third-party provider tables, discover provider definition code blocks, and refresh provider rows for SQL queries.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableThirdPartyProviderTables)
        .onChange((value) => {
          this.plugin.settings.enableThirdPartyProviderTables = value;
          void this.plugin.saveSettings({ requiresFullReindex: true });
        })
      );

    new Setting(containerEl)
      .setName('Result display')
      .setHeading();

    new Setting(containerEl)
      .setName('Content column display')
      .setDesc('Choose how note content is displayed in query results. Plain text is recommended because rendered Markdown can recurse when a query returns the current note.')
      .addDropdown(dropdown => dropdown
        .addOption('plain-text', 'Plain text (recommended)')
        .addOption('rendered-markdown', 'Rendered Markdown')
        .setValue(this.plugin.settings.contentRenderingMode)
        .onChange((value) => {
          this.plugin.settings.contentRenderingMode = value as ContentRenderingMode;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Auto-refresh grids')
      .setDesc('Automatically refresh SlickGrid query tables when indexed files change. Defaults to off; individual query blocks can override this with `config: autoRefresh: true` or `config: autoRefresh: false`.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoRefreshOnIndexChange)
        .onChange((value) => {
          this.plugin.settings.autoRefreshOnIndexChange = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('View preview limit')
      .setDesc('Number of rows to show in vaultquery-view block previews. Set to 0 to disable previews.')
      .addText(text => text
        .setPlaceholder('10')
        .setValue(this.plugin.settings.viewPreviewLimit.toString())
        .onChange((value) => {
          const limit = parseInt(value);
          if (!isNaN(limit) && limit >= 0) {
            this.plugin.settings.viewPreviewLimit = limit;
            void this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Advanced')
      .setHeading();

    new Setting(containerEl)
      .setName('SQL.js WASM source')
      .setDesc('Controls how the SQLite WebAssembly binary is loaded. Auto uses a local file when present and falls back to sql.js.org. Local only never uses the network. CDN only always downloads from sql.js.org.')
      .addDropdown(dropdown => dropdown
        .addOption('auto', 'Auto (local, then CDN)')
        .addOption('local', 'Local only')
        .addOption('cdn', 'CDN only')
        .setValue(this.plugin.settings.wasm.source)
        .onChange((value: string) => {
          this.plugin.settings.wasm.source = value as WasmSource;
          void this.plugin.saveSettings();
          this.refreshDisplay();
        }));

    const showCacheOption = this.plugin.settings.wasm.source !== 'local';
    if (showCacheOption) {
      new Setting(containerEl)
        .setName('Cache WASM locally')
        .setDesc('Saves a CDN-loaded SQL.js WASM binary to the plugin folder for later local loading.')
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.wasm.cacheLocally)
          .onChange((value) => {
            this.plugin.settings.wasm.cacheLocally = value;
            void this.plugin.saveSettings();
          }));
    }

    const showCustomPath = this.plugin.settings.wasm.source !== 'cdn';
    if (showCustomPath) {
      new Setting(containerEl)
        .setName('Custom WASM path')
        .setDesc('Optional path to sql-wasm.wasm. Empty uses the plugin folder. Absolute paths and vault-relative paths are supported.')
        .addText(text => text
          .setPlaceholder('Leave empty for default')
          .setValue(this.plugin.settings.wasm.customPath)
          .onChange((value) => {
            this.plugin.settings.wasm.customPath = value.trim();
            void this.plugin.saveSettings();
          }));
    }

    new Setting(containerEl)
      .setName('Index on background thread')
      .setDesc('Run initial indexing in a background thread to keep the UI responsive. After indexing completes, switches to main thread for fast queries. Requires restart to take effect.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.backgroundIndexing)
        .onChange((value) => {
          this.plugin.settings.backgroundIndexing = value;
          void this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Debug')
      .setHeading();

    new Setting(containerEl)
      .setName('Console log level')
      .setDesc('Controls which VaultQuery logs are written to the developer console. The copied debug log always includes all captured entries.')
      .addDropdown(dropdown => dropdown
        .addOption('none', 'None')
        .addOption('error', 'Errors')
        .addOption('warn', 'Warnings and errors')
        .addOption('info', 'Info, warnings, and errors')
        .addOption('debug', 'Debug and above')
        .setValue(this.plugin.settings.debugConsoleLogLevel)
        .onChange((value: string) => {
          this.plugin.settings.debugConsoleLogLevel = value as ConsoleLogLevel;
          void this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Indexing actions')
      .setHeading();

    new Setting(containerEl)
      .setName('Rebuild index')
      .setDesc('Force a complete rebuild of the vault index')
      .addButton(button => button
        .setButtonText('Rebuild index')
        .onClick(() => {
          button.setButtonText('Rebuilding...');
          button.setDisabled(true);

          const rebuildPromise = this.plugin.api.forceReindexVault();

          const checkProgress = () => {
            const status = this.plugin.api.getIndexingStatus();
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

    new Setting(containerEl)
      .setName('View performance stats')
      .setDesc('View detailed performance statistics from the last indexing operation')
      .addButton(button => button
        .setButtonText('View stats')
        .onClick(() => {
          const stats = this.plugin.api.getPerformanceStats();
          new IndexingStatsModal(this.app, stats).open();
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
