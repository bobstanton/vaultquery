---
status: active
category: triggers
---

> [!important] Enable triggers
> Triggers are disabled by default. Required settings:
> - **Enable write operations** (required for triggers)
> - **Enable triggers**

Triggers run SQLite trigger logic and queue file edits after indexing.

## Execution Model

1. `vaultquery-trigger` registers a SQLite trigger.
2. Indexing updates tables such as `tasks`, `properties`, and `headings`.
3. Matching trigger conditions call `vq_*` functions.
4. Queued file edits apply after indexing completes.

> [!note] Timing
> Triggers fire after initial vault indexing completes. File edits created by triggers do not recursively fire more triggers.

---

## Available Functions

### General Functions

| Function | Description |
|----------|-------------|
| `vq_set_property(path, key, value)` | Set a frontmatter property |
| `vq_remove_property(path, key)` | Remove a frontmatter property |
| `vq_rename_note(path, new_name)` | Rename a note (keeps same folder) |
| `vq_create_note(path, content)` | Create a new note |
| `vq_set_content(path, content)` | Replace entire file content |
| `vq_replace_content(path, search, replacement)` | Replace text in file |
| `vq_notify(message)` | Show an Obsidian notification |
| `vq_log(message)` | Log to developer console |
| `vq_debounce(key, ms)` | Rate-limit trigger execution (leading edge) |
| `vq_defer(key, ms)` | Wait for idle time before executing (trailing edge) |

### Task Functions

| Function | Description |
|----------|-------------|
| `vq_complete_task(path, line_number)` | Mark a task as done |
| `vq_uncomplete_task(path, line_number)` | Mark a task as todo |
| `vq_set_task_status(path, line_number, status)` | Set task status |
| `vq_set_task_text(path, line_number, text)` | Update task text |
| `vq_add_task(path, text, after_line)` | Add a new task |
| `vq_delete_task(path, line_number)` | Delete a task |

### Heading Functions

| Function | Description |
|----------|-------------|
| `vq_set_heading_text(path, line_number, text)` | Update heading text |
| `vq_set_heading_level(path, line_number, level)` | Change heading level |
| `vq_add_heading(path, level, text, after_line)` | Add a new heading |
| `vq_delete_heading(path, line_number)` | Delete a heading |

### List Item Functions

| Function | Description |
|----------|-------------|
| `vq_set_list_item_text(path, line_number, text)` | Update list item text |
| `vq_add_list_item(path, text, after_line)` | Add a new list item |
| `vq_delete_list_item(path, line_number)` | Delete a list item |

### Table Functions

| Function | Description |
|----------|-------------|
| `vq_add_table_row(path, table_index, values_json)` | Add a row to a table |
| `vq_set_table_cell(path, table_index, row_index, column, value)` | Update a table cell |
| `vq_delete_table_row(path, table_index, row_index)` | Delete a table row |

---

## Task Completion Notification

**Test:** Complete this task.

- [ ] Complete the quarterly sales goal

```vaultquery-trigger
CREATE TRIGGER sales_goal_notify
AFTER UPDATE ON tasks
WHEN OLD.status != 'DONE' AND NEW.status = 'DONE'
  AND NEW.task_text LIKE '%sales goal%'
BEGIN
  SELECT vq_notify('Sales goal achieved! Time to ring the bell!');
END;
```

---

## Archive Completed Tasks

Completed tasks receive an archived date in the task text.

**Test:** Complete this task.

- [ ] Review Q4 budget proposal

```vaultquery-trigger
CREATE TRIGGER archive_completed_task
AFTER UPDATE ON tasks
WHEN OLD.status != 'DONE' AND NEW.status = 'DONE'
  AND NEW.path = '{this.path}'
  AND NEW.task_text NOT LIKE '%archived:%'
BEGIN
  SELECT vq_set_task_text(
    NEW.path,
    NEW.line_number,
    NEW.task_text || ' (archived: ' || date('now') || ')'
  );
END;
```

---

## Project Status from Tag

