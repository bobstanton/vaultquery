---
id: vaultquery-help
title: VaultQuery Help
---

# Code block types

- `vaultquery` - Render query results as an interactive table or JavaScript template
- `vaultquery-nl` - Turn a natural-language request into a query, visualization, or change preview
- `vaultquery-write` - Perform INSERT, UPDATE, DELETE, or multiple operations with preview
- `vaultquery-chart` - Render query results as a chart
- `vaultquery-calendar` - Render query results as a calendar
- `vaultquery-markdown` - Render query results as a Markdown table
- `vaultquery-schema` - Display VaultQuery schema as Markdown tables
- `vaultquery-view` - Define custom SQL view for use in other queries
- `vaultquery-function` - Define custom SQL functions in JavaScript for use in queries
- `vaultquery-trigger` - Define SQLite triggers to automate actions on data changes
- `vaultquery-chart-help` - Display chart output reference and examples
- `vaultquery-calendar-help` - Display calendar output reference and examples
- `vaultquery-markdown-help` - Display Markdown output reference and examples
- `vaultquery-function-help` - Display function reference and examples
- `vaultquery-trigger-help` - Display trigger reference and examples
- `vaultquery-examples` - Display example collections (functions, views)
- `vaultquery-api-help` - API guide for third-party plugin developers
- `vaultquery-help` - Display this help

# Query examples

## Notes in same folder

~~~vaultquery
SELECT path, title
FROM notes
WHERE path LIKE '{this.folder}%'
~~~

## Notes with properties

~~~vaultquery
SELECT path, title, status, priority
FROM notes_with_properties
WHERE status IS NOT NULL
ORDER BY path;
~~~

~~~vaultquery
SELECT path, title
FROM notes_with_properties
WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'work');
~~~

~~~vaultquery
SELECT n.path, n.title,
  MAX(CASE WHEN p.key = 'status' THEN p.value END) as status,
  MAX(CASE WHEN p.key = 'priority' THEN p.value END) as priority
FROM notes n
JOIN properties p ON n.path = p.path
GROUP BY n.path
HAVING status IS NOT NULL
ORDER BY n.path;
~~~

`note_properties` contains property columns only:

~~~vaultquery
SELECT path, status, priority
FROM note_properties
WHERE status IS NOT NULL
ORDER BY path;
~~~

## Notes with tags

~~~vaultquery
SELECT n.path, n.title, t.tag_name
FROM notes n
JOIN tags t ON n.path = t.path
WHERE t.tag_name LIKE "%project%";
~~~

## Notes linked from current note

~~~vaultquery
SELECT path, title
FROM notes
WHERE path IN ({this.outgoingLinks})
~~~

## Notes linking to current note

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index links**.
>
> **Plugin default:** Off. 

~~~vaultquery
SELECT path AS source_path, COUNT(*) AS link_count
FROM links
WHERE link_target_path = '{this.path}'
GROUP BY path
ORDER BY path;
~~~

## Broken wikilinks

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index unresolved links**.
>
> **Plugin default:** Off. 

~~~vaultquery
SELECT path, link_target, link_count
FROM unresolved_links
ORDER BY path, link_target;
~~~

## Broken wikilinks with locations

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index links**.
>
> **Plugin default:** Off. 

Frontmatter links have `frontmatter_key` instead of `line_number`.

~~~vaultquery
SELECT path, original, line_number, frontmatter_key
FROM links
WHERE link_target_path IS NULL
ORDER BY path, line_number;
~~~

## Embedded files and notes

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index embeds**.
>
> **Plugin default:** Off. 

~~~vaultquery
SELECT path, embed_target, embed_target_path, line_number
FROM embeds
ORDER BY path, line_number;
~~~

## Block references

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index blocks**.
>
> **Plugin default:** Off. 

~~~vaultquery
SELECT path, block_id, line_number, section_type
FROM blocks
ORDER BY path, line_number;
~~~

## Headings

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index headings**.
>
> **Plugin default:** On. 

