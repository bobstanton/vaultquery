---
id: api-guide
title: VaultQuery API Guide
---

# VaultQuery API guide

## Getting the API

~~~bash
npm install --save-dev github:bobstanton/vaultquery
~~~

~~~typescript
import { TFile } from 'obsidian';
import { waitForVaultQueryAPI } from 'vaultquery/api';

// Inside an async plugin method:
const api = await waitForVaultQueryAPI(this.app);
if (!api) return;
~~~

### Waiting for indexing

Call `waitForIndexing()` before queries that need complete results. `query()` does not wait for indexing:

~~~typescript
await api.waitForIndexing();
const notes = await api.query('SELECT COUNT(*) AS count FROM notes');
console.log(`Indexed ${notes[0].count} notes`);
~~~

## Checking capabilities

`getCapabilities()` reports which features are enabled:

~~~typescript
const caps = api.getCapabilities();

// Check both write access and the index needed by this task operation.
if (caps.writeEnabled && caps.indexing.tasks) {
  const preview = await api.previewQuery(
    'UPDATE tasks SET status = ? WHERE path = ? AND task_text LIKE ?',
    ['DONE', '00 - Getting started.md', 'Purchase glasses%']
  );

  await api.applyPreview(preview);
} else {
  console.log('Enable write operations and task indexing in VaultQuery settings.');
}

// Check which non-Markdown sources are queryable
if (caps.sources.csv) {
  const rows = await api.query("SELECT * FROM \"Data/paper-orders.csv\"");
}

// Check if specific data is indexed
if (caps.indexing.tasks) {
  const tasks = await api.query("SELECT * FROM tasks WHERE status = 'TODO'");
}

if (caps.indexing.headings) {
  const headings = await api.query('SELECT * FROM headings WHERE level = 1');
}

// Check if file deletion is allowed
if (caps.fileDeleteEnabled) {
  // Can use DELETE FROM notes
}
~~~

| Property                          | Description                                             |
| --------------------------------- | ------------------------------------------------------- |
| `writeEnabled`                    | INSERT/UPDATE/DELETE operations are allowed             |
| `fileDeleteEnabled`               | DELETE FROM notes (file deletion) is allowed            |
| `thirdPartyProviderTablesEnabled` | Third-party provider tables are enabled                 |
| `sources.otherFiles`              | At least one file type is selected for content indexing |
| `sources.csv`                     | CSV and JSON files are readable as tables               |
| `sources.remoteData`              | Remote CSV and JSON sources are enabled                 |
| `sources.providerTables`          | Third-party provider registration is enabled            |
| `indexing.content`                | Note content is indexed                                 |
| `indexing.frontmatter`            | `properties` table is available                         |
| `indexing.tables`                 | `table_cells` table is available                        |
| `indexing.tasks`                  | `tasks` table is available                              |
| `indexing.headings`               | `headings` table is available                           |
| `indexing.links`                  | `links` table is available                              |
| `indexing.unresolvedLinks`        | `unresolved_links` table is available                   |
| `indexing.embeds`                 | `embeds` table is available                             |
| `indexing.tags`                   | `tags` table is available                               |
| `indexing.blocks`                 | `blocks` table is available                             |
| `indexing.listItems`              | `list_items` table is available                         |

## Schema information

~~~typescript
const schemaMarkdown = await api.getSchemaInfo();
console.log(schemaMarkdown);
// Returns formatted markdown with all tables, columns, and types
~~~

## Read queries

`query()` returns rows from a single SELECT or WITH query. VaultQuery action functions must be called through `execute()`.

~~~typescript
const notes = await api.query(`
  SELECT path, title, modified
  FROM notes
  ORDER BY modified DESC
  LIMIT 10
`);
for (const note of notes) console.log(note.path, note.title);
~~~

### Template variables

Pass a note path or `TFile` as `noteSource` to use `{this.*}` placeholders. See Template variables in `vaultquery-help` for the reference.

~~~typescript
const file = this.app.workspace.getActiveFile();
if (!file) return;

// Find notes in the same folder
const siblings = await api.query(`
  SELECT path, title FROM notes
  WHERE path LIKE '{this.folder}%'
    AND path != '{this.path}'
`, file);

// Find notes linking to current note
const backlinks = await api.query(`
  SELECT path, link_text FROM links
  WHERE link_target_path = '{this.path}'
`, file);
~~~

### Iterating query batches

`iterateQueryBatches()` returns arrays of rows from a single SELECT query.

