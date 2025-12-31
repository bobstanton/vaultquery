# VaultQuery Plugin

Execute SELECT, INSERT, UPDATE, and DELETE statements on notes, properties, tasks, tables, headings and links. Output to [SlickGrid](https://slickgrid.net/), [Markdown Table](https://github.com/wooorm/markdown-table), [Chart.js](https://www.chartjs.org/) or custom HTML.

## Features

- **Indexing**: Indexes notes content, frontmatter, tables, tasks, headings, links, and tags into a SQLite database
- **Real-time Updates**: Database updates automatically when files are created, modified, renamed, or deleted
- **Advanced Querying**: Use standard SQL syntax with support for complex joins and aggregations
- **Multiple Output Formats**: Display results as a table, custom HTML templates, or charts
- **Write Operations**: Update, insert, and delete data with preview showing before and after states
- **Custom Views**: Create [SQL views](https://www.sqlite.org/lang_createview.html) for use in other queries
- **Custom Functions**: Define [scalar SQL functions](https://sql.js.org/documentation/Database.html#%5B%22create_function%22%5D) in JavaScript for extended query capabilities

## Code Blocks

| Code Block                 | Description                                                      |
| -------------------------- | ---------------------------------------------------------------- |
| `vaultquery`               | Execute SQL queries, display results in SlickGrid or custom HTML |
| `vaultquery-write`         | Execute INSERT, UPDATE, DELETE with before/after preview         |
| `vaultquery-chart`         | Render query results as Chart.js visualizations                  |
| `vaultquery-markdown`      | Render query results as markdown tables                          |
| `vaultquery-schema`        | Display database schema documentation                            |
| `vaultquery-view`          | Define reusable SQL views                                        |
| `vaultquery-function`      | Define custom SQL functions in JavaScript                        |
| `vaultquery-help`          | Display built-in help documentation                              |
| `vaultquery-function-help` | Display function reference                                       |
| `vaultquery-examples`      | Display example collections                                      |
| `vaultquery-api-help`      | API guide for third-party plugin developers                      |

## Database Schema

### `notes` table (always available):
- `path` (TEXT): File path relative to vault root (PRIMARY KEY)
- `title` (TEXT): Note title (auto-derived from path on INSERT)
- `content` (TEXT NOT NULL): Note content (without frontmatter, only if content indexing enabled)
- `created` (INTEGER): Creation timestamp in Unix milliseconds (auto-set on INSERT)
- `modified` (INTEGER): Last modification timestamp in Unix milliseconds (auto-set on INSERT)
- `size` (INTEGER): File size in bytes (auto-calculated from content on INSERT)

### `properties` table (when frontmatter/properties indexing is enabled):
- `path` (TEXT): Foreign key to notes.path
- `key` (TEXT): Property name (supports nested keys like "author.name")
- `value` (TEXT): Property value as string
- `value_type` (TEXT): Type of value (auto-derived: 'number', 'boolean', or 'string')
- `array_index` (INTEGER): Index for array elements (NULL for non-array values)
- PRIMARY KEY: (path, key, array_index)

### `table_cells` table (when table indexing is enabled):
- `id` (INTEGER): Auto-incrementing ID (PRIMARY KEY)
- `path` (TEXT): Foreign key to notes.path
- `table_index` (INTEGER): Index of table within the note (default: 0 = first table)
- `table_name` (TEXT): Name of the table (from preceding heading, optional)
- `row_index` (INTEGER): Row index within the table (0-based)
- `column_name` (TEXT): Column header name
- `cell_value` (TEXT): Cell content as string
- `value_type` (TEXT): Type of value (auto-derived: 'number' or 'text')
- `line_number` (INTEGER): Line number where this table row appears (optional)

### `tables` table (when table indexing is enabled):
- `path` (TEXT): Foreign key to notes.path
- `table_index` (INTEGER): Index of table within the note (0-based)
- `table_name` (TEXT): Name of the table (from preceding heading, optional)
- `block_id` (TEXT): Obsidian block reference (e.g., ^table-1)
- `start_offset` (INTEGER): Character offset where table starts
- `end_offset` (INTEGER): Character offset where table ends
- `line_number` (INTEGER): Line number for INSERT positioning (optional)
- PRIMARY KEY: (path, table_index)

### `table_rows` view (when table indexing is enabled):
A convenience view for row-based table operations. Columns:
- `path` (TEXT): Foreign key to notes.path
- `table_index` (INTEGER): Index of table within the note (0-based)
- `row_index` (INTEGER): Row index within the table (0-based)
- `row_json` (TEXT): JSON object of column_name→cell_value pairs
- `table_line_number` (INTEGER): Line number for INSERT positioning (optional)

### `tasks` table (when task indexing is enabled):
- `id` (INTEGER): Auto-incrementing task ID (PRIMARY KEY)
- `path` (TEXT): Foreign key to notes.path
- `task_text` (TEXT): Content of the task
- `status` (TEXT): Task status - TODO, IN_PROGRESS, DONE, CANCELLED (default: 'TODO')
- `priority` (TEXT): Priority level - highest, high, medium, low, lowest, or NULL
- `due_date` (TEXT): Due date in YYYY-MM-DD format or NULL
- `scheduled_date` (TEXT): Scheduled date in YYYY-MM-DD format or NULL
- `start_date` (TEXT): Start date in YYYY-MM-DD format or NULL
- `created_date` (TEXT): Task creation date in YYYY-MM-DD format or NULL
- `done_date` (TEXT): Completion date in YYYY-MM-DD format or NULL
- `cancelled_date` (TEXT): Cancellation date in YYYY-MM-DD format or NULL
- `recurrence` (TEXT): Recurrence rule (e.g., "every week") or NULL
- `on_completion` (TEXT): Action on completion or NULL
- `task_id` (TEXT): Custom task identifier or NULL
- `depends_on` (TEXT): Task dependencies or NULL
- `tags` (TEXT): Space-separated hashtags or NULL
- `line_number` (INTEGER): Line number where task appears (optional)
- `block_id` (TEXT): Obsidian block reference (e.g., ^task-1)
- `start_offset` (INTEGER): Character offset where task starts
- `end_offset` (INTEGER): Character offset where task ends
- `anchor_hash` (TEXT): Content-based hash for change detection
- `section_heading` (TEXT): Heading under which the task appears

### `headings` table (when heading indexing is enabled):
- `id` (INTEGER): Auto-incrementing ID (PRIMARY KEY)
- `path` (TEXT): Foreign key to notes.path
- `level` (INTEGER): Heading level (1-6 for H1-H6)
- `line_number` (INTEGER): Line number where heading appears (1-based)
- `heading_text` (TEXT): Text content of the heading
- `block_id` (TEXT): Obsidian block reference (e.g., ^heading-1)
- `start_offset` (INTEGER): Character offset where heading starts
- `end_offset` (INTEGER): Character offset where heading ends
- `anchor_hash` (TEXT): Content-based hash for change detection

### `links` table (when link indexing is enabled):
- `id` (INTEGER): Auto-incrementing link ID (PRIMARY KEY)
- `path` (TEXT): Foreign key to notes.path
- `link_text` (TEXT): Display text of the link (auto-derived from `link_target` if not provided)
- `link_target` (TEXT): Target of the link (original text for internal, URL for external)
- `link_target_path` (TEXT): Resolved file path for internal links
- `link_type` (TEXT): Type of link - auto-derived: 'external' if target starts with http/https, otherwise 'internal'
- `line_number` (INTEGER): Line number where link appears (optional)
- `insert_position` (TEXT): Position hint for INSERT operations - `new_line` (default), `line_start`, or `line_end`

### `tags` table (when tag indexing is enabled):
- `id` (INTEGER): Auto-incrementing ID (PRIMARY KEY)
- `path` (TEXT): Foreign key to notes.path
- `tag_name` (TEXT): Name of the tag
- `line_number` (INTEGER): Line number where tag appears (optional)
- `insert_position` (TEXT): Position hint for INSERT operations - `new_line` (default), `line_start`, or `line_end`

### `list_items` table (when list item indexing is enabled):
- `id` (INTEGER): Auto-incrementing ID (PRIMARY KEY)
- `path` (TEXT): Foreign key to notes.path
- `list_index` (INTEGER): Index of the list within the note (default: 0)
- `item_index` (INTEGER): Index of the item within all lists in the note (default: 0)
- `parent_index` (INTEGER): Index of parent item for nested lists, or NULL
- `content` (TEXT): Text content of the list item
- `list_type` (TEXT): Type of list - bullet, numbered (default: 'bullet')
- `indent_level` (INTEGER): Nesting depth (0 = top level, default: 0)
- `line_number` (INTEGER): Line number where item appears (optional)
- `block_id` (TEXT): Obsidian block reference
- `start_offset` (INTEGER): Character offset where item starts
- `end_offset` (INTEGER): Character offset where item ends
- `anchor_hash` (TEXT): Content-based hash for change detection

## Usage

Create a code block with the language `vaultquery` and write a SQL query:

```vaultquery
SELECT title, path, modified FROM notes 
WHERE content LIKE '%important%' 
ORDER BY modified DESC 
LIMIT 10
```

This will display results in a sortable, scrollable SlickGrid grid.

### Write Operations (INSERT, UPDATE, DELETE)

> **Important**: Write operations permanently modify vault files. There is no undo or version history built into VaultQuery. Use [Obsidian Sync](https://obsidian.md/sync) for version history. Write operations must be enabled in the plugin settings before using the following queries.

The plugin supports write operations with automatic file synchronization using the `vaultquery-write` code block:

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

CTEs (Common Table Expressions) can be used for more complex inserts. 

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

Use `vaultquery-write` to modify existing records:

```vaultquery-write
UPDATE notes
SET content = content || '\n\nList condo on eBay at 80% of purchase price.'
WHERE path = 'Condo Notes.md'
```

#### DELETE Operations

Use `vaultquery-write` to remove records:

```vaultquery-write
DELETE FROM notes
WHERE path = 'Condo Notes.md'
```

### Markdown Table Export

Use `vaultquery-markdown` to generate exportable markdown tables:

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

> **Tip**: Format dates directly in SQL using `datetime()` functions.

### Custom Templates

A JavaScript template can be provided for complete control over formatting:

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

Templates receive these variables:
- `results` - Array of query result rows
- `query` - The SQL query that was executed
- `count` - Number of results
- `h` - Helper functions object

### Helper Functions

The `h` object provides 50+ utility functions from [placeholder-resolver](../placeholder-resolver).

#### Obsidian Helpers

| Helper                                       | Description                                  |
| -------------------------------------------- | -------------------------------------------- |
| `h.link(path, text?)`                        | Create HTML internal link                    |
| `h.wikilink(path, alias?)`                   | Create wikilink `[[path]]` or `[[path\|alias]]` |
| `h.wikilinkHeading(path, heading, display?)` | Link to heading `[[path#heading]]`           |
| `h.wikilinkBlock(path, blockId, display?)`   | Link to block `[[path#^id]]`                 |
| `h.pathToTitle(path)`                        | Extract display title from path              |

#### String Manipulation

| Helper                                    | Description                 |
| ----------------------------------------- | --------------------------- |
| `h.escape(text)`                          | HTML escape                 |
| `h.lower(text)`                           | Lowercase                   |
| `h.upper(text)`                           | Uppercase                   |
| `h.capitalize(text)`                      | Capitalize first letter     |
| `h.trim(text)`                            | Trim whitespace             |
| `h.truncate(text, length?, suffix?)`      | Truncate with ellipsis      |
| `h.slugify(text)`                         | URL-safe slug               |
| `h.replace(text, search, replacement)`    | Replace all occurrences     |
| `h.regexReplace(text, pattern, replacement)` | Regex replace            |
| `h.split(text, delimiter)`                | Split to array              |
| `h.before(text, delimiter)`               | Text before first delimiter |
| `h.after(text, delimiter)`                | Text after first delimiter  |
| `h.beforeLast(text, delimiter)`           | Text before last delimiter  |
| `h.afterLast(text, delimiter)`            | Text after last delimiter   |
| `h.unquote(text)`                         | Remove surrounding quotes   |
| `h.isBlank(text)`                         | Check if empty/whitespace   |
| `h.stripHtml(text)`                       | Remove HTML tags            |
| `h.nl2br(text)`                           | Newlines to `<br>`          |

#### Path Helpers

| Helper                  | Description                |
| ----------------------- | -------------------------- |
| `h.filename(path)`      | Filename with extension    |
| `h.pathBasename(path)`  | Filename without extension |
| `h.pathExtension(path)` | Extension without dot      |
| `h.pathParent(path)`    | Parent folder path         |

#### Formatting

| Helper                                  | Description                                    |
| --------------------------------------- | ---------------------------------------------- |
| `h.formatDate(timestamp, format?)`      | Format date (tokens: YYYY, MM, DD, HH, mm, ss) |
| `h.formatNumber(num, decimals?)`        | Format with locale separators                  |
| `h.formatBytes(bytes, decimals?)`       | Human-readable file size                       |
| `h.pluralize(count, singular, plural?)` | Pluralize word                                 |

#### Arrays

| Helper                            | Description        |
| --------------------------------- | ------------------ |
| `h.join(array, delimiter?)`       | Join array elements|
| `h.first(array)`                  | First element      |
| `h.last(array)`                   | Last element       |
| `h.unique(array)`                 | Remove duplicates  |
| `h.sortBy(array, key, direction?)`| Sort by property   |
| `h.groupBy(array, key)`           | Group by property  |
| `h.sum(array)`                    | Sum numbers        |
| `h.avg(array)`                    | Average            |
| `h.min(array)` / `h.max(array)`   | Min/max values     |

#### Objects & JSON

| Helper                  | Description        |
| ----------------------- | ------------------ |
| `h.keys(obj)`           | Object keys        |
| `h.values(obj)`         | Object values      |
| `h.entries(obj)`        | Key-value pairs    |
| `h.pick(obj, ...keys)`  | Select properties  |
| `h.omit(obj, ...keys)`  | Exclude properties |
| `h.json(value, pretty?)`| Stringify to JSON  |
| `h.parseJson(text)`     | Parse JSON string  |

#### SQL Helpers (for query templates)

| Helper               | Description                          |
| -------------------- | ------------------------------------ |
| `h.sqlIn(array)`     | Format for IN clause: `'a', 'b', 'c'`|
| `h.sqlEscape(value)` | Escape single quotes                 |
| `h.sqlLiteral(value)`| Format as SQL literal                |

#### Null Handling

| Helper                           | Description                 |
| -------------------------------- | --------------------------- |
| `h.default(value, defaultValue)` | Fallback for null/undefined |
| `h.ifEmpty(value, replacement)`  | Replace empty strings       |



#### Quick Reference Table

| Table/View               | INSERT                      | UPDATE             | DELETE               |
| ------------------------ | --------------------------- | ------------------ | -------------------- |
| **notes**                | ✅ Creates files            | ✅ Modifies files  | ✅ Deletes files*    |
| **notes_with_properties**| ✅ Creates with frontmatter | ✅ Modifies all    | ✅ Deletes files*    |
| **note_properties**      | ✅ Adds to existing note    | ✅ Modifies YAML   | ✅ Removes all props |
| **tasks**                | ✅ Adds tasks               | ✅ Modifies tasks  | ✅ Removes tasks     |
| **headings**             | ✅ Adds headings            | ✅ Modifies text   | ✅ Removes headings  |
| **list_items**           | ✅ Adds items               | ✅ Modifies items  | ✅ Removes items     |
| **properties**           | ✅ Adds to YAML             | ✅ Modifies YAML   | ✅ Removes from YAML |
| **table_cells**          | ✅ Adds cells‡              | ✅ Modifies cells  | ✅ Removes cells     |
| **table_rows**           | ✅ Adds rows‡               | ✅ Modifies rows   | ✅ Removes rows      |
| **tags**                 | ✅ Frontmatter or inline†   | ✅ Renames tags    | ✅ Removes tags      |
| **links**                | ✅ Appends or at line†      | ✅ Updates links   | ✅ Removes links     |

†With `line_number` and optional `insert_position` (new_line, line_start, line_end)

‡With `line_number` (table_cells) or `table_line_number` (table_rows) to position new tables

*Requires "Allow file deletion" setting to be enabled


**Key Points:**
- All tables support full CRUD operations with sync back to files
- `tasks`, `headings`, `list_items` INSERT at specified `line_number` or end of file (line-based elements)
- `tags` INSERT adds to frontmatter when no `line_number` specified, or inserts inline with `insert_position`
- `links` INSERT appends to end of file when no `line_number` specified, or inserts at position with `insert_position`
- `table_cells` and `table_rows` INSERT can use `line_number`/`table_line_number` to create tables at specific positions
- Use `notes_with_properties` view to create files with frontmatter in one operation
- Use `note_properties` view for properties-only queries (path + property columns, no notes columns)
- Use `table_rows` view for easier table row manipulation with JSON

## Chart Rendering

VaultQuery supports rendering query results as interactive charts using Chart.js. Use the `vaultquery-chart` code block type.

Charts require columns named `label` and `value` (or `x` and `y` for scatter plots). Add a `series` column for multiple datasets.

#### Configuration Options

| Option                   | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `type`                   | Chart type: bar, line, pie, doughnut, or scatter (required) |
| `title`                  | Chart title displayed above the chart                 |
| `datasetLabel`           | Legend label for the dataset                          |
| `xLabel`                 | X-axis label (bar, line, scatter only)                |
| `yLabel`                 | Y-axis label (bar, line, scatter only)                |
| `datasetBackgroundColor` | Fill color for bars/points                            |
| `datasetBorderColor`     | Border color for bars/points                          |

#### SQL Columns for Advanced Customization

| Column            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `backgroundColor` | Per-point fill color                               |
| `borderColor`     | Per-point border color                             |
| `chartType`       | Per-series chart type for mixed charts (`bar`, `line`) |

#### Vault Growth Over Time
```vaultquery-chart
SELECT
    strftime('%Y-%m', created/1000, 'unixepoch') as label,
    COUNT(*) as value
FROM notes
WHERE created > 0
GROUP BY label
ORDER BY label;
config:
type: line
title: Notes Created Per Month
xLabel: Month
yLabel: Notes
datasetBackgroundColor: rgba(75, 192, 192, 0.2)
datasetBorderColor: rgba(75, 192, 192, 1)
```

#### Content Distribution by Folder
```vaultquery-chart
SELECT
    COALESCE(SUBSTR(path, 1, INSTR(path || '/', '/') - 1), 'Root') as label,
    COUNT(*) as value
FROM notes
GROUP BY label
ORDER BY value DESC
LIMIT 8;
config:
type: doughnut
title: Notes by Top-Level Folder
```

#### Writing Activity by Day of Week
```vaultquery-chart
SELECT
    CASE CAST(strftime('%w', modified/1000, 'unixepoch') AS INTEGER)
        WHEN 0 THEN 'Sun'
        WHEN 1 THEN 'Mon'
        WHEN 2 THEN 'Tue'
        WHEN 3 THEN 'Wed'
        WHEN 4 THEN 'Thu'
        WHEN 5 THEN 'Fri'
        WHEN 6 THEN 'Sat'
    END as label,
    COUNT(*) as value,
    CASE CAST(strftime('%w', modified/1000, 'unixepoch') AS INTEGER)
        WHEN 0 THEN 'rgba(255, 99, 132, 0.8)'
        WHEN 6 THEN 'rgba(255, 99, 132, 0.8)'
        ELSE 'rgba(54, 162, 235, 0.8)'
    END as backgroundColor
FROM notes
GROUP BY strftime('%w', modified/1000, 'unixepoch')
ORDER BY CAST(strftime('%w', modified/1000, 'unixepoch') AS INTEGER);
config:
type: bar
title: Files Modified by Day of Week
```

#### Task Status Breakdown
```vaultquery-chart
SELECT
    status as label,
    COUNT(*) as value,
    CASE status
        WHEN 'DONE' THEN 'rgba(75, 192, 192, 0.8)'
        WHEN 'TODO' THEN 'rgba(255, 205, 86, 0.8)'
        WHEN 'IN_PROGRESS' THEN 'rgba(54, 162, 235, 0.8)'
        WHEN 'CANCELLED' THEN 'rgba(255, 99, 132, 0.8)'
        ELSE 'rgba(201, 203, 207, 0.8)'
    END as backgroundColor,
    CASE status
        WHEN 'DONE' THEN 'rgba(75, 192, 192, 1)'
        WHEN 'TODO' THEN 'rgba(255, 205, 86, 1)'
        WHEN 'IN_PROGRESS' THEN 'rgba(54, 162, 235, 1)'
        WHEN 'CANCELLED' THEN 'rgba(255, 99, 132, 1)'
        ELSE 'rgba(201, 203, 207, 1)'
    END as borderColor
FROM tasks
GROUP BY status;
config:
type: pie
title: Task Status
```

#### Multi-Series: Tasks by Status and Priority
```vaultquery-chart
SELECT
    status as label,
    COALESCE(priority, 'none') as series,
    COUNT(*) as value,
    CASE priority
        WHEN 'high' THEN 'rgba(255, 99, 132, 0.8)'
        WHEN 'medium' THEN 'rgba(255, 205, 86, 0.8)'
        WHEN 'low' THEN 'rgba(75, 192, 192, 0.8)'
        ELSE 'rgba(201, 203, 207, 0.8)'
    END as backgroundColor
FROM tasks
GROUP BY status, priority;
config:
type: bar
title: Tasks by Status and Priority
```

#### Mixed Chart: Note Count with Size Trend
```vaultquery-chart
SELECT
    strftime('%Y-%m', created/1000, 'unixepoch') as label,
    COUNT(*) as value,
    'Notes' as series,
    'bar' as chartType,
    'rgba(54, 162, 235, 0.8)' as backgroundColor
FROM notes WHERE created > 0
GROUP BY label
UNION ALL
SELECT
    strftime('%Y-%m', created/1000, 'unixepoch') as label,
    ROUND(AVG(size)/1024.0, 1) as value,
    'Avg Size (KB)' as series,
    'line' as chartType,
    'rgba(255, 99, 132, 1)' as backgroundColor
FROM notes WHERE created > 0
GROUP BY label
ORDER BY label;
config:
type: bar
title: Monthly Notes with Average Size Trend
```

#### Scatter: File Size vs Word Count
```vaultquery-chart
SELECT
    ROUND(size/1024.0, 1) as x,
    LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) as y
FROM notes
WHERE size > 0 AND size < 100000
LIMIT 100;
config:
type: scatter
title: File Size vs Approximate Word Count
xLabel: Size (KB)
yLabel: Words
datasetBackgroundColor: rgba(54, 162, 235, 0.6)
```


### Advanced Template Examples

#### Task List Grouped by Status
```vaultquery
SELECT status, task_text, path FROM tasks
WHERE status IN ('TODO', 'DONE', 'IN_PROGRESS')
ORDER BY status, path;

template:
const grouped = results.reduce((acc, t) => {
  (acc[t.status] ||= []).push(t);
  return acc;
}, {});

return Object.entries(grouped).map(([status, tasks]) => `
  <details open>
    <summary><strong>${status}</strong> (${tasks.length})</summary>
    <ul>
      ${tasks.map(t => `<li>${h.link(t.path)} - ${h.renderWikilinks(t.task_text)}</li>`).join('')}
    </ul>
  </details>
`).join('');
```

#### Recently Modified Notes with Preview
```vaultquery
SELECT title, path, modified, SUBSTR(content, 1, 150) as preview
FROM notes
ORDER BY modified DESC
LIMIT 5;

template:
return `
<div style="display: flex; flex-direction: column; gap: 1em;">
  ${results.map(n => `
    <div style="border-left: 3px solid var(--interactive-accent); padding-left: 1em;">
      <strong>${h.link(n.path, n.title)}</strong>
      <small style="color: var(--text-muted);"> — ${h.formatDate(n.modified)}</small>
      <p style="margin: 0.5em 0; color: var(--text-muted);">${h.escape(n.preview)}...</p>
    </div>
  `).join('')}
</div>
`;
```

#### Tag Cloud
```vaultquery
SELECT tag_name, COUNT(*) as count
FROM tags
GROUP BY tag_name
ORDER BY count DESC
LIMIT 20;

template:
const max = Math.max(...results.map(r => r.count));
return `
<div style="display: flex; flex-wrap: wrap; gap: 0.5em;">
  ${results.map(t => {
    const size = 0.8 + (t.count / max) * 1.2;
    return `<span style="font-size: ${size}em; opacity: ${0.5 + t.count/max/2};">#${t.tag_name}</span>`;
  }).join('')}
</div>
`;
```

## Usage for Developers

VaultQuery exposes an API for third-party Obsidian plugins. The API includes the ability to execute SQL queries, register custom functions, custom views, and write operations are also available assuming the user has enabled the "Allow write operations" setting.

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

For complete API documentation, use the `vaultquery-api-help` code block in any note.

## Settings and Configuration

### Database Storage Options
- **Memory Storage** (default): Fast, rebuilds on startup, no persistent storage
- **Disk Storage**: Persistent between sessions

### Indexing Features (Configurable)
- **Content Indexing**: Index note content for full-text search
- **Frontmatter Indexing**: Index YAML frontmatter properties  
- **Table Indexing**: Parse and index markdown tables
- **Task Indexing**: Index task lists with priorities and due dates
- **Heading Indexing**: Index note headings and structure
- **Link Indexing**: Index internal and external links
- **Tag Indexing**: Index hashtags throughout notes

### Performance Settings  
- **File Size Limit**: Maximum file size to index (default: 1MB)
- **Exclude Patterns**: Regex patterns for files to skip
- **Batch Size**: Number of files to process at once

### Write Operations
- **Enable Write Operations**: Allow UPDATE, INSERT, DELETE queries (disabled by default)
- **Auto File Sync**: Automatically update vault files when database is modified

The database is stored in Obsidian's [Configuration Folder](https://help.obsidian.md/configuration-folder) in `/plugins/vaultquery/database.db` when using disk storage. 


### Known Issues

- **Grid refresh after scrolling**: Obsidian's DOM virtualization may detach grid elements when scrolling long notes. Click the refresh button to restore the grid, the plugin will attempt to auto-restore grids periodically.

- **Block references for updates**: Task and heading updates work best when content has explicit block references (e.g., `^task-1`). Without them, the plugin uses content hashing which is not as accurate.

- **Column width persistence**: Column widths are remembered during a session and are intentionally not remembered when Obsidian restarts.

## Network Requests

This plugin makes the following network requests:

| URL | Purpose | When |
| --- | ------- | ---- |
| `https://sql.js.org/dist/sql-wasm.wasm` | Downloads the SQL.js WebAssembly binary required for SQLite functionality | Only when WASM source is set to "CDN", or when set to "Auto" and local loading fails. The plugin ships with a bundled copy (`sql-wasm.wasm`) to avoid network requests by default. |

## Dependencies

| Package                                                    | Description                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [sql.js](https://github.com/sql-js/sql.js)                 | SQLite compiled to WebAssembly, enabling SQL queries in the browser/Obsidian |
| [SlickGrid](https://github.com/6pac/SlickGrid)             | High-performance interactive data grid for displaying query results          |
| [Chart.js](https://github.com/chartjs/Chart.js)            | Flexible charting library for rendering query results as visualizations      |
| [markdown-table](https://github.com/wooorm/markdown-table) | Utility for generating properly formatted markdown tables                    |
| [fnv-plus](https://github.com/tjwebb/fnv-plus)             | Fast non-cryptographic hash function for content change detection            |
| [placeholder-resolver](../placeholder-resolver)            | Template variable resolution with helper functions (local package)           |

## Similar Plugins

- [Dataview](https://github.com/blacksmithgu/obsidian-dataview) - Dataview's DQL syntax is simpler and easier to learn than SQL. Dataview and its successor [Datacore](https://github.com/blacksmithgu/datacore) are read-only will index faster than VaultQuery; VaultQuery supports writes and may query faster when using custom views or indexes. However, these differnces are likely marginal. Perfer Dataview or Datacore for read-only workloads, especially when prioritizing indexing performance. Prefer VaultQuery for write operations or when standard SQL syntax is preferred. 
