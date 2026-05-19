---
id: vaultquery-trigger-help
title: VaultQuery Trigger Reference
---

# VaultQuery Triggers

Triggers automate actions when notes are created, updated, or deleted. They use SQLite trigger syntax and can either queue file modifications via `vq_*` functions or make database-only changes with direct SQL.

## How Triggers Work

1. Define a trigger in a `vaultquery-trigger` code block
2. When a note is indexed, the trigger SQL is registered with the database
3. When data changes match the trigger condition, the trigger body executes
4. If using `vq_*` functions, file modifications are applied after indexing completes

> [!important] Timing
> Changes made by triggers do not trigger other triggers.

> [!note] INSERT vs UPDATE Semantics
> During indexing, VaultQuery properly distinguishes between new and modified records:
> - **notes**: AFTER INSERT fires for new files, AFTER UPDATE fires when file content changes
> - **properties**: AFTER INSERT fires for new properties, AFTER UPDATE fires when values change
> - **tags**: AFTER INSERT fires only for genuinely new tag occurrences. Line number shifts (e.g., from editing above a tag) are handled as updates without firing INSERT triggers.
> - **headings**: AFTER INSERT fires only for new heading text. Existing headings that move (line number changes) are updated without firing INSERT triggers.
> - **tasks, list_items**: AFTER INSERT/UPDATE fires correctly when items have a `block_id` or `anchor_hash`. Items without these identifiers use line-based fallback matching.
>
> This allows triggers to respond differently to new vs modified data.

## Two Approaches

### 1. File-Modifying Functions (`vq_*`)

These functions queue actions that modify actual markdown files:

#### General Functions

| Function | Description |
|----------|-------------|
| `vq_set_property(path, key, value)` | Set a frontmatter property |
| `vq_remove_property(path, key)` | Remove a frontmatter property |
| `vq_rename_note(path, new_name)` | Rename a note (keeps same folder) |
| `vq_set_content(path, content)` | Replace entire file content (preserves frontmatter) |
| `vq_replace_content(path, search, replacement)` | Replace text in file content |
| `vq_notify(message)` | Show an Obsidian notification |
| `vq_log(message)` | Log to developer console |
| `vq_debounce(key, ms)` | Returns 1 if `ms` milliseconds have passed since last call with this `key`, 0 otherwise. Use in WHEN clause to debounce triggers (leading edge). |
| `vq_defer(key, ms)` | Trailing-edge debounce: defers all subsequent `vq_*` calls in the trigger body until `ms` milliseconds of idle time passes. Call at START of trigger body. |

#### Task Functions

| Function | Description |
|----------|-------------|
| `vq_complete_task(path, line_number)` | Mark a task as done (`[x]`) |
| `vq_uncomplete_task(path, line_number)` | Mark a task as todo (`[ ]`) |
| `vq_set_task_status(path, line_number, status)` | Set task status (DONE, TODO, IN_PROGRESS, etc.) |
| `vq_set_task_text(path, line_number, text)` | Update task text (preserves checkbox status) |
| `vq_add_task(path, text, after_line)` | Add a new task after specified line (0 = start of file) |
| `vq_delete_task(path, line_number)` | Delete a task at the specified line |

#### Heading Functions

| Function | Description |
|----------|-------------|
| `vq_set_heading_text(path, line_number, text)` | Update heading text (preserves level) |
| `vq_set_heading_level(path, line_number, level)` | Change heading level (1-6) |
| `vq_add_heading(path, level, text, after_line)` | Add a new heading after specified line |
| `vq_delete_heading(path, line_number)` | Delete a heading at the specified line |

#### List Item Functions

| Function | Description |
|----------|-------------|
| `vq_set_list_item_text(path, line_number, text)` | Update list item text (preserves marker) |
| `vq_add_list_item(path, text, after_line)` | Add a new list item after specified line |
| `vq_delete_list_item(path, line_number)` | Delete a list item at the specified line |

#### Table Functions

| Function | Description |
|----------|-------------|
| `vq_add_table_row(path, table_index, values_json)` | Add a row to a markdown table. `values_json` is a JSON object mapping column names to values, e.g., `'{"Name": "John", "Age": "30"}'` |
| `vq_set_table_cell(path, table_index, row_index, column_name, value)` | Update a specific cell in a table. `row_index` is 0-based from data rows (excludes header/separator). |
| `vq_delete_table_row(path, table_index, row_index)` | Delete a row from a table. `row_index` is 0-based from data rows. |

