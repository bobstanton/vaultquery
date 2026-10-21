# VaultQuery

Query and update vault files with SQL. Display results as tables, charts, calendars, or JavaScript templates.

Documentation site: https://vaultquery.stanton.dev/

Web sandbox: https://sandbox.obsidian.stanton.dev/

## Code Blocks

| Code Block                 | Description                                                               |
| -------------------------- | ------------------------------------------------------------------------- |
| `vaultquery`               | Execute SQL queries, display results in SlickGrid or JavaScript rendering |
| `vaultquery-nl`            | Turn a natural-language request into a query or visualization             |
| `vaultquery-write`         | Execute INSERT, UPDATE, DELETE with before/after preview                  |
| `vaultquery-chart`         | Render query results as Chart.js visualizations                           |
| `vaultquery-chart-help`    | Display chart output reference and examples                               |
| `vaultquery-calendar`      | Render query results as a FullCalendar calendar                           |
| `vaultquery-markdown`      | Render query results as a markdown table                                  |
| `vaultquery-markdown-help` | Display markdown output reference and examples                            |
| `vaultquery-calendar-help` | Display calendar output reference and examples                            |
| `vaultquery-schema`        | Display database schema documentation                                     |
| `vaultquery-view`          | Define reusable SQL views                                                 |
| `vaultquery-function`      | Define custom SQL functions in JavaScript                                 |
| `vaultquery-help`          | Display built-in help documentation                                       |
| `vaultquery-function-help` | Display function reference                                                |
| `vaultquery-examples`      | Display example collections                                               |
| `vaultquery-api-help`      | API guide for third-party plugin developers                               |

## Getting started

Add a `vaultquery` code block with a SQL query:

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Content-dependent indexing > Index note content**.
>
> **Plugin default:** On. 

```vaultquery
SELECT title, path, modified FROM notes
WHERE content LIKE '%important%'
ORDER BY modified DESC
LIMIT 10
```

Results render in a sortable SlickGrid table.

### Reference

Use `vaultquery-help` for in-app help and `vaultquery-schema` for available tables and columns.

- [Queries, placeholders, and output](help-md/vaultquery-help.md)
- [CSV and JSON files](docs/csv-support.md)
- [Remote CSV and JSON](docs/web-csv-support.md)
- [Other file contents](docs/file-contents.md)
- [Image metadata](docs/image-metadata.md)
- [Charts](help-md/vaultquery-chart-help.md) and [calendars](help-md/vaultquery-calendar-help.md)
- [SQL functions](help-md/vaultquery-function-help.md) and [triggers](help-md/vaultquery-trigger-help.md)

### Write Operations (INSERT, UPDATE, DELETE)

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Write permissions > Enable write operations**.
>
> **Also requires:** **Settings > VaultQuery > Indexing > Schedule and storage > Indexing mode** set to **Real-time**, with indexing enabled for the data being changed.
>
> **Plugin default:** Off. 