~~~typescript
const controller = new AbortController();
for await (const rows of api.iterateQueryBatches(
  'SELECT path, title FROM notes ORDER BY path',
  undefined,
  { signal: controller.signal }
)) {
  for (const row of rows) console.log(row.path);
}
~~~

Use `controller.abort()` to cancel the query. Cancellation raises `AbortError` and may need to wait for the current database read to finish. Unloading VaultQuery also cancels active queries.

Indexing, saving, and other database changes can interrupt the query. On `QueryIterationInvalidatedError`, discard any collected rows and run the query again.

`{ snapshot: true }` reads the complete result into memory before returning the first batch. Later database changes do not interrupt batch processing.

## Write operations

Requires **Enable write operations**, **Real-time** indexing, and indexing for the target data.

### Preview and apply pattern

~~~typescript
// Step 1: Preview the changes
const preview = await api.previewQuery(`
  UPDATE tasks
  SET status = ?, done_date = date('now')
  WHERE path = ? AND task_text LIKE ?
`, ['DONE', 'projects/todo.md', '%review%']);

// Step 2: Inspect the preview
const affectedRowCount = Math.max(preview.before.length, preview.after.length);
console.log(`Operation: ${preview.op}`);
console.log(`Affected rows: ${affectedRowCount}`);
console.log('Before:', preview.before);
console.log('After:', preview.after);

// Step 3: After displaying the preview and obtaining acceptance
if (affectedRowCount > 0) {
  const affectedPaths = await api.applyPreview(preview);
  console.log('Modified files:', affectedPaths);
}
~~~

### Insert example

~~~typescript
// Create a new note
const preview = await api.previewQuery(`
  INSERT INTO notes (path, title, content)
  VALUES (?, ?, ?)
`, ['new-note.md', 'New Note', '# New Note\n\nContent here']);

// After displaying the preview and obtaining acceptance:
await api.applyPreview(preview);
~~~

### Update example

~~~typescript
// Mark tasks as complete
const preview = await api.previewQuery(`
  UPDATE tasks
  SET status = ?, done_date = date('now')
  WHERE status = ? AND due_date < date('now')
`, ['DONE', 'TODO']);

// After displaying the preview and obtaining acceptance:
if (preview.before.length > 0) {
  await api.applyPreview(preview);
}
~~~

### Delete example

~~~typescript
// Delete old notes (requires "Allow file deletion" setting)
const preview = await api.previewQuery(`
  DELETE FROM notes
  WHERE path LIKE ?
    AND modified < strftime('%s', 'now', '-1 year') * 1000
`, ['archive/%']);

// After displaying the preview and obtaining acceptance:
await api.applyPreview(preview);
~~~

### Preview lifetime and conflict checks

`previewQuery()` prepares the changes and returns a preview with a `planId`. `applyPreview()` applies those changes once. Editing the preview object does not change the prepared operation; manually created previews are rejected.

Plans expire after five minutes. Relevant settings changes and database replacement invalidate them. Call `discardPreview(preview.planId)` when canceling or closing a preview.

Before applying changes, VaultQuery checks that source files still match the preview. Body edits and deletions check the complete original text. Property-only edits check frontmatter and preserve unrelated body changes. A conflict raises `FilePreviewStaleError` (`FILE_PREVIEW_STALE`). Create a new preview after this error.

Binary replacements and deletions can conflict with external edits made during Apply.

`FileWriteApplyError` has code `FILE_WRITE_APPLY_FAILED` and reports `phase`, `completedPaths`, `unknownPaths`, `untouchedPaths`, and an optional `failedPath`. `unknownPaths` lists files whose final contents could not be verified. A completed file can still have an indexing or persistence error. Recovery reindexes the current files without repeating the write.

## Error handling

~~~typescript
try {
  const results = await api.query('SELECT * FROM invalid_table');
} catch (error) {
  // Error messages include helpful hints
  // e.g., "no such table: properties
  //        Note: Property indexing is disabled. Enable it in Settings..."
  console.error(error instanceof Error ? error.message : String(error));
}

