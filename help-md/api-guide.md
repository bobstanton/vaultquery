---
id: api-guide
title: VaultQuery API Guide
---

# VaultQuery API Guide

This guide explains how to use VaultQuery from a third-party Obsidian plugin.

## Getting the API

VaultQuery exposes its API through the global `app` object. First, check if VaultQuery is installed and enabled:

```typescript
// Get the VaultQuery plugin instance
const vaultQuery = this.app.plugins.getPlugin('vaultquery');

if (!vaultQuery) {
  console.log('VaultQuery plugin is not installed or enabled');
  return;
}

// Access the API
const api = vaultQuery.api;
```

## TypeScript Types

Add VaultQuery as a dev dependency to import types:

```bash
npm install --save-dev github:bobstanton/vaultquery
```

Then import the types you need:

```typescript
import type { IVaultQueryAPI, VaultQueryPlugin, QueryResult, PreviewResult } from 'vaultquery';

const vaultQuery = this.app.plugins.getPlugin('vaultquery') as VaultQueryPlugin | undefined;
if (!vaultQuery?.api) return;

const results: QueryResult[] = await vaultQuery.api.query('SELECT * FROM notes');
```

Available types:

| Type                 | Description                                    |
|----------------------|------------------------------------------------|
| `VaultQueryPlugin`   | Plugin instance (use with `getPlugin`)         |
| `IVaultQueryAPI`     | Full API interface                             |
| `QueryResult`        | Query result row                               |
| `PreviewResult`      | DML preview result                             |
| `NoteSource`         | `string \| TFile` for template variables       |
| `FileIndexedEvent`   | Event data for `file-indexed`                  |
| `FileRemovedEvent`   | Event data for `file-removed`                  |
| `VaultIndexedEvent`  | Event data for `vault-indexed`                 |
| `EventRef`           | Event subscription reference                   |
| `IndexingStats`      | Performance statistics                         |

## Core API Methods

### Executing Queries

```typescript
const results = await api.query('SELECT * FROM notes LIMIT 10');

const file = this.app.workspace.getActiveFile();
const results = await api.query(
  'SELECT * FROM links WHERE path = {this.path}',
  file
);

for (const row of results) {
  console.log(row.path, row.title);
}
```

### Waiting for Indexing

At plugin load time, VaultQuery may still be indexing the vault. Use `waitForIndexing()` to ensure complete data:

```typescript
async onload() {
  const vaultQuery = this.app.plugins.getPlugin('vaultquery');
  if (!vaultQuery) return;

  await vaultQuery.api.waitForIndexing();

  const notes = await vaultQuery.api.query('SELECT COUNT(*) as count FROM notes');
  console.log(`Indexed ${notes[0].count} notes`);
}
```

**Note**: `query()` does not wait call `waitForIndexing()` internally.

### Checking Indexing Status

```typescript
const status = api.getIndexingStatus();

if (status.isIndexing) {
  console.log(`Indexing: ${status.progress.current}/${status.progress.total}`);
  console.log(`Current file: ${status.progress.currentFile}`);
} else {
  console.log('Indexing complete');
}
```

### Triggering Reindexing

```typescript
// Incremental reindex (only modified files)
await api.reindexVault();

// Full reindex (clears database and reindexes everything)
await api.forceReindexVault();

// Reindex a specific note
await api.reindexNote('folder/my-note.md');
```

## Write Operations

VaultQuery supports INSERT, UPDATE, and DELETE operations that sync changes back to markdown files. Write operations require "Allow write operations" enabled in VaultQuery settings.

### Preview and Apply Pattern

```typescript
// Step 1: Preview the changes
const preview = await api.previewQuery(`
  UPDATE tasks
  SET status = 'DONE', done_date = date('now')
  WHERE path = 'projects/todo.md' AND task_text LIKE '%review%'
`);

// Step 2: Inspect the preview
console.log(`Operation: ${preview.operationType}`);
console.log(`Affected rows: ${preview.affectedRowCount}`);
console.log('Before:', preview.beforeRows);
console.log('After:', preview.afterRows);

// Step 3: Apply if satisfied
if (preview.affectedRowCount > 0) {
  const affectedPaths = await api.applyPreview(preview);
  console.log('Modified files:', affectedPaths);
}
```

### Insert Example

```typescript
// Create a new note
const preview = await api.previewQuery(`
  INSERT INTO notes (path, title, content)
  VALUES ('new-note.md', 'New Note', '# New Note\n\nContent here')
`);

await api.applyPreview(preview);
```

### Update Example

```typescript
// Mark tasks as complete
const preview = await api.previewQuery(`
  UPDATE tasks
  SET status = 'DONE', done_date = date('now')
  WHERE status = 'TODO' AND due_date < date('now')
`);

if (preview.affectedRowCount > 0) {
  await api.applyPreview(preview);
}
```

### Delete Example

```typescript
// Delete old notes (requires "Allow file deletion" setting)
const preview = await api.previewQuery(`
  DELETE FROM notes
  WHERE path LIKE 'archive/%'
    AND modified < strftime('%s', 'now', '-1 year') * 1000
