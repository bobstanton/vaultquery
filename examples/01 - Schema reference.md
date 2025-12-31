---
status: active
priority: 5
project: vaultquery
---

> [!tip]
> For complete schema reference, use the `vaultquery-schema` code block to see complete details specific to this vault (when dynamic views are enabled).

## Discovering the Schema

Use the [SQLite Schema Table](https://www.sqlite.org/schematab.html) to find all tables and views:

```vaultquery
SELECT name, type, sql
FROM sqlite_master
WHERE type IN ('table', 'view')
  AND name NOT LIKE 'sqlite_%'
ORDER BY type, name
```

## Core Tables

### notes

| Column     | Type    | Description                                                |
| ---------- | ------- | ---------------------------------------------------------- |
| `path`     | TEXT    | Full file path (e.g., `Projects/my-note.md`)               |
| `title`    | TEXT    | Note title                                                 |
| `content`  | TEXT    | Full markdown content (if `Index Note Content` is enabled) |
| `created`  | INTEGER | Unix timestamp (milliseconds)                              |
| `modified` | INTEGER | Unix timestamp (milliseconds)                              |
| `size`     | INTEGER | File size in bytes                                         |

```vaultquery
SELECT path, title,
  datetime(created/1000, 'unixepoch') as created_date,
  datetime(modified/1000, 'unixepoch') as modified_date,
  size
FROM notes
ORDER BY modified DESC
LIMIT 10
```

### properties

> [!important] Enable frontmatter indexing
> Frontmatter queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index frontmatter

| Column        | Type    | Description                                                      |
| ------------- | ------- | ---------------------------------------------------------------- |
| `path`        | TEXT    | File path (part of primary key)                                  |
| `key`         | TEXT    | Property name (part of primary key)                              |
| `value`       | TEXT    | Property value (always stored as text)                           |
| `value_type`  | TEXT    | Original type: `string`, `number`, `boolean`, `date`, `array`    |
| `array_index` | INTEGER | Index for array items, NULL for non-arrays (part of primary key) |

```vaultquery
-- Find all unique property keys in the vault
SELECT key, COUNT(*) as usage_count, value_type
FROM properties
GROUP BY key, value_type
ORDER BY usage_count DESC
```

### tasks

> [!important] Enable task indexing
> Task queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index tasks

| Column            | Type    | Description                                  |
| ----------------- | ------- | -------------------------------------------- |
| `id`              | INTEGER | Unique identifier                            |
| `path`            | TEXT    | File path                                    |
| `task_text`       | TEXT    | Task description (without checkbox)          |
| `status`          | TEXT    | `TODO`, `DONE`, `IN_PROGRESS`, `CANCELLED`   |
| `priority`        | TEXT    | `highest`, `high`, `medium`, `low`, `lowest` |
| `due_date`        | TEXT    | Due date (YYYY-MM-DD)                        |
| `scheduled_date`  | TEXT    | Scheduled date (YYYY-MM-DD)                  |
| `start_date`      | TEXT    | Start date (YYYY-MM-DD)                      |
| `created_date`    | TEXT    | Created date (YYYY-MM-DD)                    |
| `done_date`       | TEXT    | Completion date (YYYY-MM-DD)                 |
| `cancelled_date`  | TEXT    | Cancellation date (YYYY-MM-DD)               |
| `recurrence`      | TEXT    | Recurrence rule (e.g., `every week`)         |
| `on_completion`   | TEXT    | Action on completion: `keep` or `delete`     |
| `task_id`         | TEXT    | Task identifier for dependencies             |
| `depends_on`      | TEXT    | Comma-separated task IDs                     |
| `tags`            | TEXT    | Space-separated tags                         |
| `line_number`     | INTEGER | Line number in file                          |
| `block_id`        | TEXT    | Obsidian block reference                     |
| `start_offset`    | INTEGER | Character offset (start)                     |
| `end_offset`      | INTEGER | Character offset (end)                       |
| `anchor_hash`     | TEXT    | Content hash for change detection            |
| `section_heading` | TEXT    | Parent heading text                          |

```vaultquery
-- Find overdue tasks
SELECT path, task_text, due_date, priority
FROM tasks
WHERE status != 'DONE'
  AND due_date < date('now')
ORDER BY due_date
```

### tasks_view

View with computed columns for easier querying. Supports INSERT, UPDATE, DELETE. Contains all columns from `tasks` plus:

| Column           | Type    | Description                                          |
| ---------------- | ------- | ---------------------------------------------------- |
| `status_order`   | INTEGER | 1=IN_PROGRESS, 2=TODO, 3=DONE, 4=CANCELLED           |
| `priority_order` | INTEGER | 1=highest, 2=high, 3=medium, 4=low, 5=lowest, 6=none |
| `is_complete`    | INTEGER | 1 if DONE or CANCELLED, 0 otherwise                  |
| `is_overdue`     | INTEGER | 1 if incomplete and past due_date                    |
| `days_until_due` | INTEGER | Days until due (negative = overdue)                  |

```vaultquery
-- Simplified ordering using computed columns
SELECT task_text, status, priority, days_until_due
FROM tasks_view
WHERE is_complete = 0
ORDER BY status_order, priority_order
```

INSERT defaults: `status` → 'TODO', `created_date` → today, `line_number` → end of file.

- [ ] Example task for insert demo ^task-example

```vaultquery-write
-- Insert a new task after the example task above (using line_number positioning)
INSERT INTO tasks_view (path, task_text, priority, due_date, line_number)
SELECT '{this.path}', 'New task', 'high', date('now', '+7 days'), line_number + 1
FROM tasks
WHERE path = '{this.path}' AND block_id = 'task-example'
```

### tags

> [!important] Enable tag indexing
> Tag queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index tags

| Column        | Type    | Description                     |
| ------------- | ------- | ------------------------------- |
| `id`          | INTEGER | Unique identifier               |
| `path`        | TEXT    | File path                       |
| `tag_name`    | TEXT    | Tag without # (e.g., `project`) |
| `line_number` | INTEGER | Line number where tag appears   |

```vaultquery
-- Top twenty tags used across vault
SELECT tag_name, COUNT(*) as count
FROM tags
GROUP BY tag_name
ORDER BY count DESC
LIMIT 20
```

### headings

> [!important] Enable heading indexing
> Heading queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index headings

| Column         | Type    | Description                |
| -------------- | ------- | -------------------------- |
| `id`           | INTEGER | Unique identifier          |
| `path`         | TEXT    | File path                  |
| `level`        | INTEGER | Heading level (1-6)        |
| `heading_text` | TEXT    | Heading content            |
| `line_number`  | INTEGER | Line number                |
| `block_id`     | TEXT    | Block reference if present |
| `start_offset` | INTEGER | Character offset (start)   |
| `end_offset`   | INTEGER | Character offset (end)     |
| `anchor_hash`  | TEXT    | Content hash               |

```vaultquery
-- Find all H1 headings (main titles)
SELECT path, heading_text
FROM headings
WHERE level = 1
```

### links

> [!important] Enable link indexing
> Link queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index links

| Column        | Type    | Description                     |
| ------------- | ------- | ------------------------------- |
| `id`          | INTEGER | Unique identifier               |
| `path`        | TEXT    | Source file path                |
| `link_target` | TEXT    | Target note path                |
| `link_text`   | TEXT    | Display text                    |
| `link_type`   | TEXT    | `internal`, `external`, `embed` |
| `line_number` | INTEGER | Line number                     |

```vaultquery
-- Find orphan notes (not linked anywhere)
SELECT n.path
FROM notes n
LEFT JOIN links l ON n.path = l.link_target
WHERE l.id IS NULL
ORDER BY n.path
```

```vaultquery
-- Most linked-to notes
SELECT link_target, COUNT(*) as incoming_links
FROM links
WHERE link_type = 'internal'
GROUP BY link_target
ORDER BY incoming_links DESC
LIMIT 10
```

### list_items

> [!important] Enable list item indexing
> List item queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index list items

| Column         | Type    | Description                         |
| -------------- | ------- | ----------------------------------- |
| `id`           | INTEGER | Unique identifier                   |
| `path`         | TEXT    | File path                           |
| `list_index`   | INTEGER | List number in file (0-based)       |
| `item_index`   | INTEGER | Item position within entire file    |
| `parent_index` | INTEGER | Parent item index (NULL for root)   |
| `content`      | TEXT    | Item text (without marker)          |
| `list_type`    | TEXT    | `bullet` or `number`                |
| `indent_level` | INTEGER | Nesting depth (0 = top level)       |
| `line_number`  | INTEGER | Line number                         |
| `block_id`     | TEXT    | Block reference if present          |
| `start_offset` | INTEGER | Character offset (start)            |
| `end_offset`   | INTEGER | Character offset (end)              |
| `anchor_hash`  | TEXT    | Content hash for change detection   |

```vaultquery
-- Find all list items in the current note
SELECT list_index, item_index, indent_level, content
FROM list_items
WHERE path like '{this.folder}%'
ORDER BY list_index, item_index
```

```vaultquery
-- Count list items by note
SELECT path, COUNT(*) as item_count
FROM list_items
GROUP BY path
ORDER BY item_count DESC
LIMIT 10
```

### list_items_view

View for list items with parent content included. Supports INSERT, UPDATE, DELETE.

| Column           | Type    | Description                              |
| ---------------- | ------- | ---------------------------------------- |
| All columns from `list_items` plus: | | |
| `parent_content` | TEXT    | Content of the parent item (NULL for root items) |

Example list for queries:

- Original content ^list-example

```vaultquery
-- Query list items with their parent content
SELECT content, parent_content, indent_level
FROM list_items_view
WHERE path = '{this.path}'
ORDER BY item_index
```

> [!important] Enable write operations
> Write operations are disabled by default. To enable go to Settings → VaultQuery → Write operations → Enable write operations

```vaultquery-write
-- Update list item content via the view (targets block_id ^list-example above)
UPDATE list_items_view
SET content = 'Updated content'
WHERE path = '{this.path}'
  AND block_id = 'list-example'
```

INSERT defaults: `list_type` → 'bullet', `indent_level` → 0, `line_number` → end of file.

```vaultquery-write
-- Insert a new list item after the example list (using line_number from the existing item)
INSERT INTO list_items_view (path, content, line_number)
SELECT '{this.path}', 'New list item', line_number + 1
FROM list_items
WHERE path = '{this.path}' AND block_id = 'list-example'
```

> [!important] Enable table indexing
> Table queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index tables

### table_cells

| Column        | Type    | Description                    |
| ------------- | ------- | ------------------------------ |
| `id`          | INTEGER | Unique identifier              |
| `path`        | TEXT    | File path                      |
| `table_index` | INTEGER | Table number in file (0-based) |
| `table_name`  | TEXT    | Table identifier               |
| `row_index`   | INTEGER | Row number (0-based)           |
| `column_name` | TEXT    | Column header                  |
| `cell_value`  | TEXT    | Cell content                   |
| `value_type`  | TEXT    | Inferred type                  |
| `line_number` | INTEGER | Line number                    |

```vaultquery
-- Find all unique column names across tables
SELECT column_name, COUNT(*) as occurrences
FROM table_cells
GROUP BY column_name
ORDER BY occurrences DESC
```

### table_rows (View)

Aggregated view of table cells by row. 

```vaultquery
SELECT path, table_index, row_index, row_json
FROM table_rows
WHERE path = '{this.path}'
```

### headings_view

View for heading operations. Supports INSERT, UPDATE, DELETE.

## Old Section Title ^heading-example

This section demonstrates heading updates. The query below will rename this heading.

```vaultquery-write
-- Update heading text (targets block_id ^heading-example above)
UPDATE headings_view
SET heading_text = 'Updated Section Title'
WHERE path = '{this.path}'
  AND block_id = 'heading-example'
```

INSERT defaults: `level` → 1, `line_number` → end of file.

```vaultquery-write
-- Insert a new heading after this section (using line_number from the existing heading)
INSERT INTO headings_view (path, level, heading_text, line_number)
SELECT '{this.path}', 2, 'New Section', line_number + 3
FROM headings
WHERE path = '{this.path}' AND block_id = 'heading-example'
```

## Dynamic Views

### notes_with_properties

Auto-generated view that pivots properties into columns. Each unique property key becomes a column. Created automatically when frontmatter indexing is enabled.

**Using the view**:

```vaultquery
-- Using the notes_with_properties view
SELECT path, title, status, priority
FROM notes_with_properties
WHERE status IS NOT NULL
ORDER BY title
LIMIT 10
```

**Manually, using aggregates**:

```vaultquery
-- Manual pivot query (always works)
SELECT n.path, n.title,
  MAX(CASE WHEN p.key = 'status' THEN p.value END) as status,
  MAX(CASE WHEN p.key = 'priority' THEN p.value END) as priority
FROM notes n
LEFT JOIN properties p ON n.path = p.path
GROUP BY n.path
HAVING status IS NOT NULL
ORDER BY n.title
LIMIT 10
```

**Manually, using joins**:

```vaultquery
SELECT n.path, n.title, p1.value as status, p2.value as priority
FROM notes n
INNER JOIN properties p1 ON n.path = p1.path AND p1.key = 'status'
LEFT JOIN properties p2 ON n.path = p2.path AND p2.key = 'priority'
WHERE status = 'active' 
ORDER BY n.title
LIMIT 10
```

Property values are always stored as text. Cast when needed:

```vaultquery
-- Cast to number for comparisons
SELECT path, CAST(value AS INTEGER) as priority
FROM properties
WHERE key = 'priority'
  AND CAST(value AS INTEGER) > 5
```

```vaultquery
-- Date comparisons
SELECT path, value as due_date
FROM properties
WHERE key = 'due'
  AND value >= date('now')
```