New `#project` tags create a default status property.

```vaultquery-trigger
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
```

> [!tip] Tag matching
> Position-based change detection avoids firing tag triggers when only nearby line numbers shift.

---

## Property Change Notification

Priority property changes trigger a notification.

```vaultquery-trigger
CREATE TRIGGER sync_priority_to_tasks
AFTER UPDATE ON properties
WHEN NEW.key = 'priority'
  AND OLD.value != NEW.value
BEGIN
  SELECT vq_notify('Priority changed to ' || NEW.value || ' for ' || NEW.path);
END;
```

---

## Rename Untitled Daily Notes

Untitled notes in `Daily Notes/` are renamed to the current date.

```vaultquery-trigger
CREATE TRIGGER auto_rename_daily
AFTER INSERT ON notes
WHEN NEW.path LIKE 'Daily Notes/%'
  AND NEW.title = 'Untitled'
BEGIN
  SELECT vq_rename_note(
    NEW.path,
    strftime('%Y-%m-%d', 'now')
  );
END;
```

---

## Replace Date Placeholders

Replace `{{today}}` with today's date in existing notes:

```vaultquery-trigger
CREATE TRIGGER replace_today_placeholder
AFTER UPDATE ON notes
WHEN OLD.content != NEW.content
  AND NEW.content LIKE '%{{today}}%'
  AND NEW.path != '{this.path}'
BEGIN
  SELECT vq_replace_content(
    NEW.path,
    '{{today}}',
    strftime('%Y-%m-%d', 'now')
  );
END;
```

> [!warning] Avoid Self-Modification
> `AND NEW.path != '{this.path}'` prevents the trigger from editing its own definition note.

---

## Backlink Logging

New internal links are logged for debugging.

```vaultquery-trigger
CREATE TRIGGER log_new_backlink
AFTER INSERT ON links
WHEN NEW.link_type = 'internal'
  AND vq_debounce('backlink:' || NEW.link_target, 500)
BEGIN
  SELECT vq_log('New link to ' || NEW.link_target || ' from ' || NEW.path);
END;
```

---

## Number New List Items

**Test:** Add a new item to this list.

- First item
- Second item
- Third item

```vaultquery-trigger
CREATE TRIGGER number_list_items
AFTER UPDATE ON list_items
WHEN NEW.path = '{this.path}'
  AND OLD.content = ''
  AND LENGTH(NEW.content) > 0
  AND NEW.content NOT GLOB '[0-9].*'
  AND vq_debounce('list:' || NEW.path || ':' || NEW.line_number, 500)
BEGIN
  SELECT vq_set_list_item_text(
    NEW.path,
    NEW.line_number,
    (SELECT COUNT(*) FROM list_items WHERE path = NEW.path AND list_index = NEW.list_index AND line_number <= NEW.line_number) || '. ' || NEW.content
  );
END;
```

---

## Meeting Notes from Headings

Headings starting with `Meeting:` create a linked meeting note.

**Test:** Add a heading like `## Meeting: Project Kickoff`.

```vaultquery-trigger
CREATE TRIGGER create_meeting_note
AFTER INSERT ON headings
WHEN NEW.heading_text LIKE 'Meeting:%'
  AND vq_debounce('meeting:' || NEW.path, 1000)
BEGIN
  SELECT vq_create_note(
    'Meetings/' || trim(substr(NEW.heading_text, 9)) || '.md',
    '---
date: ' || date('now') || '
attendees: []
---

# ' || trim(substr(NEW.heading_text, 9)) || '

## Agenda

-

## Notes

-

## Action Items

- [ ]
'
  );
  SELECT vq_notify('Meeting note created!');
END;
```

---

## WUPHF Multi-Channel Notification

> [!note] Additional settings required
> Required settings:
> - **Index tables** (under Features)
> - **Enable inline buttons** (under Write Operations)

The button queues a WUPHF message and broadcasts it to all channel tables.

