import { App, PluginSettingTab, Setting } from 'obsidian';
import VaultQueryPlugin from '../main';
import { IndexingStatsModal } from '../Modals/IndexingStatsModal';
import type { WasmSource } from './Settings';

declare const activeWindow: Window;

export class VaultQuerySettingTab extends PluginSettingTab {
  plugin: VaultQueryPlugin;

  public constructor(app: App, plugin: VaultQueryPlugin) {
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- intentional capitalization for "Rebuild index" button name
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
            this.plugin.settings.enableInlineButtons = false;
          }

          void this.plugin.saveSettings();
          this.refreshDisplay();
        }));

    new Setting(containerEl)
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- KB is a standard abbreviation
      .setName('Maximum file size (KB)')
      .setDesc('Files larger than this size in kilobytes will be skipped during indexing. Default is 1000 kb (1 mb).')
      .addText(text => text
        .setPlaceholder('1000')
        .setValue(this.plugin.settings.maxFileSizeKB.toString())
        .onChange((value) => {
          const size = parseInt(value);
          if (!isNaN(size) && size > 0) {
            this.plugin.settings.maxFileSizeKB = size;
            void this.plugin.saveSettings();
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
          void this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Index headings')
      .setDesc('Index Markdown headings (h1-h6) into structured data.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexHeadings)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexHeadings = value;
          void this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Index links')
      .setDesc('Index internal links between notes.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexLinks)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexLinks = value;
          void this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Index tags')
      .setDesc('Index hashtags found in notes.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexTags)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexTags = value;
          void this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Index list items')
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- "Index tasks" refers to the setting name
      .setDesc('Index bulleted and numbered list items. Excludes task items (use Index tasks for those).')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledFeatures.indexListItems)
        .onChange((value) => {
          this.plugin.settings.enabledFeatures.indexListItems = value;
          void this.plugin.saveSettings();
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
            void this.plugin.saveSettings();
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
          void this.plugin.saveSettings();
          this.refreshDisplay();
        }));

    new Setting(containerEl)
      .setName('Enable dynamic table views')
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- "Index tables" is a setting name
      .setDesc('Automatically create simplified SQL views for each unique table structure. Requires "Index tables" to be enabled. A full reindex is needed for changes to take effect.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableDynamicTableViews)
        .setDisabled(!contentEnabled || !this.plugin.settings.enabledFeatures.indexTables)
        .onChange((value) => {
          this.plugin.settings.enableDynamicTableViews = value;
          void this.plugin.saveSettings();
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
          void this.plugin.saveSettings();
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
            void this.plugin.saveSettings();
          });
        })
        .addButton(button => button
          .setButtonText('Remove')
          .setWarning()
          .onClick(() => {
            this.plugin.settings.excludePatterns.splice(index, 1);
            void this.plugin.saveSettings();
            this.refreshDisplay();
          }));
    });

    new Setting(containerEl)
      .addButton(button => button
        .setButtonText('Add exclude pattern')
        .setCta()
        .onClick(() => {
          this.plugin.settings.excludePatterns.push('\\.tmp$');
          void this.plugin.saveSettings();
          this.refreshDisplay();
        }));

    new Setting(containerEl)
      .setName('Write operations')
      .setHeading();

    const isRealtimeIndexing = this.plugin.settings.indexingInterval === 'realtime';
    const writeEnabled = this.plugin.settings.allowWriteOperations;

    const writeOperationsSetting = new Setting(containerEl)
      .setName('Enable write operations')
      .addToggle(toggle => toggle
        .setValue(writeEnabled)
        .setDisabled(!isRealtimeIndexing)
        .onChange((value) => {
          this.plugin.settings.allowWriteOperations = value;
          // When disabling write operations, also disable dependent features
          if (!value) {
            this.plugin.settings.enableInlineButtons = false;
            this.plugin.settings.allowDeleteNotes = false;
          }
          void this.plugin.saveSettings();
          this.refreshDisplay();
        })
      );

    if (isRealtimeIndexing) {
      writeOperationsSetting.setDesc('Allow update and insert SQL commands to modify notes in the vault. There is no undo or version history built into VaultQuery. Use Obsidian Sync for version history.');
    }
    else {
      writeOperationsSetting.setDesc('Write operations require real-time indexing mode. Changes made to files must be immediately re-indexed to keep the database in sync. Switch to real-time indexing to enable this feature.');
    }

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
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- DELETE FROM is SQL syntax
      .setDesc('Allow DELETE FROM notes to delete files from the vault. This is a destructive operation. Files are moved to trash, not permanently deleted.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.allowDeleteNotes)
        .setDisabled(!isRealtimeIndexing || !writeEnabled)
        .onChange((value) => {
          this.plugin.settings.allowDeleteNotes = value;
          void this.plugin.saveSettings();
        })
      );

    // eslint-disable-next-line obsidianmd/settings-tab/no-problematic-settings-headings -- "Display options" doesn't contain "settings"
    new Setting(containerEl)
      .setName('Display options')
      .setHeading();

    new Setting(containerEl)
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- markdown is intentionally lowercase per sentence case rules
      .setName('Enable markdown rendering in content')
      .setDesc('Render Markdown formatting in the content column. Queries that return the current note will cause infinite recursion. When disabled, content is shown as plain text.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableMarkdownRendering)
        .onChange((value) => {
          this.plugin.settings.enableMarkdownRendering = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Auto-refresh on index change')
      .setDesc('Automatically refresh query results when files are indexed. This keeps results up-to-date but may impact performance on large vaults with frequent changes.')
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- WASM is an acronym
      .setName('WASM source')
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- WASM and CDN are acronyms
      .setDesc('Where to load the SQLite WASM binary. Auto tries local first then CDN. Local requires the file to exist in the plugin folder or custom path. CDN always downloads from sql.js.org.')
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
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- WASM is an acronym
        .setName('Cache WASM locally')
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- WASM and CDN are acronyms
        .setDesc('Save the WASM file to the plugin folder after downloading from CDN. This allows offline use after the first load.')
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
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- WASM is an acronym
        .setName('Custom WASM path')
        .setDesc('Optional custom path to sql-wasm.wasm file. Leave empty to use the default plugin folder location. Supports absolute paths or paths relative to the vault.')
        .addText(text => text
          .setPlaceholder('Leave empty for default')
          .setValue(this.plugin.settings.wasm.customPath)
          .onChange((value) => {
            this.plugin.settings.wasm.customPath = value.trim();
            void this.plugin.saveSettings();
          }));
    }

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
              activeWindow.setTimeout(checkProgress, 500);
            }
          };

          activeWindow.setTimeout(checkProgress, 100);

          rebuildPromise.then(() => {
            button.setButtonText('Rebuild complete');
            activeWindow.setTimeout(() => {
              button.setButtonText('Rebuild index');
              button.setDisabled(false);
            }, 3000);
          }).catch((error: unknown) => {
            console.error('Failed to rebuild index:', error);
            button.setButtonText('Error');
            activeWindow.setTimeout(() => {
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