#### Note Functions

| Function | Description |
|----------|-------------|
| `vq_create_note(path, content)` | Create a new note at the specified path. Does nothing if the file already exists. Creates parent folders if needed. |

### 2. Direct SQL (Auto-Synced)

Regular SQL statements can also be used in triggers. Changes to the following are **automatically synced back to files**:

| Table | Auto-Synced Columns |
|-------|---------------------|
| `notes` | `content` |
| `properties` | `value` |
| `tasks` | `status`, `task_text` |
| `headings` | `level`, `heading_text` |
| `list_items` | `content` |

For other tables (`links`, `tags`, `table_cells`), changes are database-only and will be overwritten on the next reindex. This is useful for:
- Computed/derived columns
- Temporary flags or caches
- Cross-referencing data

# Example: Auto-set Icon Based on Folder

**Goal:** When a note is created in "Projects/", set `icon: 📁` in frontmatter.

## Using `vq_set_property` (Modifies File)

~~~vaultquery-trigger
CREATE TRIGGER auto_project_icon
AFTER INSERT ON notes
WHEN NEW.path LIKE 'Projects/%'
BEGIN
  SELECT vq_set_property(NEW.path, 'icon', '📁');
END;
~~~

This adds `icon: 📁` to the file's frontmatter.

## Using Direct SQL (Database-Only)

~~~vaultquery-trigger
CREATE TRIGGER auto_project_icon_db
AFTER INSERT ON notes
WHEN NEW.path LIKE 'Projects/%'
BEGIN
  INSERT OR REPLACE INTO properties (path, key, value, value_type, array_index)
  VALUES (NEW.path, 'icon', '📁', 'string', NULL);
END;
~~~

This updates the database but the file will not have the `icon` property. The change persists until the file is reindexed.

# Example: Auto-rename Untitled Notes

**Goal:** When a note is created in "Daily Notes/" with name "Untitled", rename it to today's date.

## Using `vq_rename_note` (Modifies File)

~~~vaultquery-trigger
CREATE TRIGGER auto_rename_untitled
AFTER INSERT ON notes
WHEN NEW.path LIKE 'Daily Notes/%'
  AND NEW.title = 'Untitled'
BEGIN
  SELECT vq_rename_note(
    NEW.path,
    strftime('%Y-%m-%d', 'now')
  );
END;
~~~

This actually renames the file on disk.

## Using Direct SQL (Database-Only)

~~~vaultquery-trigger
CREATE TRIGGER auto_rename_untitled_db
AFTER INSERT ON notes
WHEN NEW.path LIKE 'Daily Notes/%'
  AND NEW.title = 'Untitled'
BEGIN
  UPDATE notes
  SET title = strftime('%Y-%m-%d', 'now')
  WHERE path = NEW.path;
END;
~~~

This only changes the `title` column in the database. The actual file remains named "Untitled.md" and will revert on reindex.

# Example: Replace Date Placeholders

**Goal:** When a note contains `{{today}}`, replace it with today's date (e.g., "2026-01-06").

> [!warning] Avoid Self-Modification
> If the note containing the trigger also contains the placeholder text (like `{{today}}` in the trigger SQL), the trigger could modify itself. Use `{this.path}` to automatically exclude the trigger's own file.

## Using `vq_replace_content` (Modifies File)

Use AFTER INSERT to run when a new note is created:

~~~vaultquery-trigger
CREATE TRIGGER replace_today_on_create
AFTER INSERT ON notes
WHEN NEW.content LIKE '%{{today}}%'
  AND NEW.path != '{this.path}'
BEGIN
  SELECT vq_replace_content(
    NEW.path,
    '{{today}}',
    strftime('%Y-%m-%d', 'now')
  );
END;
~~~

Or use AFTER UPDATE to run when an existing note is edited:

~~~vaultquery-trigger
CREATE TRIGGER replace_today_on_edit
AFTER UPDATE ON notes
WHEN NEW.content LIKE '%{{today}}%'
  AND NEW.path != '{this.path}'
BEGIN
  SELECT vq_replace_content(
    NEW.path,
    '{{today}}',
    strftime('%Y-%m-%d', 'now')
  );
