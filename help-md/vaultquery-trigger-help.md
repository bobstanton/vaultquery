---
id: vaultquery-trigger-help
title: VaultQuery Trigger Reference
---

# Triggers

Use `vaultquery-trigger` to define actions on indexed data changes. Use a unique name for each trigger.

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Scripts and triggers > Enable triggers**.
>
> **Also requires:** **Enable write operations** (Changes and automation > Write permissions) and **Indexing mode > Real-time** (Indexing > Schedule and storage). Indexing must be enabled for the tables used by the trigger.
>
> **Plugin default:** Off. 

Triggers support `notes`, `properties`, `tasks`, `headings`, `links`, `tags`, `list_items`, and `table_cells`.

# Set an icon by folder

~~~vaultquery-trigger
CREATE TRIGGER auto_project_icon
AFTER INSERT ON notes
WHEN NEW.path LIKE 'Projects/%'
BEGIN
  SELECT vq_set_property(NEW.path, 'icon', '📁');
END;
~~~

# Set a property by tag

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

# Rename untitled notes

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

# Replace date placeholders

Exclude `{this.path}` when replacing text that also appears in the trigger definition.

Use `AFTER INSERT` for new notes or `AFTER UPDATE` for edits:

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

# Notify on task completion

## Using `vq_notify`

~~~vaultquery-trigger
CREATE TRIGGER task_completed_notify
AFTER UPDATE ON tasks
WHEN OLD.status != 'DONE' AND NEW.status = 'DONE'
BEGIN
  SELECT vq_notify('Task completed: ' || substr(NEW.task_text, 1, 50));
END;
~~~

## Using `vq_log` (debug log)

~~~vaultquery-trigger
CREATE TRIGGER task_completed_log
AFTER UPDATE ON tasks
WHEN OLD.status != 'DONE' AND NEW.status = 'DONE'
BEGIN
  SELECT vq_log('Task completed: ' || NEW.task_text);
END;
~~~

# Move completed tasks to the bottom

Add a unique block ID to each task. Put the trigger in the same note as the list. This example uses consecutive, unindented `- [ ]` tasks.

Completing several tasks before the list refreshes can leave some completed tasks in place.

~~~markdown
- [ ] Confirm the reservation ^reservation
- [ ] Pick up the trophies ^trophies
- [ ] Choose the host ^host
~~~

~~~vaultquery-trigger
CREATE TRIGGER completed_task_to_bottom
AFTER UPDATE OF status ON tasks
WHEN NEW.path = '{this.path}'
  AND OLD.status IN ('TODO', 'IN_PROGRESS')
  AND NEW.status = 'DONE'
BEGIN
  SELECT vq_set_content(
    NEW.path,
    regexp_replace(
      content,
      '(^|\r?\n)' ||
      '(- \[[xX]\] [^\r\n]* \^' || NEW.block_id || '[ \t]*)' ||
      '(\r?\n)' ||
      '((?:- \[[^\r\n]\] [^\r\n]*\r?\n)*- \[[^\r\n]\] [^\r\n]*)',
      '$1$4$3$2'
    )
  )
  FROM notes
  WHERE path = NEW.path;
END;
~~~

# Debounce triggers

Use `vq_debounce(key, ms)` in `WHEN` to limit repeated actions while typing.

## Global debounce (per-trigger)

Run at most once every 500 ms:

~~~vaultquery-trigger
CREATE TRIGGER format_heading_debounced
AFTER INSERT ON headings
WHEN vq_debounce('format_heading', 500)
BEGIN
  SELECT vq_log('Heading inserted: ' || NEW.heading_text);
END;
~~~

## Per-path debounce

Include `NEW.path` in the key to debounce each file separately:

~~~vaultquery-trigger
CREATE TRIGGER format_heading_per_file
AFTER INSERT ON headings
WHEN vq_debounce('format_heading:' || NEW.path, 500)
BEGIN
  SELECT vq_log('Heading inserted in ' || NEW.path || ': ' || NEW.heading_text);
END;
~~~

## Trailing-edge debounce with `vq_defer`

Call `vq_defer(key, ms)` first in the trigger body to delay subsequent `vq_*` actions until activity stops for the specified duration.

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

# File changes

