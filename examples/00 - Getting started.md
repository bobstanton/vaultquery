---
status: active
priority: high
category: documentation
---

VaultQuery examples for an Obsidian vault.

> [!tip] Enable table indexing
> A `vaultquery-help` code block shows schema and examples.

## Schema basics
VaultQuery indexes the vault into these tables:

| Table         | Contents                                                      |
| ------------- | ------------------------------------------------------------- |
| `notes`       | File metadata (path, title, content, created, modified, size) |
| `properties`  | Frontmatter key-value pairs                                   |
| `tasks`       | Task items with status, dates, priority                       |
| `tags`        | #tags                                                         |
| `headings`    | H1-H6 headings                                                |
| `links`       | Internal [[wiki-links]]                                       |
| `table_cells` | Markdown table data                                           |

The `vaultquery-schema` code block shows the full schema reference.

### Convenience Views
VaultQuery creates these views when the underlying table is indexed:

| View                    | Description                                          | Writable |
| ----------------------- | ---------------------------------------------------- | -------- |
| `notes_with_properties` | Notes with each property key as a column             | Yes      |
| `headings_view`         | Headings with path, level, text, and position info   | Yes      |
| `list_items_view`       | List items with parent content for hierarchy queries | Yes      |
| `table_rows`            | Table data as JSON rows for easier manipulation      | Yes      |
| `*_table`               | Dynamic views per table structure                    | Yes      |

## Template variables
Reference the current note dynamically in queries:

| Variable               | Type   | Description                            | Example                         |
| ---------------------- | ------ | -------------------------------------- | ------------------------------- |
| `{this.path}`          | string | Current note's full path               | `folder/note.md`                |
| `{this.folder}`        | string | Current note's folder (trailing slash) | `folder/`                       |
| `{this.title}`         | string | Current note's title (filename)        | `note`                          |
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

> [!note] Precedence
> Built-in variables always take precedence over frontmatter properties with the same name.

---

## Example Queries
### Finding other notes in this folder

```vaultquery
SELECT path, title
FROM notes
WHERE path LIKE '{this.folder}%'
LIMIT 10
```
### Basic query patterns

Select properties in this note:

```vaultquery
SELECT key, value
FROM properties
WHERE path = '{this.path}'
ORDER BY key
```

Find incomplete tasks in this note:
### Jim's Tasks

- [x] Buy more jello ⏫ 
- [ ] Complete [[rundown]] for Charles 🔽 
- [ ] Purchase glasses, mustard-colored, short-sleeved collared shirt and calculator watch
- [ ] Plan office olympics

```vaultquery
SELECT task_text, priority
FROM tasks
WHERE path = '{this.path}'
  AND status != 'DONE'
ORDER BY priority NULLS LAST
```

Find tags in this note:
#the-electric-city

```vaultquery
SELECT tag_name, count(1) Count
FROM tags
WHERE path = '{this.path}'
GROUP BY tag_name
ORDER BY tag_name
```

## Markdown output

Render the same query as a markdown table:

```vaultquery-markdown
SELECT title, modified, size
FROM notes
ORDER BY modified DESC
LIMIT 5;

config:
columns: title, modified, size
alignment: left, right, right
```

## Write Operations

> [!important] Enable write operations
> Write operations are disabled by default. Enable at Settings → VaultQuery → Enable write operations.

`vaultquery-write` updates the tasks above:

```vaultquery-write
UPDATE headings
SET heading_text = 'Updated heading for Write Operations'
WHERE path = '{this.path}'
  AND heading_text = 'Write Operations'
```

## Next steps
- **[[01 - Schema reference]]** - Table and column reference
- **[[02 - Querying Notes]]** - Finding and filtering notes
- **[[03 - Tasks]]** - Task management with Obsidian Tasks format
- **[[04 - Properties]]** - Working with note metadata
- **[[05 - Charts]]** - Creating visual dashboards
- **[[06 - Calendar]]** - Viewing query results on a calendar
- **[[07 - List Items]]** - Working with list items
- **[[08 - Tables]]** - Working with markdown tables
- **[[09 - JavaScript Rendering]]** - Render results with user-authored JavaScript
- **[[10 - Views]]** - Custom reusable SQL views
- **[[11 - Functions]]** - User-defined JavaScript functions
- **[[12 - Triggers]]** - Automate actions on note changes