END;
~~~

Both triggers modify the actual file content. Use AFTER INSERT for new notes only, AFTER UPDATE for edits only, or create both for complete coverage. The `{this.path}` placeholder is automatically replaced with the path of the note containing the trigger.

## Using Direct SQL (Auto-Synced)

Use AFTER INSERT for new notes:

~~~vaultquery-trigger
CREATE TRIGGER replace_today_db
AFTER INSERT ON notes
WHEN NEW.content LIKE '%{{today}}%'
  AND NEW.path != '{this.path}'
BEGIN
  UPDATE notes
  SET content = replace(content, '{{today}}', strftime('%Y-%m-%d', 'now'))
  WHERE path = NEW.path;
END;
~~~

Or AFTER UPDATE for existing notes:

~~~vaultquery-trigger
CREATE TRIGGER replace_today_db_update
AFTER UPDATE ON notes
WHEN NEW.content LIKE '%{{today}}%'
  AND NEW.path != '{this.path}'
BEGIN
  UPDATE notes
  SET content = replace(content, '{{today}}', strftime('%Y-%m-%d', 'now'))
  WHERE path = NEW.path;
END;
~~~

> [!tip] Auto-Sync
> When triggers modify `notes.content`, `properties`, `tasks`, `headings`, or `list_items`, changes are automatically synced back to files. This means direct SQL modifications are persistent, just like using `vq_*` functions.

# Example: Notify on Task Completion

**Goal:** Show a notification when a task is marked as DONE.

## Using `vq_notify`

~~~vaultquery-trigger
CREATE TRIGGER task_completed_notify
AFTER UPDATE ON tasks
WHEN OLD.status != 'DONE' AND NEW.status = 'DONE'
BEGIN
  SELECT vq_notify('Task completed: ' || substr(NEW.task_text, 1, 50));
END;
~~~

## Using `vq_log` (Console Only)

~~~vaultquery-trigger
CREATE TRIGGER task_completed_log
AFTER UPDATE ON tasks
WHEN OLD.status != 'DONE' AND NEW.status = 'DONE'
BEGIN
  SELECT vq_log('Task completed: ' || NEW.task_text);
END;
~~~

# Example: Computed Column - Days Until Due

**Goal:** Maintain a computed column tracking days until a task is due.

## Using Direct SQL

~~~vaultquery-trigger
CREATE TRIGGER update_days_until_due
AFTER INSERT ON tasks
WHEN NEW.due_date IS NOT NULL
BEGIN
  -- This is a database-only computation
  -- Query this later for sorting/filtering
  SELECT vq_log(
    'Task due in ' ||
    (julianday(NEW.due_date) - julianday('now')) ||
    ' days: ' || NEW.task_text
  );
END;
~~~

> [!note] Note
> For truly computed columns, consider using a VIEW instead of a trigger.

# Example: Cross-Reference Tags

**Goal:** When a note gets a #project tag, ensure it has a `status` property.

## Using `vq_set_property` (Modifies File)

~~~vaultquery-trigger
CREATE TRIGGER ensure_project_status
AFTER INSERT ON tags
WHEN NEW.tag_name = '#project'
  AND NOT EXISTS (
    SELECT 1 FROM properties
    WHERE path = NEW.path AND key = 'status'
  )
BEGIN
  SELECT vq_set_property(NEW.path, 'status', 'active');
END;
~~~

## Using Direct SQL (Database-Only)

~~~vaultquery-trigger
CREATE TRIGGER ensure_project_status_db
AFTER INSERT ON tags
WHEN NEW.tag_name = '#project'
  AND NOT EXISTS (
    SELECT 1 FROM properties
    WHERE path = NEW.path AND key = 'status'
  )
BEGIN
  INSERT INTO properties (path, key, value, value_type, array_index)
  VALUES (NEW.path, 'status', 'active', 'string', NULL);
END;
~~~

# Example: Debouncing Triggers

**Goal:** Prevent a trigger from firing repeatedly while the user is still typing.

When editing a heading, each keystroke can trigger a reindex. Without debouncing, the trigger might fire dozens of times while typing a single heading. Use `vq_debounce(key, ms)` to only execute the trigger if enough time has passed.

## Global Debounce (Per-Trigger)