## File functions (`vq_*`)

`vq_set_property` preserves an existing property's type. New properties are text.

### General functions

| Function                                        | Description                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vq_set_property(path, key, value)`             | Set a frontmatter property                                                                                                                                 |
| `vq_remove_property(path, key)`                 | Remove a frontmatter property                                                                                                                              |
| `vq_rename_note(path, new_name)`                | Rename a note (keeps same folder)                                                                                                                          |
| `vq_set_content(path, content)`                 | Replace entire file content (preserves frontmatter)                                                                                                        |
| `vq_replace_content(path, search, replacement)` | Replace text in file content                                                                                                                               |
| `vq_notify(message)`                            | Show an Obsidian notification                                                                                                                              |
| `vq_log(message)`                               | Write to the debug log                                                                                                                                     |
| `vq_debounce(key, ms)`                          | Returns 1 if `ms` milliseconds have passed since last call with this `key`, 0 otherwise. Use in WHEN clause to debounce triggers (leading edge).           |
| `vq_defer(key, ms)`                             | Trailing-edge debounce: defers all subsequent `vq_*` calls in the trigger body until `ms` milliseconds of idle time passes. Call at START of trigger body. |

### Task functions

| Function                                        | Description                                             |
| ----------------------------------------------- | ------------------------------------------------------- |
| `vq_complete_task(path, line_number)`           | Mark a task as done (`[x]`)                             |
| `vq_uncomplete_task(path, line_number)`         | Mark a task as todo (`[ ]`)                             |
| `vq_set_task_status(path, line_number, status)` | Set task status (DONE, TODO, IN_PROGRESS, etc.)         |
| `vq_set_task_text(path, line_number, text)`     | Update task text (preserves checkbox status)            |
| `vq_add_task(path, text, after_line)`           | Add a new task after specified line (0 = start of file) |
| `vq_delete_task(path, line_number)`             | Delete a task at the specified line                     |

Task status changes preserve existing text and metadata, including completion dates. Supported statuses are `TODO`, `IN_PROGRESS`, `DONE`, and `CANCELLED`.

### Heading functions

| Function                                         | Description                            |
| ------------------------------------------------ | -------------------------------------- |
| `vq_set_heading_text(path, line_number, text)`   | Update heading text (preserves level)  |
| `vq_set_heading_level(path, line_number, level)` | Change heading level (1-6)             |
| `vq_add_heading(path, level, text, after_line)`  | Add a new heading after specified line |
| `vq_delete_heading(path, line_number)`           | Delete a heading at the specified line |

### List item functions

| Function                                         | Description                              |
| ------------------------------------------------ | ---------------------------------------- |
| `vq_set_list_item_text(path, line_number, text)` | Update list item text (preserves marker) |
| `vq_add_list_item(path, text, after_line)`       | Add a new list item after specified line |
| `vq_delete_list_item(path, line_number)`         | Delete a list item at the specified line |

### Table functions

| Function                                                              | Description                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `vq_add_table_row(path, table_index, values_json)`                    | Add a row to a Markdown table. `values_json` is a JSON object mapping column names to values, e.g., `'{"Name": "John", "Age": "30"}'` |
| `vq_set_table_cell(path, table_index, row_index, column_name, value)` | Update a specific cell in a table. `row_index` is 0-based from data rows (excludes header/separator).                                 |
| `vq_delete_table_row(path, table_index, row_index)`                   | Delete a row from a table. `row_index` is 0-based from data rows.                                                                     |

### Note functions

| Function                        | Description                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `vq_create_note(path, content)` | Create a new note at the specified path. Does nothing if the file already exists. Creates parent folders if needed. |

## Direct SQL

Direct SQL updates to these columns are written back to files:

| Table         | Writable columns        |
| ------------- | ----------------------- |
| `properties`  | `value`                 |
| `tasks`       | `status`, `task_text`   |
| `headings`    | `level`, `heading_text` |
| `list_items`  | `content`               |
| `table_cells` | `cell_value`            |

For note bodies, use `vq_set_content()` or `vq_replace_content()`; direct `notes.content` updates are blocked. Other table changes are database-only and are replaced on reindex.

# Registered triggers

{{dynamic:triggers}}
