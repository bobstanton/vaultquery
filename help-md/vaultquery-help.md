---
id: vaultquery-help
title: VaultQuery Help
---

# Code block types

- `vaultquery` - Output SQL queries as a SlickGrid table or JavaScript rendering
- `vaultquery-write` - Perform INSERT, UPDATE, DELETE, or multiple operations with preview
- `vaultquery-chart` - Render chart output using [Chart.js](https://www.chartjs.org/)
- `vaultquery-calendar` - Render calendar output using [FullCalendar Standard](https://fullcalendar.io/)
- `vaultquery-markdown` - Render markdown table output
- `vaultquery-schema` - Display VaultQuery schema as markdown tables
- `vaultquery-view` - Define custom SQL view for use in other queries
- `vaultquery-function` - Define custom SQL functions in JavaScript for use in queries
- `vaultquery-trigger` - Define SQLite triggers to automate actions on data changes
- `vaultquery-chart-help` - Display chart output reference and examples
- `vaultquery-calendar-help` - Display calendar output reference and examples
- `vaultquery-markdown-help` - Display markdown output reference and examples
- `vaultquery-function-help` - Display function reference and documentation
- `vaultquery-trigger-help` - Display trigger reference and documentation
- `vaultquery-examples` - Display example collections (functions, views)
- `vaultquery-api-help` - API guide for third-party plugin developers
- `vaultquery-help` - Show this help

# Template variables

These placeholders will be evaluated and replaced before a query is executed by SQLite

| Variable               | Type   | Description                            | Example                         |
| ---------------------- | ------ | -------------------------------------- | ------------------------------- |
| `{this.path}`          | string | Current note's full path               | `folder/note.md`                |
| `{this.folder}`        | string | Current note's folder (trailing slash) | `folder/`                       |
| `{this.title}`         | string | Current note's title (filename)        | `VaultQuery Help`               |
| `{this.content}`       | string | Full markdown content of the note      |                                 |
| `{this.created}`       | number | Creation timestamp (milliseconds)      | `1702656000000`                 |
| `{this.modified}`      | number | Modified timestamp (milliseconds)      | `1702742400000`                 |
| `{this.size}`          | number | File size in bytes                     | `2048`                          |
| `{this.vault}`         | string | Vault name                             | `Vault`                         |
| `{this.today}`         | string | Today's date (ISO format)              | `2024-12-21`                    |
| `{this.now}`           | string | Current datetime (ISO)                 | `2024-12-21T10:30:00Z`          |
| `{this.year}`          | number | Current year                           | `2024`                          |
| `{this.month}`         | number | Current month (1-12)                   | `12`                            |
| `{this.day}`           | number | Current day of month                   | `21`                            |
| `{this.outgoingLinks}` | list   | Resolved paths of linked notes         | `'folder/Note1.md', 'Note2.md'` |
| `{this.tags}`          | list   | Tags in the note (without #)           | `'project', 'todo'`             |
| `{this.headings}`      | list   | Headings in the note                   | `'Intro', 'Summary'`            |
| `{this.<key>}`         | varies | Any frontmatter property               | `{this.status}`                 |

## SQL blocks

In `vaultquery`, `vaultquery-write`, `vaultquery-view`, `vaultquery-trigger`, `vaultquery-chart`, `vaultquery-markdown`, and `vaultquery-calendar`, autocomplete can suggest:

- SQL keywords
- Template placeholders such as `{this.path}` and `{this.today}`
- Table and view names from the current VaultQuery schema
- Column names from indexed tables and views
- Built-in SQL functions and user-defined functions from `vaultquery-function`
- Qualified column suggestions based on table aliases such as `n.title` after `FROM notes n`

Suggestions are ranked by SQL context:

- After `FROM`, `JOIN`, `INTO`, or `UPDATE`, relations are shown first
- After `SELECT`, `WHERE`, `AND`, `OR`, `ON`, `ORDER BY`, `GROUP BY`, `HAVING`, or `SET`, columns are shown first
- Inside function-call positions such as `COUNT(` or `LOWER(`, functions are shown first
- When a query already declares table aliases, matching qualified columns for those aliases are prioritized

When relation aliases are present, VaultQuery also biases unqualified column suggestions toward the relations already in the query, which reduces noise in common patterns such as:

~~~vaultquery
SELECT
FROM notes n
JOIN tasks t ON t.path = n.path
~~~

Autocomplete appears immediately after separators such as spaces, commas, and opening parentheses. For example, suggestions should appear after `SELECT `, `title, `, `FROM `, and `COUNT(` without typing another character first.

## Config sections

`vaultquery`, `vaultquery-chart`, `vaultquery-markdown`, and `vaultquery-calendar` also provide autocomplete in `config:` sections for:

- Table grid options
- Markdown options
- Chart options
- Calendar options
- Common boolean values

## Provider definition blocks

Third-party provider definition blocks registered with VaultQuery use generic config-style highlighting. VaultQuery currently ships provider-definition key/value autocomplete for the built-in Places provider block languages: `places-weather-vaultquery`, `places-tides-vaultquery`, and `places-solar-vaultquery`.

Examples:

- Places weather definitions can suggest keys such as `id`, `coordinates`, `daily`, `hourly`, `units`, `cache`, and `tables`, along with valid values for weather variable lists and table selection.
- Places tides definitions can suggest keys such as `id`, `location`, `station`, `stationId`, `datum`, `units`, `cache`, and `tables`, along with valid values for `datum`, `units`, and tide table selection.
- Places solar definitions can suggest keys such as `id`, `name`, `coordinates`, `location`, `startDate`, and `endDate`.

# Database schema

Use a `vaultquery-schema` code block to display the complete database schema with all tables, views, and columns.


# Examples

## Notes in same folder

~~~vaultquery
SELECT path, title
FROM notes
WHERE path LIKE '{this.folder}%'
~~~

## Notes linked from current note

~~~vaultquery
SELECT path, title
FROM notes
WHERE path IN ({this.outgoingLinks})
~~~

## Notes with tags

~~~vaultquery
SELECT n.path, n.title, t.tag_name
FROM notes n
JOIN tags t ON n.path = t.path
WHERE t.tag_name LIKE "%project%";
~~~

## Notes linking to current note

Requires **Index links**.

~~~vaultquery
SELECT path AS source_path, COUNT(*) AS link_count
FROM links
WHERE link_target_path = '{this.path}'
GROUP BY path
ORDER BY path;
~~~

## Broken wikilinks

Requires **Index unresolved links**.

~~~vaultquery
SELECT path, link_target, link_count
FROM unresolved_links
ORDER BY path, link_target;
~~~

## Broken wikilinks with locations

Requires **Index links**. Shows each unresolved link occurrence with its raw
markup and position; `line_number` is NULL for links in frontmatter
properties (see `frontmatter_key`).

~~~vaultquery
SELECT path, original, line_number, frontmatter_key
FROM links
WHERE link_target_path IS NULL
ORDER BY path, line_number;
~~~

## Embedded files and notes

Requires **Index embeds**.

~~~vaultquery
SELECT path, embed_target, embed_target_path, line_number
FROM embeds
ORDER BY path, line_number;
~~~

## Block references

Requires **Index blocks**.

~~~vaultquery
SELECT path, block_id, line_number, section_type
FROM blocks
ORDER BY path, line_number;
~~~

## Notes with properties

Using the `notes_with_properties` view (pivots property rows to columns):

~~~vaultquery
SELECT path, title, status, priority
FROM notes_with_properties
WHERE status IS NOT NULL
ORDER BY path;
~~~

Or using a JOIN with the `properties` table:

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

Or using the `note_properties` view (properties only, no notes columns):

~~~vaultquery
SELECT path, status, priority
FROM note_properties
WHERE status IS NOT NULL
ORDER BY path;
~~~

## Headings

~~~vaultquery
SELECT path, level, heading_text
FROM headings
WHERE path = '{this.path}'
ORDER BY line_number;
~~~


## List items

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

~~~vaultquery
SELECT path, task_text, status, priority
FROM tasks
WHERE status != 'DONE'
ORDER BY priority DESC;
~~~

The `tasks_view` includes computed columns for easier sorting and filtering:

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

Using the `table_rows` view (data as JSON objects):

~~~vaultquery
SELECT path, table_index, row_index, row_json
FROM table_rows
WHERE path = '{this.path}'
ORDER BY table_index, row_index;
~~~

Or using dynamic table views (like `budgets_table`, requires setting):

~~~vaultquery
SELECT path, table_index, row_index, Category, Amount
FROM budgets_table
WHERE path = '{this.path}'
ORDER BY table_index, row_index;
~~~

Or using the `table_cells` table directly:

~~~vaultquery
SELECT path, table_index, row_index, column_name, cell_value
FROM table_cells
WHERE path = '{this.path}'
ORDER BY table_index, row_index, column_name;
~~~

# Reusable SQL views

Use `vaultquery-view` blocks to create SQL views that can be queried from any note.

## Creating a view

~~~vaultquery-view
CREATE VIEW recent_notes AS
SELECT path, title, datetime(modified/1000, 'unixepoch', 'localtime') as modified
FROM notes
ORDER BY modified DESC
LIMIT 20
~~~


## Using a view

Once created, query the view like any table:

~~~vaultquery
SELECT * FROM recent_notes WHERE title LIKE '%project%'
~~~

## Tasks due this week view

~~~vaultquery
CREATE VIEW tasks_due_this_week AS
SELECT path, task_text, due_date, priority
FROM tasks
WHERE due_date IS NOT NULL
  AND due_date >= date('now')
  AND due_date <= date('now', '+7 days')
ORDER BY due_date, priority DESC
~~~

## Notes by tag view

~~~vaultquery
CREATE VIEW project_notes AS
SELECT DISTINCT n.path, n.title, n.modified
FROM notes n
JOIN tags t ON n.path = t.path
WHERE t.tag_name = '#project'
ORDER BY n.modified DESC
~~~

## Orphan notes view

~~~vaultquery
CREATE VIEW orphan_notes AS
SELECT n.path, n.title
FROM notes n
LEFT JOIN links l ON n.path = l.link_target_path
WHERE l.link_target_path IS NULL
  AND n.path NOT LIKE '%/_templates/%'
~~~

> [!note] Note
> Views show a preview when created. Configure preview row limit in settings (default: 10 rows, set to 0 to disable).

# SQL functions

VaultQuery includes built-in SQL functions (regex, date, link building, link resolution, path, geolocation) and supports user-defined functions in JavaScript.

Use a `vaultquery-function-help` code block for complete function documentation:


# Write operations

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

## Delete old notes

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

Use CTEs (Common Table Expressions) to create a new daily note and migrate incomplete tasks from the previous day's note. The query finds the most recent daily note before today (not necessarily yesterday) and carries forward any unfinished tasks.

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

Inline buttons use the syntax ``vq[Label]{SQL}`` to execute SQL with a single click. Requires "Enable inline buttons" in settings.

| Syntax                               | Description                          |
|--------------------------------------|--------------------------------------|
| ``vq[Label]{SQL}``                   | Standard button with default styling |
| ``vq.[Label]{SQL}``                  | Plain button without accent color    |
| ``vq.danger[Label]{SQL}``            | Button with custom CSS class "danger"|
| ``vq.mod-warning.large[Label]{SQL}`` | Multiple CSS classes                 |

The related ``vq{SELECT ...}`` syntax is not a button. It is an inline query value; see the next section.

**Query behavior:**
- **SELECT/WITH queries:** Results are copied to clipboard as a markdown table
- **INSERT/UPDATE/DELETE:** Changes are applied immediately (no preview)

## Copy tasks to clipboard

```
`vq[Copy Tasks]{SELECT task_text, status FROM tasks WHERE path = '{this.path}'}`
```

## Mark all tasks done

```
`vq.mod-warning[Complete All]{UPDATE tasks SET status = 'DONE' WHERE path = '{this.path}' AND status = 'TODO'}`
```

## Recalculate table totals

```
`vq[Recalculate]{UPDATE budget_table SET Amount = (SELECT SUM(CAST(Amount AS INTEGER)) FROM budget_table WHERE Category NOT LIKE '%Total%') WHERE Category LIKE '%Total%'}`
```

> [!tip] Tip
> If button clicks lose edits, increase "Inline button debounce" in settings.

# Inline query values

Inline query values use the syntax ``vq{SELECT ...}`` inside inline code and render the first column of the first row directly in the surrounding text. Inline query values are read-only and only allow `SELECT` or `WITH` statements.

```
The hike was `vq{SELECT value FROM properties WHERE key = 'distance' AND path = '{this.path}' LIMIT 1}` miles.
```

# Obsidian CLI

When enabled in VaultQuery settings, `vaultquery:query` runs SQL from the Obsidian CLI and waits for indexing to finish before executing.

```
obsidian vaultquery:query sql="SELECT title, path FROM notes LIMIT 5" format=json
```

Available formats are `json`, `csv`, `tsv`, `md`, and `scalar`. Use `path` to provide note context for `{this.*}` placeholders.

```
obsidian vaultquery:query path="Hikes/Trip.md" sql="SELECT value FROM properties WHERE path = '{this.path}' AND key = 'distance' LIMIT 1" format=scalar
```

`INSERT`, `UPDATE`, and `DELETE` require both write operations and CLI write operations to be enabled in settings.

# Output types

Use the output-specific fence name to choose a renderer. That makes help discoverable by appending `-help` to the fence name, such as `vaultquery-chart-help` or `vaultquery-calendar-help`.

# Table grid output

`vaultquery` renders results as an interactive table grid by default.

## Table grid options

| Option      | Description                                      |
|-------------|--------------------------------------------------|
| `height`    | Fixed grid height. Use a number of pixels or CSS size like `70vh` |
| `minHeight` | Minimum grid height                              |
| `maxHeight` | Maximum grid height                              |

~~~vaultquery
SELECT title, path, modified
FROM notes
ORDER BY modified DESC
LIMIT 20;

config:
height: 320px
~~~

# Markdown output

There are two ways to export query results as markdown tables:

1. **Copy to markdown button** - In any table/chart/template `vaultquery` block, click the upper-right button to copy the current results as a markdown table.

2. **Markdown output block** - Use the `vaultquery-markdown` fence. For help, change it to `vaultquery-markdown-help`.

## Markdown output options

| Option      | Description                                              |
|-------------|----------------------------------------------------------|
| `columns`   | Comma-separated list to reorder or limit columns         |
| `alignment` | Column alignments: left, center, right (comma-separated) |

## Basic markdown export

~~~vaultquery-markdown
SELECT title, path, modified
FROM notes
ORDER BY modified DESC
LIMIT 10;
~~~

## With column selection and alignment

~~~vaultquery-markdown
SELECT title, size
FROM notes
ORDER BY size DESC
LIMIT 10;

config:
columns: title, size
alignment: left, right
~~~

# Charts & visualizations

Use `vaultquery-chart` for chart output. Query must use `label` and `value` columns (or `x`/`y` for scatter). Add a `series` column for multiple datasets.

Use a `vaultquery-chart-help` code block for the full chart reference, including result columns, config options, colors, multi-series charts, mixed charts, and examples.

# Calendar output

Use `vaultquery-calendar` for calendar output. Each result row becomes one calendar item. At minimum, the query must return a date column.

Use a `vaultquery-calendar-help` code block for the full calendar reference, including result columns, config options, responsive behavior, clickable events, and examples.

# Performance & Troubleshooting

## Analyzing query performance

Use `EXPLAIN QUERY PLAN` to inspect how SQLite executes the query:

~~~vaultquery
EXPLAIN QUERY PLAN
SELECT n.path, n.title, p.value as status
FROM notes n
JOIN properties p ON n.path = p.path AND p.key = 'status'
WHERE n.path LIKE 'Projects/%'
~~~

### Reading the output

| Term | Meaning |
|------|---------|
| `SCAN` | Full table scan (slow for large tables) |
| `SEARCH` | Index lookup (fast) |
| `USING INDEX` | Which index is being used |
| `COVERING INDEX` | Index contains all needed columns (fastest) |

### Common optimizations

1. **Prefer `notes_with_properties` for convenience, joins for speed** - The view joins all property keys which is convenient but slower. For performance-critical queries, use direct joins:

   Convenient:
   ~~~vaultquery
   SELECT path, title, status FROM notes_with_properties WHERE status = 'active'
   ~~~

   Faster:
   ~~~vaultquery
   SELECT n.path, n.title, p.value as status
   FROM notes n
   JOIN properties p ON n.path = p.path AND p.key = 'status'
   WHERE p.value = 'active'
   ~~~

2. **Filter early** - Put WHERE conditions on the smallest result set first

3. **Use EXISTS instead of IN** - For subqueries returning many rows:

   ~~~vaultquery
   -- Instead of: WHERE path IN (SELECT path FROM tags WHERE tag_name = '#project')
   SELECT * FROM notes n
   WHERE EXISTS (SELECT 1 FROM tags t WHERE t.path = n.path AND t.tag_name = '#project')
   ~~~

# JavaScript rendering

Enable JavaScript rendering in settings, then use `template:` after the SQL query (ending with `;`) to run JavaScript rendering code.

- `results` - Array of row objects from query
- `count` - Number of rows returned
- `query` - The SQL query string

Helper functions available via `h`:

- `h.link(path, text?)` - Create internal link
- `h.escape(text)` - Escape HTML characters
- `h.truncate(text, length?)` - Truncate text (default 200 chars)
- `h.formatDate(timestamp)` - Format timestamp as date

## Simple list template

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