~~~vaultquery
SELECT path, level, heading_text
FROM headings
WHERE path = '{this.path}'
ORDER BY line_number;
~~~

## List items

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index list items**.
>
> **Plugin default:** Off. 

~~~vaultquery
SELECT content, indent_level, list_type
FROM list_items
WHERE path = '{this.path}'
ORDER BY item_index;
~~~

The `list_items_view` includes a computed `parent_content` column showing the parent item's text:

~~~vaultquery
SELECT content, indent_level, parent_content
FROM list_items_view
WHERE path = '{this.path}'
ORDER BY item_index;
~~~

## Tasks

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Content-dependent indexing > Index tasks**.
>
> **Also requires:** **Index note content** in the same section.
>
> **Plugin default:** On. 

~~~vaultquery
SELECT path, task_text, status, priority
FROM tasks
WHERE status != 'DONE'
ORDER BY priority DESC;
~~~

`tasks_view` adds `is_complete`, `is_overdue`, `days_until_due`, `status_order`, and `priority_order`:

~~~vaultquery
SELECT path, task_text, status, days_until_due
FROM tasks_view
WHERE is_complete = 0 AND is_overdue = 1
ORDER BY status_order, priority_order;
~~~

> [!tip] Tables vs Views
> Prefer using views (when present) over the underlying tables - the views provide defaults when inserting new records:
> - `tasks_view` - status=TODO, created_date=today, computed columns (is_overdue, days_until_due)
> - `headings_view` - level=1, appends to the end when line_number is omitted
> - `list_items_view` - list_type=bullet, indent_level=0, computed parent_content

## Markdown tables

`table_rows` returns each row as a JSON object:

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Content-dependent indexing > Index tables**.
>
> **Also requires:** **Index note content** in the same section.
>
> **Plugin default:** Off. 

~~~vaultquery
SELECT path, table_index, row_index, row_json
FROM table_rows
WHERE path = '{this.path}'
ORDER BY table_index, row_index;
~~~

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Content-dependent indexing > Enable dynamic table views**.
>
> **Also requires:** **Index note content** and **Index tables** in the same section.
>
> **Plugin default:** Off. 

Query columns by name:

~~~vaultquery
SELECT path, table_index, row_index, Category, Amount
FROM budgets_table
WHERE path = '{this.path}'
ORDER BY table_index, row_index;
~~~

`table_cells` returns individual cells:

~~~vaultquery
SELECT path, table_index, row_index, column_name, cell_value
FROM table_cells
WHERE path = '{this.path}'
ORDER BY table_index, row_index, column_name;
~~~

# Template variables

Placeholders are replaced before the query runs.