// Check permissions before preparing a write; handle failures as well.
if (api.getCapabilities().writeEnabled) {
  try {
    const preview = await api.previewQuery(
      'UPDATE notes SET title = ? WHERE path = ?',
      ['Updated title', 'projects/todo.md']
    );
    // Display the preview for review. Release it if the action is canceled.
    if (preview.planId) api.discardPreview(preview.planId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
} else {
  console.log('Enable write operations in VaultQuery settings to prepare changes.');
}
~~~

## Indexing

### Checking indexing status

~~~typescript
const status = api.getIndexingStatus();

if (status.isIndexing && status.progress) {
  console.log(`Indexing: ${status.progress.current}/${status.progress.total}`);
  console.log(`Current file: ${status.progress.currentFile}`);
} else {
  console.log('Indexing complete');
}
~~~

### Triggering reindexing

~~~typescript
// Incremental reindex (only modified files)
await api.reindexVault();

// Full reindex (clears database and reindexes everything)
await api.forceReindexVault();

// Reindex a specific note
await api.reindexNote('folder/my-note.md');
~~~

### Check if a file should be indexed

~~~typescript
const file = this.app.vault.getAbstractFileByPath('Personnel/Jim Halpert.md');
if (file instanceof TFile && api.shouldIndexFile(file)) {
  console.log('This file will be indexed');
}
~~~

### Check if a file needs reindexing

~~~typescript
const file = this.app.vault.getAbstractFileByPath('Personnel/Jim Halpert.md');
if (file instanceof TFile) {
  const needsUpdate = await api.needsIndexing(file);
  if (needsUpdate) {
    await api.indexNote(file);
  }
}
~~~

### Get all indexed files

~~~typescript
const indexedFiles = await api.getIndexedFiles();
for (const file of indexedFiles) {
  console.log(`${file.path} - modified: ${new Date(file.modified)}`);
}
~~~

### Deindex a file

~~~typescript
// Remove without deleting the file
await api.deindex('Personnel/Jim Halpert.md');
~~~

## Executing schema statements and actions

Use `execute()` for schema statements and explicit VaultQuery actions. It returns the number of database rows changed; SELECT action calls return `0`.

~~~typescript
// Create a custom view (returns 0 for DDL)
const affected = await api.execute(`
  CREATE VIEW IF NOT EXISTS recent_notes AS
  SELECT path, title, modified
  FROM notes
  WHERE modified > strftime('%s', 'now', '-7 days') * 1000
  ORDER BY modified DESC
`);

// Query the view
const recent = await api.query('SELECT * FROM recent_notes');

// File actions require the write settings above.
await api.execute('SELECT vq_set_property(?, ?, ?)', [
  'Personnel/Jim Halpert.md', 'status', 'active'
]);
~~~

## Custom SQL functions

Requires **Enable JavaScript SQL functions**.

~~~typescript
// Register a single-argument function
await api.registerCustomFunction('reverse', `
  function(str) {
    if (str === null) return null;
    return String(str).split('').reverse().join('');
  }
`);

// Use in queries
const results = await api.query(`
  SELECT title, reverse(title) as reversed
  FROM notes
  LIMIT 5
`);

// Register a function with multiple parameters
await api.registerCustomFunction('concat_with', `
  function(separator, ...args) {
    return args.filter(a => a !== null).join(separator || '');
  }
`);
~~~

## Third-party provider tables

Enable **Settings > VaultQuery > Integrations > Plugin integrations > Third-party provider tables**.

### Registering providers

This complete plugin registers a table with sample data. Replace the sample rows with your plugin's data.

~~~typescript
import { Plugin } from 'obsidian';
import { registerVaultQueryTableProviders } from 'vaultquery/api';
import type { VaultQueryTableProvider } from 'vaultquery/api';

const provider: VaultQueryTableProvider = {
  id: 'example.weather',
  displayName: 'Example Weather',
  tables: [{
    name: 'weather_daily',
    primaryKey: ['id', 'date'],
    defaultStaleAfterMs: 2 * 60 * 60 * 1000,
    columns: [
      { name: 'id', type: 'TEXT' },
      { name: 'date', type: 'TEXT' },
      { name: 'temperature_2m_max', type: 'REAL' }
    ]
  }],
  definitionBlock: {
    language: 'example-weather',
    parse(source) {
      const id = source.trim();
      if (!id) throw new Error('A location id is required.');
      return { id, request: { id } };
    }
  },
  async refresh({ request }) {
    const id = String(request?.id);
    return {
      tables: {
        weather_daily: {
          replaceWhere: { id },
          rows: [{ id, date: '2026-04-21', temperature_2m_max: 68 }]
        }
      }
    };
  }
};

export default class WeatherPlugin extends Plugin {
  async onload() {
    const registration = await registerVaultQueryTableProviders(this.app, {
      pluginId: this.manifest.id,
      providers: [provider]
    });
    this.register(() => { void registration.dispose(); });
  }
}
~~~

Add this block to a Markdown note:

~~~example-weather
scranton-pa
~~~

Once indexed, query the table through the API:

~~~typescript
console.table(await api.query('SELECT * FROM weather_daily'));
~~~

`parse()` returns a stable, unique definition `id` and a `request` passed to `refresh()`. Refresh runs when the definition is indexed or its data expires. `replaceWhere` deletes matching rows in the same transaction before upserting returned rows; omit it to upsert only.

Use `definitionBlock.completions` for key/value suggestions. Registered tables and columns appear in SQL autocomplete.

### Read-only snapshots per definition

The built-in `vaultquery-remote-csv` and `vaultquery-web-json` providers expose read-only tables from public HTTPS sources.

To return complete table snapshots:

~~~typescript
import type { TabularDocument, ProviderTableSnapshot } from 'vaultquery/api';

// The provider has already parsed its source into a table document.
function snapshot(document: TabularDocument): ProviderTableSnapshot {
  const now = Date.now();
  return {
    kind: 'table',
    table: document.path,
    document,
    revision: 'source-revision',
    asOf: now,
    validatedAt: now,
    expiresAt: now + 3_600_000,
  };
}
~~~

Set `definitionTables: { format: 'csv', readOnly: true }` and `tables: []` on the provider. List each definition's table names in `requestedTables`. Return `{ tables: {}, snapshots: [...] }` with one snapshot per requested table.

For unchanged data, return an `unchangedSnapshots` entry with the table name, matching revision, original `asOf`, new `validatedAt`, and expiry. `context.existingSnapshots` supplies any saved `etag` and `lastModified` values.

Unchanged results persist with the next database save and do not refresh queries.

Use `context.signal` to cancel provider requests. VaultQuery discards results for definitions changed or removed during a refresh.

Snapshot status adds `lastValidatedAt`, `snapshotRevision`, `snapshotState`, and `schemaChanged`. The state reports pending, refreshing, ready, stale, or unavailable data. Providers without snapshot support retain their declared tables, `replaceWhere`, and upsert behavior.

`getDataFileColumnNames()` returns result column names for ready snapshots and saved views that select only CSV or JSON columns. Schema output preserves quoted column names. Writes to snapshot tables are rejected.

### Status and cleanup

~~~typescript
const status = await api.getTableProviderStatus('example.weather');
console.table(status);

await api.unregisterTableProvider('example.weather');
~~~

`getQueryProviderStatus(sql)` returns status records for the provider tables read by a query:

~~~typescript
const used = await api.getQueryProviderStatus('SELECT * FROM weather_daily');
for (const table of used) {
  console.log(table.tableName, table.rowCount, table.lastError);
}
~~~

| `snapshotState` | Description                                     |
| --------------- | ----------------------------------------------- |
| `pending`       | Waiting for the first snapshot                  |
| `refreshing`    | A refresh is running                            |
| `stale`         | The snapshot expired or its last refresh failed |
| `ready`         | The snapshot is current                         |
| `unavailable`   | No valid snapshot is available                  |

Static provider rows remain queryable after unregistering. Definition-owned snapshots retain their disk cache but become unavailable until the provider registers again and definitions validate. Deleting or excluding a snapshot definition removes its owned table; forced reindex drops all owned snapshots.

## CSV and JSON files

Requires **Index CSV and JSON files**; writes also require the write settings above.

~~~typescript
const rows = await api.query('SELECT order_id, client FROM "Data/paper-orders.csv"');
const preview = await api.previewQuery(
  'UPDATE "Data/paper-orders.csv" SET delivery_note = ? WHERE order_id = ?',
  ['Deliver to reception', '0001']
);

// Display preview.before and preview.after
const changedFiles = await api.applyPreview(preview);

// When canceled instead, or when removing the preview:
// if (preview.planId) api.discardPreview(preview.planId);
~~~

| Method                         | Purpose                                                                                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getDataFileSources()`         | Returns indexed CSV and JSON source records, including their paths, columns, revisions, status, and errors.                                                                                                                                                            |
| `discardPreview(id)`           | Releases a prepared write plan.                                                                                                                                                                                                                                        |
| `getDataFileColumnNames(rows)` | Returns display column names for CSV or JSON results, excluding internal identifiers. Requires an original result array from `query()`, or a batch from `iterateQueryBatches()`. Returns `undefined` for results using default column visibility. |
| `invalidateDataFile(path)`     | Marks a source for reindexing and invalidates its previews. Does not start a refresh.                                                                                                                                                                                  |

Query `_vq_data_files` through the API to inspect ready/error status:

~~~typescript
const sources = await api.query(`
  SELECT path, status, error
  FROM _vq_data_files
  ORDER BY path
`);
for (const source of sources) {
  if (source.status === 'ready') {
    console.log(`Ready: ${source.path}`);
  } else {
    console.warn(source.path, source.status, source.error);
  }
}
~~~

## Other file contents

Query `other_files` for complete file contents.

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Other files > Index other file content**.
>
> **Also requires:** A comma-separated list of file types that includes each example file's extension.
>
> **Plugin default:** Empty type list. **VaultQuery sample:** `txt, gpx` selected.

~~~typescript
const rows = await api.query(`
  SELECT path, content, content_status FROM other_files
  WHERE folder = 'Files'
`);
for (const row of rows) {
  if (typeof row.content === 'string') console.log(row.path, row.content);
  else if (row.content instanceof Uint8Array) console.log(row.path, row.content.byteLength);
  else console.log(row.path, row.content_status);
}
~~~

`content` is a string, `Uint8Array`, or `NULL` when unavailable. Binary arrays are independent copies.

| API                                    | Purpose                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `getCapabilities().sources.otherFiles` | Indicates whether other-file indexing has selected file types                                         |
| `query()`         | Queries indexed metadata, contents, and availability                                                  |
| `reindexVault()`                       | Updates changed files in the index                                                                    |
| `forceReindexVault()`                  | Rebuilds indexed contents                                                                             |
| `on('file-indexed', callback)`         | Receives indexed file changes. `source` identifies the index: `note`, `other-file`, `image`, or `csv` |
| `on('files-indexed', callback)`        | Receives one event per indexed batch, with all affected `paths`                                       |
| `on('file-removed', callback)`         | Receives removed indexed paths                                                                        |
| `on('vault-indexed', callback)`        | Receives completed vault indexing                                                                     |

`other_files` includes file metadata, `content`, `content_bytes`, `content_status`, and `content_error`. Timestamps use milliseconds. See `getSchemaInfo()` for columns.

Other-file statuses are `ready`, `too_large` and `read_error`. Unavailable rows retain metadata and an error with `NULL` contents.

UTF-8 contents with no control characters other than TAB, LF, and CR are text; other contents are binary. PDF and office document text is not extracted.

### Other-file writes

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Write permissions > Enable write operations**.
>
> **Also requires:** **Settings > VaultQuery > Indexing > Schedule and storage > Indexing mode** set to **Real-time**, with indexing enabled for the data being changed.
>
> **Plugin default:** Off.

Paths must match **Index other file content** and exclusions. Raw CSV writes do not require **Index CSV and JSON files**.

| Operation                      | Effect                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| `INSERT (path, content)`       | Creates a new file and any missing parent folders                |
| `UPDATE ... SET content = ...` | Replaces the complete contents, including frontmatter or headers |
| `DELETE`                       | Trashes the file using Obsidian's deletion preference            |

Only `content` can be updated. Supply text or `Uint8Array`; contents containing NUL require binary values. Updates and deletions require ready indexed contents. Source and output must fit the per-file size limit.

~~~typescript
const preview = await api.previewQuery(
  'INSERT INTO other_files(path, content) VALUES (?, ?)',
  ['Files/Dispatch copy.txt', new Uint8Array([0, 255, 13, 10])]
);

// Render preview.before and preview.after for review, as for Markdown notes.
// After acceptance:
const changedPaths = await api.applyPreview(preview);

// On cancellation instead:
// if (preview.planId) api.discardPreview(preview.planId);
~~~

`before` and `after` contain `path` and `content`. Binary values display as byte counts.

Repeated changes to one path produce one final file operation. A batch containing different operations uses `multiResults`, grouped by INSERT, UPDATE, or DELETE.

See [preview lifetime and conflict checks](#preview-lifetime-and-conflict-checks).

A batch accepts INSERT, UPDATE, and DELETE statements targeting `other_files`, including CTEs and INSERT SELECT. REPLACE, conflict clauses, mixed target tables, custom triggers, and user-defined JavaScript functions are rejected.

Replacing a CSV or JSON file with invalid contents makes its record table unavailable until the file is corrected.
