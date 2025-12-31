---
id: vaultquery-help
title: VaultQuery Help
---

# Code block types

- `vaultquery` - Output SQL queries to [SlickGrid](https://github.com/6pac/SlickGrid) or custom HTML
- `vaultquery-write` - Perform INSERT, UPDATE, DELETE, or multiple operations with preview
- `vaultquery-chart` - Output queries as charts using [Chart.js](https://www.chartjs.org/)
- `vaultquery-markdown` - Output queries as markdown tables
- `vaultquery-schema` - Display VaultQuery schema as markdown tables
- `vaultquery-view` - Define custom SQL view for use in other queries
- `vaultquery-function` - Define custom SQL functions in JavaScript for use in queries
- `vaultquery-function-help` - Display function reference and documentation
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
> - `headings_view` - level=1, line_number=auto
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
WHERE t.tag_name = 'project'
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

# Markdown output

There are two ways to export query results as markdown tables:

1. **Copy to markdown button** - In any `vaultquery` block, click the "Copy to markdown" button in the upper right to clipboard as a markdown table.

2. **`vaultquery-markdown` blocks** - Use dedicated blocks to render results directly as copyable markdown tables with optional column configuration.

## vaultquery-markdown options

| Option      | Description                                              |
|-------------|----------------------------------------------------------|
| `columns`   | Comma-separated list to reorder or limit columns         |
| `alignment` | Column alignments: left, center, right (comma-separated) |

## Basic markdown export

~~~vaultquery-markdown
SELECT title, path, modified
FROM notes
ORDER BY modified DESC
LIMIT 10
~~~

## With alignment configuration

~~~vaultquery-markdown
SELECT title, size
FROM notes
ORDER BY size DESC
LIMIT 10;

config:
alignment: left, right
~~~

# Charts & visualizations

Charts use `vaultquery-chart` blocks. Query must use `label` and `value` columns (or `x`/`y` for scatter). Add a `series` column for multiple datasets.

| Option                   | Description                                 |
|--------------------------|---------------------------------------------|
| `type`                   | bar, line, pie, doughnut, or scatter (required) |
| `title`                  | Chart title                                 |
| `datasetLabel`           | Legend label for the dataset                |
| `xLabel`                 | X-axis label (bar, line, scatter)           |
| `yLabel`                 | Y-axis label (bar, line, scatter)           |
| `datasetBackgroundColor` | Fill color (e.g., `rgba(54, 162, 235, 0.8)`) |
| `datasetBorderColor`     | Border color                                |

## Bar chart

~~~vaultquery-chart
SELECT tag_name as label, COUNT(*) as value
FROM tags
GROUP BY tag_name
ORDER BY value DESC
LIMIT 10;
config:
type: bar
datasetLabel: Tag count
~~~

## Bar chart with custom color

~~~vaultquery-chart
SELECT tag_name as label, COUNT(*) as value
FROM tags
GROUP BY tag_name
LIMIT 5;
config:
type: bar
datasetBackgroundColor: rgba(75, 192, 192, 0.8)
datasetBorderColor: rgba(75, 192, 192, 1)
~~~

## Per-bar colors via SQL

Use `backgroundColor` column to set colors per data point:

~~~vaultquery-chart
SELECT
    tag_name as label,
    COUNT(*) as value,
    CASE
        WHEN tag_name = 'important' THEN 'rgba(255, 99, 132, 0.8)'
        ELSE 'rgba(54, 162, 235, 0.8)'
    END as backgroundColor
FROM tags
GROUP BY tag_name
LIMIT 5;
config:
type: bar
~~~

## Multi-series bar chart

~~~vaultquery-chart
SELECT status as label, priority as series, COUNT(*) as value
FROM tasks
GROUP BY status, priority;
config:
type: bar
title: Tasks by status and priority
~~~

## Mixed chart (bar + line)

Use `chartType` column to mix chart types:

~~~vaultquery-chart
SELECT label, value, series, chartType, backgroundColor FROM (
    SELECT 'Jan' as label, 10 as value, 'Sales' as series,
           'bar' as chartType, 'rgba(54, 162, 235, 0.8)' as backgroundColor
    UNION ALL
    SELECT 'Jan', 8, 'Trend', 'line', 'rgba(255, 99, 132, 1)'
    UNION ALL
    SELECT 'Feb', 15, 'Sales', 'bar', 'rgba(54, 162, 235, 0.8)'
    UNION ALL
    SELECT 'Feb', 12, 'Trend', 'line', 'rgba(255, 99, 132, 1)'
);
config:
type: bar
title: Sales vs Trend
~~~

## Line chart with axis labels

~~~vaultquery-chart
SELECT done_date as label, COUNT(*) as value
FROM tasks
WHERE status = 'DONE'
GROUP BY done_date
ORDER BY done_date;
config:
type: line
xLabel: Date
yLabel: Completed
datasetLabel: Tasks completed
~~~

# Performance & Troubleshooting

## Analyzing query performance

Use `EXPLAIN QUERY PLAN` to understand how SQLite executes your query:

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
   -- Instead of: WHERE path IN (SELECT path FROM tags WHERE tag_name = 'project')
   SELECT * FROM notes n
   WHERE EXISTS (SELECT 1 FROM tags t WHERE t.path = n.path AND t.tag_name = 'project')
   ~~~

# Custom templates

Use `template:` after the SQL query (ending with `;`) to render custom HTML output.

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