The WUPHF tables use fixed `table_index` positions. Five documentation tables appear earlier in this file, so Message Queue is table 5 and channels are tables 6-12.

**Message Queue (table 5)**

| To | Message |
|----|---------|
| Michael Scott | Welcome to WUPHF! |

`vq[📤 Send WUPHF]{INSERT INTO table_rows (path, table_index, row_json) VALUES ('{this.path}', 5, '{"To": "Dwight Schrute", "Message": "WUPHF notification received!"}')}`

**Cell Phone (table 6)**

| To | Message | Sent |
|----|---------|------|

**Home Phone (table 7)**

| To | Message | Sent |
|----|---------|------|

**Fax (table 8)**

| To | Message | Sent |
|----|---------|------|

**Email (table 9)**

| To | Message | Sent |
|----|---------|------|

**Twitter (table 10)**

| To | Message | Sent |
|----|---------|------|

**AIM (table 11)**

| To | Message | Sent |
|----|---------|------|

**Pager (table 12)**

| To | Message | Sent |
|----|---------|------|

```vaultquery-trigger
CREATE TRIGGER wuphf_broadcast
AFTER INSERT ON table_cells
WHEN NEW.column_name = 'To'
  AND NEW.path = '{this.path}'
  AND NEW.table_index = 5
BEGIN
  SELECT vq_notify('Broadcasting WUPHF to ' || NEW.cell_value || '...');

  -- Broadcast to all 7 channels using INSERT INTO table_rows
  -- Trigger sync writes the table changes back to markdown
  INSERT INTO table_rows (path, table_index, row_json)
  WITH msg AS (
    SELECT COALESCE(
      (SELECT cell_value FROM table_cells
       WHERE path = NEW.path AND table_index = 5
       AND row_index = NEW.row_index AND column_name = 'Message'),
      'WUPHF!'
    ) AS message_text
  )
  SELECT
    NEW.path,
    channel.idx,
    json_object('To', NEW.cell_value, 'Message', msg.message_text, 'Sent', date('now'))
  FROM msg, (
    SELECT 6 AS idx UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9
    UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
  ) AS channel;
END;
```

> [!tip] Broadcast path
> Rows added to Message Queue trigger one INSERT...SELECT into channel tables 6-12. `table_rows` changes sync back to markdown.

---

## Table Cell Validation

Status cell updates are checked against known values.

### Project Status

| Project | Status |
|---------|--------|
| Website Redesign | active |
| Mobile App | planning |

```vaultquery-trigger
CREATE TRIGGER validate_project_status
AFTER UPDATE ON table_cells
WHEN NEW.column_name = 'Status'
  AND NEW.path = '{this.path}'
  AND OLD.cell_value != NEW.cell_value
  AND NEW.cell_value NOT IN ('planning', 'active', 'paused', 'completed')
BEGIN
  SELECT vq_notify('Warning: Unknown status "' || NEW.cell_value || '". Use: planning, active, paused, or completed');
END;
```

---

## Delete Empty Tasks

Tasks with empty text are deleted.

```vaultquery-trigger
CREATE TRIGGER delete_empty_task
AFTER UPDATE ON tasks
WHEN OLD.task_text != NEW.task_text
  AND (NEW.task_text = '' OR NEW.task_text IS NULL)
BEGIN
  SELECT vq_delete_task(NEW.path, NEW.line_number);
  SELECT vq_log('Deleted empty task at line ' || NEW.line_number);
END;
```

---

## Promote Important Headings

Headings containing `IMPORTANT` are promoted to H1.

```vaultquery-trigger
CREATE TRIGGER promote_important_heading
AFTER UPDATE ON headings
WHEN NEW.heading_text LIKE '%IMPORTANT%'
  AND (OLD.heading_text = '' OR OLD.heading_text NOT LIKE '%IMPORTANT%')
  AND NEW.level > 1
  AND vq_debounce('promote:' || NEW.path || ':' || NEW.line_number, 500)
BEGIN
  SELECT vq_set_heading_level(NEW.path, NEW.line_number, 1);
  SELECT vq_notify('Promoted important heading to H1');
END;
```