| Variable               | Type   | Description                                  | Example                         |
| ---------------------- | ------ | -------------------------------------------- | ------------------------------- |
| `{this.path}`          | string | Current note's full path                     | `folder/note.md`                |
| `{this.folder}`        | string | Current note's folder (trailing slash)       | `folder/`                       |
| `{this.title}`         | string | Filename without extension                   | `VaultQuery Help`               |
| `{this.name}`          | string | Filename including extension                 | `note.md`                       |
| `{this.extension}`     | string | File extension without the dot               | `md`                            |
| `{this.content}`       | string | Full Markdown content, including frontmatter |                                 |
| `{this.created}`       | number | Creation timestamp (milliseconds)            | `1702656000000`                 |
| `{this.modified}`      | number | Modified timestamp (milliseconds)            | `1702742400000`                 |
| `{this.size}`          | number | File size in bytes                           | `2048`                          |
| `{this.vault}`         | string | Vault name                                   | `Vault`                         |
| `{this.today}`         | string | Today's date (ISO format)                    | `2024-12-21`                    |
| `{this.now}`           | string | Current datetime (ISO)                       | `2024-12-21T10:30:00Z`          |
| `{this.year}`          | number | Current year                                 | `2024`                          |
| `{this.month}`         | number | Current month (1-12)                         | `12`                            |
| `{this.day}`           | number | Current day of month                         | `21`                            |
| `{this.outgoingLinks}` | list   | Resolved paths of linked notes               | `'folder/Note1.md', 'Note2.md'` |
| `{this.tags}`          | list   | Frontmatter tags only (without #)            | `'project', 'todo'`             |
| `{this.bodyTags}`      | list   | Body tags only (without #)                   | `'project', 'todo'`             |
| `{this.headings}`      | list   | Headings in the note                         | `'Intro', 'Summary'`            |
| `{this.<key>}`         | varies | Any frontmatter property                     | `{this.status}`                 |

## Create a view

~~~vaultquery-view
CREATE VIEW recent_notes AS
SELECT path, title, datetime(modified/1000, 'unixepoch', 'localtime') as modified
FROM notes
ORDER BY modified DESC
LIMIT 20
~~~

## Use a view

~~~vaultquery
SELECT * FROM recent_notes WHERE title LIKE '%project%'
~~~

Set the view preview row limit in settings (default: 10; 0 disables previews). More examples are available in `vaultquery-examples`.

# Write operations

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Write permissions > Enable write operations**.
>
> **Also requires:** **Settings > VaultQuery > Indexing > Schedule and storage > Indexing mode** set to **Real-time**, with indexing enabled for the data being changed.
>
> **Plugin default:** Off. 

Preview changes in `vaultquery-write` blocks before applying.

Previews expire after five minutes. Changed files or relevant settings require a new preview. A failed batch can leave some files changed; check the result before retrying.

## Insert new note

~~~vaultquery-write
INSERT INTO notes (path, title, content)
VALUES ("Projects/New Project.md", "New Project", "# New Project\n\nProject description here.");
~~~

## Update note name

~~~vaultquery-write
UPDATE notes
SET title = "Updated Project Title"
WHERE path = "Projects/My Project.md";
~~~

## Update property value

~~~vaultquery-write
UPDATE properties
SET value = "completed"
WHERE key = "status"
AND path = "Projects/My Project.md";
~~~

## Update properties through the view

For list properties in `notes_with_properties`, write a JSON array or comma-separated text. New properties use the list type if already used as lists in other notes.

~~~vaultquery-write
UPDATE notes_with_properties
SET location = '41.408, -75.662', tags = json_array('office', 'branch')
WHERE path = 'Locations/Dunder Mifflin Scranton.md';
~~~

## Delete old notes

> [!important] Additional permission for note deletion
> **Setting:** **Settings > VaultQuery > Changes and automation > Write permissions > Allow file deletion**.
>
> **Also requires:** **Enable write operations** (Changes and automation > Write permissions) and **Indexing mode > Real-time** (Indexing > Schedule and storage).
>
> **Plugin default:** Off. 

~~~vaultquery-write
DELETE FROM notes
WHERE modified < strftime("%s", "now", "-365 days") * 1000
AND path LIKE "Archive/%";
~~~

## Multi-statement operation

~~~vaultquery-write
-- Create multiple related notes
INSERT INTO notes (path, title, content)
VALUES
  ("Projects/New Project.md", "New Project", "# New Project\n\nOverview..."),
  ("Projects/New Project/Tasks.md", "Tasks", "# Tasks\n\n- [ ] Initial setup");

-- Add properties
INSERT INTO properties (path, key, value)
VALUES
  ("Projects/New Project.md", "status", "\"active\""),
  ("Projects/New Project.md", "priority", "1");
~~~

## Daily note with migrated tasks

Carry incomplete tasks forward from the most recent earlier daily note:

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Content-dependent indexing > Index note content**.
>
> **Plugin default:** On. 

~~~vaultquery-write
WITH previous_note AS (
  -- Find the most recent daily note before today
  SELECT path
  FROM notes
  WHERE path LIKE 'Daily Notes/%.md'
    AND path < 'Daily Notes/' || date('now') || '.md'
  ORDER BY path DESC
  LIMIT 1
),
task_stats AS (
  -- Count completed vs incomplete tasks
  SELECT
    SUM(CASE WHEN status IN ('DONE', 'CANCELLED') THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN status NOT IN ('DONE', 'CANCELLED') THEN 1 ELSE 0 END) as carried_forward
  FROM tasks
  WHERE path = (SELECT path FROM previous_note)
),
incomplete_tasks AS (
  -- Get all incomplete tasks from that note
  SELECT '- [ ] ' || task_text as task_line
  FROM tasks
  WHERE path = (SELECT path FROM previous_note)
    AND status NOT IN ('DONE', 'CANCELLED')
)
INSERT INTO notes (path, content)
SELECT
  'Daily Notes/' || date('now') || '.md',
  '# ' || date('now') || char(10) || char(10) ||
  '## Yesterday''s Summary' || char(10) ||
  '- Completed: ' || COALESCE((SELECT completed FROM task_stats), 0) || char(10) ||
  '- Carried forward: ' || COALESCE((SELECT carried_forward FROM task_stats), 0) || char(10) || char(10) ||
  '## Migrated Tasks' || char(10) ||
  COALESCE(group_concat(task_line, char(10)), '*(No tasks to migrate)*') || char(10) || char(10) ||
  '## Today''s Tasks' || char(10) ||
  '- [ ] ' || char(10)
FROM incomplete_tasks
~~~

After creating the new note, optionally mark the original tasks as complete:

~~~vaultquery-write
WITH previous_note AS (
  SELECT path
  FROM notes
  WHERE path LIKE 'Daily Notes/%.md'
    AND path < 'Daily Notes/' || date('now') || '.md'
  ORDER BY path DESC
  LIMIT 1
)
UPDATE tasks
SET status = 'DONE', done_date = date('now')
WHERE path = (SELECT path FROM previous_note)
  AND status NOT IN ('DONE', 'CANCELLED')
~~~

# Inline buttons

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Inline actions > Enable inline buttons**.
>
> **Also requires:** **Enable write operations** (Changes and automation > Write permissions) and **Indexing mode > Real-time** (Indexing > Schedule and storage). This applies to SELECT buttons too.
>
> **Plugin default:** Off. 

Add ``vq[Label]{SQL}`` inside inline code.

| Syntax                               | Description                           |
| ------------------------------------ | ------------------------------------- |
| ``vq[Label]{SQL}``                   | Standard button with default styling  |
| ``vq.[Label]{SQL}``                  | Plain button without accent color     |
| ``vq.danger[Label]{SQL}``            | Button with custom CSS class "danger" |
| ``vq.mod-warning.large[Label]{SQL}`` | Multiple CSS classes                  |

**Query behavior:**
- **SELECT/WITH queries:** Results are copied to clipboard as a markdown table
- **INSERT/UPDATE/DELETE:** Changes are applied immediately (no preview)

## Copy tasks to clipboard

~~~text
`vq[Copy Tasks]{SELECT task_text, status FROM tasks WHERE path = '{this.path}'}`
~~~

## Mark all tasks done

~~~text
`vq.mod-warning[Complete All]{UPDATE tasks SET status = 'DONE' WHERE path = '{this.path}' AND status = 'TODO'}`
~~~

## Recalculate table totals

~~~text
`vq[Recalculate]{UPDATE budget_table SET Amount = (SELECT SUM(CAST(Amount AS INTEGER)) FROM budget_table WHERE Category NOT LIKE '%Total%') WHERE Category LIKE '%Total%'}`
~~~

> [!tip] Tip
> If button clicks lose edits, increase "Inline button debounce" in settings.

# Inline query values

Use ``vq{SELECT ...}`` inside inline code to show the first column of the first row. Accepts read-only `SELECT` or `WITH` statements.

~~~text
The hike was `vq{SELECT value FROM properties WHERE key = 'distance' AND path = '{this.path}' LIMIT 1}` miles.
~~~

## Markdown cells

The `markdown:` option renders content as Markdown in the specified columns:

~~~vaultquery
SELECT title, content AS body
FROM notes
LIMIT 10;

config:
markdown: title, body
~~~

# Markdown output

Use `vaultquery-markdown` to render query results as a Markdown table.

Use **Copy to markdown** to copy results.

## Basic Markdown table

~~~vaultquery-markdown
SELECT title, path, modified
FROM notes
ORDER BY modified DESC
LIMIT 10;
~~~

## Markdown table with column selection and alignment

~~~vaultquery-markdown
SELECT title, size
FROM notes
ORDER BY size DESC
LIMIT 10;

config:
columns: title, size
alignment: left, right
~~~

## Markdown config options

| Setting     | Description                                                             | Examples                         |
| ----------- | ----------------------------------------------------------------------- | -------------------------------- |
| `columns`   | Comma-separated names; limits and reorders columns                      | `title, size`                    |
| `alignment` | Comma-separated alignments, one per column                              | **`left`**, `center`, `right`    |
| `markdown`  | Result columns to render as Markdown; case-insensitive names or aliases | `title, body`, `all`, **`none`** |

# JavaScript rendering

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Scripts and triggers > Enable JavaScript rendering**.
>
> **Plugin default:** Off. 

Use `template:` after the SQL query (ending with `;`) to run JavaScript rendering code.

- `results` - Array of row objects from query
- `count` - Number of rows returned
- `query` - The SQL query string

Use the [JavaScript helpers](https://vaultquery.app/output/javascript-templates/#helpers) through `h`.

## List template

~~~vaultquery
SELECT title, path FROM notes LIMIT 5;
template:
return `<ul>
  ${results.map(r => `<li>${h.link(r.path, r.title)}</li>`).join('')}
</ul>`
~~~

## Card layout template

~~~vaultquery
SELECT title, path, content FROM notes WHERE content IS NOT NULL LIMIT 3;
template:
return `<div style="display: grid; gap: 1em;">
  ${results.map(r => `
    <div style="border: 1px solid var(--background-modifier-border); padding: 1em; border-radius: 8px;">
      <h4>${h.link(r.path, r.title)}</h4>
      <p>${h.truncate(h.escape(r.content), 100)}</p>
    </div>
  `).join('')}
</div>`
~~~

## Task summary with count

~~~vaultquery
SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status;
template:
return `<p>Found ${count} status types:</p>
<ul>
  ${results.map(r => `<li><strong>${h.escape(r.status)}</strong>: ${r.cnt} tasks</li>`).join('')}
</ul>`
~~~

# CSV and JSON files

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Other files > Index CSV and JSON files**.
>
> **Plugin default:** Off. 

Query each file by its quoted vault-relative path: `SELECT * FROM "Data/paper-orders.csv"`.

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Write permissions > Enable write operations**.
>
> **Also requires:** **Settings > VaultQuery > Indexing > Schedule and storage > Indexing mode** set to **Real-time**, with indexing enabled for the data being changed.
>
> **Plugin default:** Off. 

Use `vaultquery-write` to preview changes. CSV inserts require a field list; omitted fields become empty strings:

~~~vaultquery-write
INSERT INTO "Data/paper-orders.csv" (order_id, client)
VALUES ('DOCS-001', 'Schrute Farms');
~~~

CSV fields reject `NULL` and binary values. Write `''` for a blank field:

~~~vaultquery-write
UPDATE "Data/paper-orders.csv"
SET delivery_note = ''
WHERE order_id = 'DOCS-001';
~~~

For JSON writes, `NULL` removes a key. Use 1 or 0 for boolean fields and JSON text for nested values.

`DELETE FROM "Data/paper-orders.csv"` removes all records and retains the file and its header. Create and delete the file through `other_files`, with `csv` listed under **Index other file content**:

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Other files > Index other file content**.
>
> **Also requires:** A comma-separated list of file types that includes each example file's extension.
>
> **Plugin default:** Empty type list. 

~~~vaultquery-write
INSERT INTO other_files (path, content)
VALUES ('Data/new-orders.csv', 'order_id,client' || char(10) || '0007,Vance Refrigeration' || char(10));
~~~

~~~vaultquery-write
DELETE FROM other_files
WHERE path = 'Data/new-orders.csv';
~~~

Inspect indexing errors with `SELECT path, status, error FROM _vq_data_files`.

Files are limited to 50 MiB and 1,999 columns.

# Remote CSV and JSON

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Other files > Remote CSV and JSON**.
>
> **Also requires:** A source definition with a public HTTPS URL; an internet connection for the first download.
>
> **Plugin default:** Off. 

Use `vaultquery-remote-csv` for a public HTTPS CSV source or `vaultquery-web-json` for JSON:

~~~vaultquery-remote-csv
id: sample_state_population
url: https://raw.githubusercontent.com/plotly/datasets/master/2014_usa_states.csv
table: sample_state_population
cache: 1h
~~~

Settings:

| Setting | Description                                                                                                                  | Examples                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `id`    | Required. Starts with a letter; contains only letters, digits, and underscores.                                              | `sample_state_population`                                                      |
| `url`   | Required. Public HTTPS CSV or JSON source.                                                                                   | `https://raw.githubusercontent.com/plotly/datasets/master/2014_usa_states.csv` |
| `table` | SQL table name. Defaults to `web_csv_<id>` or `web_json_<id>`. Uses the same naming rules as `id`.                           | `sample_state_population`                                                      |
| `cache` | Age before cached data becomes stale. Positive whole minutes (`m`), hours (`h`), or days (`d`). Does not schedule refreshes. | **`1h`**, `30m`, `2d`                                                          |

Query it with `SELECT * FROM sample_state_population`.

Queries use cached data while stale sources refresh. Use the source block's **Refresh** button to retry. Network errors retain cached data; invalid CSV or JSON makes the table unavailable. Select disk storage to retain data across restarts. Changing the URL or forcing a reindex requires a new download. Removing or excluding a definition removes its table.

Remote sources use the same size and column limits as local CSV and JSON files.

# File contents

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Other files > Index other file content**.
>
> **Also requires:** A comma-separated list of file types that includes each example file's extension.
>
> **Plugin default:** Empty type list. 

Enter file types such as `gpx, txt`. Matching is case-insensitive, and existing exclude patterns apply.

~~~vaultquery
SELECT path
FROM other_files
WHERE typeof(content) = 'text'
  AND regexp('\bObsidian\b', content)
ORDER BY path;
~~~

`other_files` contains complete file contents, including frontmatter for `md` and headers for `csv`. This selection is separate from **Index note content** and **Index CSV and JSON files**. PDF and office document text is not extracted.

For unavailable contents, inspect `content_status` (`too_large` or `read_error`) and `content_error`.

Binary contents display as byte counts. Use `hex(content)` to include them in text exports.

**Settings > VaultQuery > Indexing > Schedule and storage > Maximum file size (KB)** limits file reads and writes. The default is 1000 KB, shared with Markdown indexing.

## Write other files

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Write permissions > Enable write operations**.
>
> **Also requires:** **Settings > VaultQuery > Indexing > Schedule and storage > Indexing mode** set to **Real-time**, with indexing enabled for the data being changed.
>
> **Plugin default:** Off. 

Paths must match **Index other file content**.

~~~vaultquery-write
INSERT INTO other_files (path, content)
VALUES ('Files/Dispatch copy.txt', 'Dispatch copy for Scranton');
~~~

INSERT creates a new file and missing parent folders. UPDATE replaces the entire file. DELETE trashes the file.

See Write operations for preview rules.

# Image metadata

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Other files > Index image metadata**.
>
> **Plugin default:** Off. 

Exclude patterns apply.

~~~vaultquery
SELECT basename, location, captured, camera_model
FROM image_files
WHERE location IS NOT NULL
ORDER BY captured DESC;
~~~

`image_files` has one row per image. `location` is `latitude, longitude` text; `captured` is milliseconds since the Unix epoch. Use `oriented_width` and `oriented_height` for displayed dimensions. `metadata_status` is `ready`, `no_metadata`, `unsupported`, or `read_error`.

`image_metadata` exposes stored tags as `path`, `section`, `tag`, `value`, and `value_num`.

~~~vaultquery
SELECT tag, value
FROM image_metadata
WHERE path = (SELECT path FROM image_files ORDER BY path LIMIT 1)
  AND section = 'exif'
ORDER BY tag;
~~~

Supported formats include JPEG, PNG, GIF, WebP, AVIF, HEIC, TIFF, JPEG XL, and camera raw files. BMP, ICO, and SVG provide dimensions only. Both tables are read-only.

# External folders

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > External folders**.
>
> **Also requires:** An absolute folder path, selected file types, and the corresponding image, CSV/JSON, or other-file indexing setting. External files are read-only.
>
> **Plugin default:** No folders configured. 

Add folders to query files outside the vault.

Set an absolute path, file types (`*` for all supported types), and a refresh mode.

Desktop and Android support external folders. Android requires Obsidian's All Files access and uses scheduled scans for **When files change**. External folders are unavailable on iOS.

~~~vaultquery
SELECT path, source, camera_model
FROM image_files
WHERE source <> 'vault'
ORDER BY captured DESC;
~~~

Files must match both the folder's types and an enabled indexing feature. Images contribute to `image_files`, CSV and JSON files become tables named by their absolute paths, and selected content types contribute to `other_files`. External Markdown files contribute only to `other_files`.

`source` is the configured folder path, or `vault` for vault files. External files are read-only.

The `external_folders` view reports folder state and scan counts:

~~~vaultquery
SELECT path, state, scanning, files_found, files_indexed, files_skipped, failures
FROM external_folders;
~~~

`files_skipped` counts files not selected by an enabled indexing feature. `failures` counts files that could not be read or indexed.

Unavailable folders retain their indexed data. Removing a folder or narrowing its types removes the affected rows.

# Natural language requests

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Natural language > Access and providers > Enable natural language queries**.
>
> **Also requires:** A configured default provider under **Settings > VaultQuery > Natural language > Access and providers**.
>
> **Plugin default:** Off. 

Add a `vaultquery-nl` block:

~~~vaultquery-nl
Show a bar chart of incomplete tasks by their priority.
~~~

The model receives all documented tables and views, plus frontmatter keys. Note contents and property values are not sent to the model.



# Obsidian CLI

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Integrations > Obsidian CLI > Enable CLI**.
>
> **Plugin default:** Off. 

`vaultquery:query` runs SQL from the Obsidian CLI and waits for indexing to finish before executing.

~~~bash
obsidian vaultquery:query sql="SELECT title, path FROM notes LIMIT 5" format=json
~~~

| Setting  | Description                                           | Examples                                 |
| -------- | ----------------------------------------------------- | ---------------------------------------- |
| `sql`    | Required. SQL to execute.                             | `SELECT title, path FROM notes LIMIT 5`  |
| `path`   | Vault-relative note path for `{this.*}` placeholders. | `90 - Locations/Schrute Farms.md`        |
| `format` | Output format for read queries.                       | **`json`**, `csv`, `tsv`, `md`, `scalar` |

~~~bash
obsidian vaultquery:query path="90 - Locations/Schrute Farms.md" sql="SELECT title FROM notes WHERE path = '{this.path}'" format=scalar
~~~

> [!important] Requirements for CLI writes
> **Setting:** **Settings > VaultQuery > Integrations > Obsidian CLI > Enable CLI write operations**.
>
> **Also requires:** **Enable CLI** in the same section, **Enable write operations** (Changes and automation > Write permissions) and **Indexing mode > Real-time** (Indexing > Schedule and storage).
>
> **Plugin default:** Off. 

Deleting notes also requires **Allow file deletion** under **Settings > VaultQuery > Changes and automation > Write permissions** (off by default and in the VaultQuery sample).