Only fire once per 500ms, regardless of which file changed:

~~~vaultquery-trigger
CREATE TRIGGER format_heading_debounced
AFTER INSERT ON headings
WHEN vq_debounce('format_heading', 500)
BEGIN
  SELECT vq_log('Heading inserted: ' || NEW.heading_text);
END;
~~~

## Per-Path Debounce

Debounce separately for each file (one file typing won't block another):

~~~vaultquery-trigger
CREATE TRIGGER format_heading_per_file
AFTER INSERT ON headings
WHEN vq_debounce('format_heading:' || NEW.path, 500)
BEGIN
  SELECT vq_log('Heading inserted in ' || NEW.path || ': ' || NEW.heading_text);
END;
~~~

## Combining with Other Conditions

Use `AND` to combine debounce with other conditions:

~~~vaultquery-trigger
CREATE TRIGGER auto_tag_project_debounced
AFTER INSERT ON headings
WHEN NEW.heading_text LIKE 'Project:%'
  AND vq_debounce('auto_tag:' || NEW.path, 1000)
BEGIN
  SELECT vq_set_property(NEW.path, 'type', 'project');
END;
~~~

> [!tip] Choosing Debounce Time
> - **300-500ms** - Good for most typing scenarios
> - **1000ms+** - For expensive operations that should run rarely
> - **Per-path debounce** - Usually preferred so editing one file doesn't block triggers in another

## Trailing-Edge Debounce with `vq_defer`

`vq_debounce` uses **leading-edge** behavior: the trigger fires immediately on the first event, then blocks subsequent events until the cooldown passes.

`vq_defer` uses **trailing-edge** behavior: the trigger waits until activity stops for the specified duration, then executes once with the final state. This is useful for waiting until typing stops before taking action.

~~~vaultquery-trigger
CREATE TRIGGER format_heading_after_idle
AFTER INSERT ON headings
BEGIN
  -- Defer all actions until 3 seconds of idle time
  SELECT vq_defer('heading:' || NEW.path, 3000);

  -- These actions will only execute after 3 seconds with no new headings
  SELECT vq_log('Heading finalized: ' || NEW.heading_text);
  SELECT vq_set_property(NEW.path, 'last_heading', NEW.heading_text);
END;
~~~

**Key differences:**
- `vq_debounce` → Executes immediately, blocks repeats (use in WHEN clause)
- `vq_defer` → Waits for idle, then executes (use in BEGIN block)

# Trigger Syntax Reference

~~~vaultquery-trigger
CREATE TRIGGER trigger_name
{BEFORE | AFTER} {INSERT | UPDATE | DELETE} ON table_name
[WHEN condition]
BEGIN
  -- SQL statements and/or vq_* function calls
END;
~~~

## Supported Tables

- `notes` - Note metadata (path, title, content, created, modified, size)
- `properties` - Frontmatter properties
- `tasks` - Tasks with status, dates, etc.
- `headings` - Heading text and levels
- `links` - Internal and external links
- `tags` - Inline tags
- `list_items` - List items
- `table_cells` - Markdown table data

## Special References

- `NEW.column` - New value (INSERT/UPDATE)
- `OLD.column` - Previous value (UPDATE/DELETE)

# Tips & Best Practices

1. **Use `{this.path}` to prevent self-modification** - Triggers containing placeholder text can modify themselves
2. **Test with `vq_log` first** - Verify trigger conditions before adding actions
3. **Be specific with conditions** - Use precise WHEN clauses to avoid unintended matches
4. **Check for existing values** - Avoid setting properties that already have the desired value
5. **One action per trigger** - Keep triggers focused; create multiple triggers for complex logic
6. **Direct SQL on `notes`, `properties`, `tasks`, `headings`, `list_items` auto-syncs** - Changes are written back to files
7. **Use both INSERT and UPDATE triggers for full coverage** - AFTER INSERT fires for new notes, AFTER UPDATE fires for edits
8. **Trigger names are global** - If two notes define a trigger with the same name, the last one loaded wins. Use unique, descriptive names like `auto_project_icon_on_create`
9. **Debounce typing-sensitive triggers** - Use `vq_debounce('key', 500)` in WHEN clause to prevent triggers from firing on every keystroke

# Registered Triggers

{{dynamic:triggers}}