---

## Debouncing Triggers

Each edit can trigger reindexing. `vq_debounce(key, ms)` prevents rapid execution:

### Per-File Debounce

One execution per 500 ms per file:

```vaultquery-trigger
CREATE TRIGGER heading_logger
AFTER INSERT ON headings
WHEN NEW.path = '{this.path}'
  AND vq_debounce('heading:' || NEW.path, 500)
BEGIN
  SELECT vq_log('Heading added: ' || NEW.heading_text);
END;
```

### Global Debounce

One execution per 500 ms across all files:

```vaultquery-trigger
CREATE TRIGGER global_note_log
AFTER INSERT ON notes
WHEN NEW.path LIKE 'Daily Notes/%'
  AND vq_debounce('new_daily_note', 500)
BEGIN
  SELECT vq_log('New daily note created: ' || NEW.path);
END;
```

> [!tip] Debounce Timing
> - **300-500ms** - Most typing scenarios
> - **1000ms+** - For expensive operations
> - **Per-path debounce** - Usually preferred so editing one file doesn't block triggers in another

### Trailing-Edge Debounce with `vq_defer`

`vq_defer` waits for editing to stop before execution:

```vaultquery-trigger
CREATE TRIGGER format_heading_after_idle
AFTER INSERT ON headings
WHEN NEW.path = '{this.path}'
BEGIN
  -- Wait 2 seconds after last heading change, then execute
  SELECT vq_defer('heading:' || NEW.path, 2000);
  SELECT vq_log('Heading finalized: ' || NEW.heading_text);
  SELECT vq_set_property(NEW.path, 'last_heading', NEW.heading_text);
END;
```

**Behavior:**
- `vq_debounce` → Fires immediately, blocks repeats (use in WHEN clause)
- `vq_defer` → Waits for idle, then fires (use in BEGIN block)

---

## INSERT vs UPDATE Semantics

VaultQuery distinguishes between new and modified records:

- **AFTER INSERT** - Fires for genuinely new items
- **AFTER UPDATE** - Fires when existing data values change

> [!important] Best Practice for UPDATE Triggers
> `OLD.column != NEW.column` prevents execution when only metadata changes, such as shifted line numbers.

Change detection by table:
- **notes**: INSERT for new files, UPDATE for content changes
- **properties**: INSERT for new properties, UPDATE when values change
- **tags/headings**: Position-based matching - INSERT only for new occurrences
- **tasks/list_items**: Track by `block_id` or line-based fallback
- **table_cells**: Position-based matching within each table

---

## Direct SQL Triggers

Changes to these tables sync back to files:

| Table | Auto-Synced Columns |
|-------|---------------------|
| `properties` | `value` |
| `tasks` | `status`, `task_text` |
| `headings` | `level`, `heading_text` |
| `list_items` | `content` |

> [!note] Note content
> `notes.content` changes should use `vq_replace_content()` or `vq_set_content()` instead of direct UPDATE.

```vaultquery-trigger
CREATE TRIGGER replace_placeholder_sql
AFTER INSERT ON notes
WHEN NEW.content LIKE '%{{branch}}%'
  AND NEW.path != '{this.path}'
BEGIN
  SELECT vq_replace_content(NEW.path, '{{branch}}', 'Scranton');
END;
```

---

## Trigger References

| Reference | Available In | Description |
|-----------|--------------|-------------|
| `NEW.column` | INSERT, UPDATE | New value |
| `OLD.column` | UPDATE, DELETE | Previous value |
| `{this.path}` | All | Path of the note containing the trigger |

---

## Trigger Safety

1. `{this.path}` prevents self-modification.
2. `vq_log` verifies conditions before file-modifying actions.
3. Narrow `WHEN` clauses avoid unrelated notes.
4. Debouncing reduces repeated execution during typing.
5. Unique trigger names avoid last-loaded-wins conflicts.
6. Existing-value checks avoid redundant updates.