See [write limits and failure handling](https://vaultquery.app/concepts/writing/).

Use `vaultquery-write` to preview and apply changes:

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Content-dependent indexing > Index tasks**.
>
> **Also requires:** **Index note content** in the same section.
>
> **Plugin default:** On. 

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index tags**.
>
> **Plugin default:** On. 

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index links**.
>
> **Plugin default:** Off. 

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index headings**.
>
> **Plugin default:** On. 

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Content-dependent indexing > Index tables**.
>
> **Also requires:** **Index note content** in the same section.
>
> **Plugin default:** Off. 

```vaultquery-write
-- Add a new note
INSERT INTO notes (path, content)
VALUES ('Condo Notes.md', '# Shopping List for new Condo');

-- Add a new task
INSERT INTO tasks (path, task_text, status)
VALUES ('Condo Notes.md', 'Buy plasma TV', 'TODO');

-- Add a new tag
INSERT INTO tags (path, tag_name)
VALUES ('Condo Notes.md', 'party-pad');

-- Add a new link
INSERT INTO links (path, link_target)
VALUES ('Condo Notes.md', 'Office/Dinner Party Plan.md');

-- Add a heading at a specific line
INSERT INTO headings (path, level, heading_text, line_number)
VALUES ('Condo Notes.md', 2, 'Sliding glass door repair quotes:', 4);

-- Add a tag at the start of a line
INSERT INTO tags (path, tag_name, line_number, insert_position)
VALUES ('Condo Notes.md', 'fake-overtime-assignment', 3, 'line_end');

-- Create a new table at a specific line using table_rows view
INSERT INTO table_rows (path, table_index, row_json, table_line_number)
VALUES ('Condo Notes.md', 1, json('{"Vendor": "", "Price": ""}'), 5);
```

```vaultquery-write
WITH
    -- Select all notes in the Projects folder
    project_notes AS (
      SELECT path, title FROM notes
      WHERE path LIKE 'Projects/%'
      ORDER BY title
    ),
    -- Create a flattened list of links to those notes
    flattenedLinks AS (
      SELECT GROUP_CONCAT('- ' || link(path, title), '\n') as list
      FROM project_notes
    )
-- Create an index linking to each note in the Projects folder
INSERT INTO notes (path, content)
SELECT
'Projects/Index.md',
'# Project Index

' || COALESCE(list, '_No projects found_')
FROM flattenedLinks;
```

#### UPDATE Operations

```vaultquery-write
UPDATE notes
SET content = content || '\n\nList condo on eBay at 80% of purchase price.'
WHERE path = 'Condo Notes.md'
```

#### DELETE Operations

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Write permissions > Allow file deletion**.
>
> **Also requires:** **Enable write operations** (Changes and automation > Write permissions) and **Indexing mode > Real-time** (Indexing > Schedule and storage).
>
> **Plugin default:** Off. 

```vaultquery-write
DELETE FROM notes
WHERE path = 'Condo Notes.md'
```

### Markdown Table Export

Use `vaultquery-markdown` to render query results as a Markdown table.

```vaultquery-markdown
SELECT title, path, modified FROM notes
WHERE content LIKE '%important%'
ORDER BY modified DESC
LIMIT 10
```

#### Markdown Configuration Options

Configure the markdown output with a `config:` section:

```vaultquery-markdown
SELECT title, path, size
FROM notes
ORDER BY size DESC
LIMIT 10;

config:
alignment: left, left, right
```

Available config options:
- `alignment`: Column alignments (left, center, right)

### JavaScript Rendering

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Scripts and triggers > Enable JavaScript rendering**.
>
> **Plugin default:** Off. 

Templates run with the plugin's permissions.

```vaultquery
SELECT title, path, modified FROM notes
WHERE content LIKE '%important%'
ORDER BY modified DESC
LIMIT 10;

template:
return `
  <div>
    <h3>Important Notes (${count} results)</h3>
    <ul>
      ${results.map(note => `
        <li>
          ${h.link(note.path, note.title)} -
          <em>${h.formatDate(note.modified)}</em>
        </li>
      `).join('')}
    </ul>
  </div>
`;
```

JavaScript rendering code receives these variables:
- `results` - Array of query result rows
- `query` - The SQL query that was executed
- `count` - Number of results
- `h` - Helper functions object

### Inline Query Values

Use inline code in the form `vq{SQL}` to render the first column of the first row directly in surrounding text:

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > Metadata-only indexing > Index frontmatter**.
>
> **Plugin default:** On. 

```markdown
The hike was `vq{SELECT value FROM properties WHERE key = 'distance' AND path = '{this.path}' LIMIT 1}` miles.
```

Inline query values are read-only and only allow `SELECT` or `WITH` statements.

### Obsidian CLI

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Integrations > Obsidian CLI > Enable CLI**.
>
> **Plugin default:** Off. 

`vaultquery:query` runs SQL from the Obsidian CLI and waits for indexing to finish before executing:

```shell
obsidian vaultquery:query sql="SELECT title, path FROM notes LIMIT 5" format=json
```

Available formats are `json`, `csv`, `tsv`, `md`, and `scalar`. Use `path` to provide note context for `{this.*}` placeholders:

```shell
obsidian vaultquery:query path="Hikes/Trip.md" sql="SELECT value FROM properties WHERE path = '{this.path}' AND key = 'distance' LIMIT 1" format=scalar
```

> [!important] Requirements for CLI writes
> **Setting:** **Settings > VaultQuery > Integrations > Obsidian CLI > Enable CLI write operations**.
>
> **Also requires:** **Enable CLI** in the same section, **Enable write operations** (Changes and automation > Write permissions) and **Indexing mode > Real-time** (Indexing > Schedule and storage).
>
> **Plugin default:** Off. 

### JavaScript helpers

See the [helper reference](https://vaultquery.app/output/javascript-templates/#helpers).

#### Write operations reference

| Table/View                | INSERT                   | UPDATE         | DELETE            |
| ------------------------- | ------------------------ | -------------- | ----------------- |
| **notes**                 | Creates files            | Modifies files | Deletes files(3)  |
| **notes_with_properties** | Creates with frontmatter | Modifies all   | Deletes files(3)  |
| **tasks**                 | Adds tasks               | Modifies tasks | Removes tasks     |
| **headings**              | Adds headings            | Modifies text  | Removes headings  |
| **list_items**            | Adds items               | Modifies items | Removes items     |
| **properties**            | Adds to YAML             | Modifies YAML  | Removes from YAML |
| **table_cells**           | Adds cells(2)            | Modifies cells | Removes cells     |
| **table_rows**            | Adds rows(2)             | Modifies rows  | Removes rows      |
| **tags**                  | Frontmatter or inline(1) | Renames tags   | Removes tags      |
| **links**                 | Appends or at line(1)    | Updates links  | Removes links     |

(1)With `line_number` and optional `insert_position` (new_line, line_start, line_end)

(2)With `line_number` (table_cells) or `table_line_number` (table_rows) to position new tables

(3)Requires "Allow file deletion" setting to be enabled

**Write behavior:**
- `tasks`, `headings`, `list_items` INSERT at specified `line_number` or end of file (line-based elements)
- `tags` INSERT adds to frontmatter when no `line_number` specified, or inserts inline with `insert_position`
- `links` INSERT appends to end of file when no `line_number` specified, or inserts at position with `insert_position`
- `table_cells` and `table_rows` INSERT can use `line_number`/`table_line_number` to create tables at specific positions
- `notes_with_properties` creates files with frontmatter in one operation
- `note_properties` is for properties-only queries; use `notes_with_properties` or `properties` to write frontmatter
- `table_rows` handles table row manipulation with JSON

## Chart output

Use `vaultquery-chart` to render query results as a chart. Query must use `label` and `value` columns (or `x`/`y` for scatter). Add a `series` column for multiple datasets.

#### Configuration Options

| Option                   | Description                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `type`                   | Chart type: bar, line, pie, doughnut, or scatter (required) |
| `title`                  | Chart title displayed above the chart                       |
| `datasetLabel`           | Legend label for the dataset                                |
| `xLabel`                 | X-axis label (bar, line, scatter only)                      |
| `yLabel`                 | Y-axis label (bar, line, scatter only)                      |
| `datasetBackgroundColor` | Fill color for bars/points                                  |
| `datasetBorderColor`     | Border color for bars/points                                |

#### SQL Columns for Customization

| Column            | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `backgroundColor` | Per-point fill color                                   |
| `borderColor`     | Per-point border color                                 |
| `chartType`       | Per-series chart type for mixed charts (`bar`, `line`) |

See [chart examples](help-md/vaultquery-chart-help.md) for colors, multiple series, and mixed charts.

## Usage for Developers

See the [API guide](help-md/api-guide.md) for queries, writes, functions, and provider tables.

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Scripts and triggers > Enable JavaScript SQL functions**.
>
> **Plugin default:** Off. 

```typescript
// Get the VaultQuery API
const vaultQuery = this.app.plugins.getPlugin('vaultquery');
if (vaultQuery?.api) {
  // Wait for indexing to complete
  await vaultQuery.api.waitForIndexing();

  // Execute queries
  const results = await vaultQuery.api.query('SELECT * FROM notes LIMIT 10');

  // Register custom functions
  vaultQuery.api.registerCustomFunction('myFunc', 'function(x) { return x * 2; }');
}
```

The `vaultquery-api-help` code block provides complete API documentation in any note.

## Settings and Configuration

### Indexing Features (Configurable)
- **Content Indexing**: Index note content for full-text search
- **Frontmatter Indexing**: Index YAML frontmatter properties
- **Table Indexing**: Parse and index markdown tables
- **Task Indexing**: Index task lists with priorities and due dates
- **Heading Indexing**: Index note headings and structure
- **Link Indexing**: Index internal and external links
- **Unresolved Link Indexing**: Index links Obsidian cannot resolve to a note
- **Embed Indexing**: Index embedded links such as images, PDFs, and embedded notes
- **Block Indexing**: Index Obsidian block IDs
- **Tag Indexing**: Index hashtags throughout notes
- **List Item Indexing**: Index bulleted and numbered list items

### Performance Settings
- **Maximum file size (KB)**: Maximum Markdown and other-file size (default: 1000 KB)
- **Exclude Patterns**: Regex patterns for files to skip
### Write Operations
- **Enable Write Operations**: Allow UPDATE, INSERT, DELETE queries (disabled by default)

The database is stored in Obsidian's [Configuration Folder](https://help.obsidian.md/configuration-folder) in `/plugins/vaultquery/database.db` when using disk storage.

### Troubleshooting

If a grid disappears after scrolling, use its refresh button. Column widths reset when Obsidian restarts.

## External folders

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Indexing > External folders**.
>
> **Also requires:** An absolute folder path, selected file types, and the corresponding image, CSV/JSON, or other-file indexing setting. External files are read-only.
>
> **Plugin default:** No folders configured. 

See [external folders](docs/external-files.md) for supported platforms and file types.

## Network Requests

Network requests depend on enabled features:

| Package    | URL                                                                       | Purpose                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VaultQuery | `https://sql.js.org/dist/sql-wasm.wasm`                                   | Loads the SQL.js WebAssembly binary required for the local SQLite database when CDN loading is selected or local loading falls back to CDN.                                                                                                              |
| VaultQuery | The provider URL configured in settings                                   | Translates a natural language request into SQL and selects a VaultQuery output. Sends the database schema description, known property names, and the natural language request, plus failed SQL and error messages when a generated statement is retried. |
| VaultQuery | The HTTPS URL in a `vaultquery-remote-csv` or `vaultquery-web-json` block | Downloads a read-only CSV or JSON snapshot during discovery or refresh. Requests contain the source URL and optional cache validators; vault contents are not uploaded.                                                                                  |

SQL.js loading modes:

| Mode         | Behavior                                                                     | Network activity                                       |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Auto`       | Tries a local `sql-wasm.wasm` file first, then falls back to the SQL.js CDN. | Only if the local file is missing.                     |
| `Local only` | Loads `sql-wasm.wasm` from the plugin folder or custom path.                 | None. Initialization fails if the file is unavailable. |
| `CDN only`   | Downloads `sql-wasm.wasm` from `sql.js.org`.                                 | One request during database initialization.            |

When local caching is enabled, a CDN-loaded binary is saved to the plugin folder for later use.