`);

await api.applyPreview(preview);
```

## Custom SQL Functions

Register custom JavaScript functions for use in SQL queries:

```typescript
// Register a simple function
api.registerCustomFunction('reverse', `
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
api.registerCustomFunction('concat_with', `
  function(separator, ...args) {
    return args.filter(a => a !== null).join(separator || '');
  }
`);
```

## Executing DDL Statements

Use `execute()` for statements that don't return query results. It returns the number of rows affected:

```typescript
// Create a custom view (returns 0 for DDL)
const affected = api.execute(`
  CREATE VIEW IF NOT EXISTS recent_notes AS
  SELECT path, title, modified
  FROM notes
  WHERE modified > strftime('%s', 'now', '-7 days') * 1000
  ORDER BY modified DESC
`);

// Query the view
const recent = await api.query('SELECT * FROM recent_notes');
```

## Checking Capabilities

Before using certain features, check what's available based on user settings:

```typescript
const caps = api.getCapabilities();

// Check if write operations are enabled
if (caps.writeEnabled) {
  const preview = await api.previewQuery('UPDATE tasks SET status = "DONE"...');
  await api.applyPreview(preview);
} else {
  new Notice('Write operations are disabled in VaultQuery settings');
}

// Check if specific data is indexed
if (caps.indexing.tasks) {
  const tasks = await api.query('SELECT * FROM tasks WHERE status = "TODO"');
}

if (caps.indexing.headings) {
  const headings = await api.query('SELECT * FROM headings WHERE level = 1');
}

// Check if file deletion is allowed
if (caps.fileDeleteEnabled) {
  // Can use DELETE FROM notes
}
```

The capabilities object includes:

| Property               | Description                                  |
|------------------------|----------------------------------------------|
| `writeEnabled`         | INSERT/UPDATE/DELETE operations are allowed  |
| `fileDeleteEnabled`    | DELETE FROM notes (file deletion) is allowed |
| `indexing.content`     | Note content is indexed                      |
| `indexing.frontmatter` | `properties` table is available              |
| `indexing.tables`      | `table_cells` table is available             |
| `indexing.tasks`       | `tasks` table is available                   |
| `indexing.headings`    | `headings` table is available                |
| `indexing.links`       | `links` table is available                   |
| `indexing.tags`        | `tags` table is available                    |
| `indexing.listItems`   | `list_items` table is available              |

## Schema Information

Get the current database schema as markdown:

```typescript
const schemaMarkdown = api.getSchemaInfo();
console.log(schemaMarkdown);
// Returns formatted markdown with all tables, columns, and types
```

## Utility Methods

### Check if a File Should Be Indexed

```typescript
const file = this.app.vault.getAbstractFileByPath('notes/example.md');
if (file instanceof TFile && api.shouldIndexFile(file)) {
  console.log('This file will be indexed');
}
```

### Check if a File Needs Reindexing

```typescript
const file = this.app.vault.getAbstractFileByPath('notes/example.md');
if (file instanceof TFile) {
  const needsUpdate = await api.needsIndexing(file);
  if (needsUpdate) {
    await api.indexNote(file);
  }
}
```

### Get All Indexed Files

```typescript
const indexedFiles = await api.getIndexedFiles();
for (const file of indexedFiles) {
  console.log(`${file.path} - modified: ${new Date(file.modified)}`);
}
```

### Remove a Note from Index

```typescript
// Remove without deleting the file
api.removeNote('notes/removed.md');
```

## Template Variables

When passing a `noteSource` (TFile or path string), these template variables are available:

| Variable                 | Description                |
|--------------------------|----------------------------|
| `{this.path}`            | Full file path             |
| `{this.name}`            | Filename with extension    |
| `{this.basename}`        | Filename without extension |
| `{this.extension}`       | File extension             |
| `{this.folder}`          | Parent folder path         |
| `{this.created}`         | Creation timestamp (ms)    |
| `{this.modified}`        | Modified timestamp (ms)    |
| `{this.size}`            | File size in bytes         |
| `{this.frontmatter.key}` | Frontmatter property value |

Example:

```typescript
const file = this.app.workspace.getActiveFile();

// Find notes in the same folder
const siblings = await api.query(`
  SELECT path, title FROM notes
  WHERE path LIKE '{this.folder}/%'
    AND path != '{this.path}'
`, file);

// Find notes linking to current note
const backlinks = await api.query(`
  SELECT path, link_text FROM links
  WHERE link_target_path = '{this.path}'
`, file);
```

## Error Handling

```typescript
try {
  const results = await api.query('SELECT * FROM invalid_table');
} catch (error) {
  // Error messages include helpful hints
  // e.g., "no such table: properties
  //        Note: Property indexing is disabled. Enable it in Settings..."
  console.error(error.message);
}

// Check if write operations are allowed before previewing
try {
  const preview = await api.previewQuery('UPDATE notes SET title = "test"');
} catch (error) {
  if (error.message.includes('Write operations are disabled')) {
    // Prompt user to enable in settings
  }
}
```