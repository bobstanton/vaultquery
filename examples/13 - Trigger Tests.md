---
status: active
category: triggers
test_property: initial
---

> [!important] Enable triggers
> Triggers are disabled by default. Required settings:
> - **Enable write operations** (required for triggers)
> - **Enable triggers**

Trigger coverage for every indexed table. Each trigger shows a notification when it fires.

---

## Notes Table

```vaultquery-trigger
CREATE TRIGGER test_notes_insert
AFTER INSERT ON notes
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('NOTE INSERT: ' || NEW.path);
END;
```

```vaultquery-trigger
CREATE TRIGGER test_notes_update
AFTER UPDATE ON notes
WHEN OLD.content != NEW.content
  AND NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('NOTE UPDATE: ' || NEW.path || ' (content changed)');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_notes_delete
AFTER DELETE ON notes
WHEN OLD.path = '{this.path}'
BEGIN
  SELECT vq_notify('NOTE DELETE: ' || OLD.path);
END;
```

---

## Properties Table

```vaultquery-trigger
CREATE TRIGGER test_properties_insert
AFTER INSERT ON properties
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('PROPERTY INSERT: ' || NEW.key || ' = ' || NEW.value);
END;
```

```vaultquery-trigger
CREATE TRIGGER test_properties_update
AFTER UPDATE ON properties
WHEN OLD.value != NEW.value
  AND NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('PROPERTY UPDATE: ' || NEW.key || ' changed from "' || OLD.value || '" to "' || NEW.value || '"');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_properties_delete
AFTER DELETE ON properties
WHEN OLD.path = '{this.path}'
BEGIN
  SELECT vq_notify('PROPERTY DELETE: ' || OLD.key);
END;
```

**Test:** Change the `test_property` value in frontmatter above.

---

## Tags Table

```vaultquery-trigger
CREATE TRIGGER test_tags_insert
AFTER INSERT ON tags
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('TAG INSERT: ' || NEW.tag_name || ' at line ' || NEW.line_number);
END;
```

```vaultquery-trigger
CREATE TRIGGER test_tags_update
AFTER UPDATE ON tags
WHEN NEW.path = '{this.path}'
  AND OLD.tag_name != NEW.tag_name
BEGIN
  SELECT vq_notify('TAG UPDATE: ' || OLD.tag_name || ' -> ' || NEW.tag_name);
END;
```

```vaultquery-trigger
CREATE TRIGGER test_tags_delete
AFTER DELETE ON tags
WHEN OLD.path = '{this.path}'
BEGIN
  SELECT vq_notify('TAG DELETE: ' || OLD.tag_name);
END;
```

**Test:** Add a tag here:

---

## Headings Table

```vaultquery-trigger
CREATE TRIGGER test_headings_insert
AFTER INSERT ON headings
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('HEADING INSERT: "' || NEW.heading_text || '" (H' || NEW.level || ')');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_headings_update
AFTER UPDATE ON headings
WHEN NEW.path = '{this.path}'
  AND (OLD.heading_text != NEW.heading_text OR OLD.level != NEW.level)
BEGIN
  SELECT vq_notify('HEADING UPDATE: "' || NEW.heading_text || '" (H' || NEW.level || ')');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_headings_delete
AFTER DELETE ON headings
WHEN OLD.path = '{this.path}'
BEGIN
  SELECT vq_notify('HEADING DELETE: "' || OLD.heading_text || '"');
END;
```

**Test:** Add a new heading below this line:

---

## Links Table

```vaultquery-trigger
CREATE TRIGGER test_links_insert
AFTER INSERT ON links
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('LINK INSERT: [[' || NEW.link_target || ']] (' || NEW.link_type || ')');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_links_update
AFTER UPDATE ON links
WHEN NEW.path = '{this.path}'
  AND OLD.link_target != NEW.link_target
BEGIN
  SELECT vq_notify('LINK UPDATE: [[' || OLD.link_target || ']] -> [[' || NEW.link_target || ']]');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_links_delete
AFTER DELETE ON links
WHEN OLD.path = '{this.path}'
BEGIN
  SELECT vq_notify('LINK DELETE: [[' || OLD.link_target || ']]');
END;
```

**Test:** Add a link here:

---

## Tasks Table

```vaultquery-trigger
CREATE TRIGGER test_tasks_insert
AFTER INSERT ON tasks
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('TASK INSERT: "' || NEW.task_text || '" [' || NEW.status || ']');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_tasks_update_status
AFTER UPDATE ON tasks
WHEN NEW.path = '{this.path}'
  AND OLD.status != NEW.status
BEGIN
  SELECT vq_notify('TASK STATUS: "' || NEW.task_text || '" changed from ' || OLD.status || ' to ' || NEW.status);
END;
```

```vaultquery-trigger
CREATE TRIGGER test_tasks_update_text
AFTER UPDATE ON tasks
WHEN NEW.path = '{this.path}'
  AND OLD.task_text != NEW.task_text
BEGIN
  SELECT vq_notify('TASK TEXT: changed from "' || OLD.task_text || '" to "' || NEW.task_text || '"');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_tasks_delete
AFTER DELETE ON tasks
WHEN OLD.path = '{this.path}'
BEGIN
  SELECT vq_notify('TASK DELETE: "' || OLD.task_text || '"');
END;
```

**Test:** Add, modify, complete, or delete tasks:

- [ ] Test task 1
- [ ] Test task 2

---

## List Items Table

```vaultquery-trigger
CREATE TRIGGER test_list_items_insert
AFTER INSERT ON list_items
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('LIST ITEM INSERT: "' || NEW.content || '" at line ' || NEW.line_number);
END;
```

```vaultquery-trigger
CREATE TRIGGER test_list_items_update
AFTER UPDATE ON list_items
WHEN NEW.path = '{this.path}'
  AND OLD.content != NEW.content
BEGIN
  SELECT vq_notify('LIST ITEM UPDATE: "' || OLD.content || '" -> "' || NEW.content || '"');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_list_items_delete
AFTER DELETE ON list_items
WHEN OLD.path = '{this.path}'
BEGIN
  SELECT vq_notify('LIST ITEM DELETE: "' || OLD.content || '"');
END;
```

**Test:** Add, modify, or delete list items:

- First list item
- Second list item

---

## Table Cells Table

```vaultquery-trigger
CREATE TRIGGER test_table_cells_insert
AFTER INSERT ON table_cells
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('CELL INSERT: [' || NEW.row_index || ',' || NEW.column_name || '] = "' || NEW.cell_value || '"');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_table_cells_update
AFTER UPDATE ON table_cells
WHEN NEW.path = '{this.path}'
  AND OLD.cell_value != NEW.cell_value
BEGIN
  SELECT vq_notify('CELL UPDATE: [' || NEW.row_index || ',' || NEW.column_name || '] "' || OLD.cell_value || '" -> "' || NEW.cell_value || '"');
END;
```

```vaultquery-trigger
CREATE TRIGGER test_table_cells_delete
AFTER DELETE ON table_cells
WHEN OLD.path = '{this.path}'
BEGIN
  SELECT vq_notify('CELL DELETE: [' || OLD.row_index || ',' || OLD.column_name || '] was "' || OLD.cell_value || '"');
END;
```

**Test:** Modify cells in this table:

| Name | Value | Status |
|------|-------|--------|
| Item A | 100 | active |
| Item B | 200 | pending |

---

## Table Rows (View for Row-Level Operations)

`table_rows` supports row-level SQL operations. Triggers targeting `table_rows` are rewritten to a shadow table.

```vaultquery-trigger
CREATE TRIGGER test_table_rows_insert
AFTER INSERT ON table_rows
WHEN NEW.path = '{this.path}'
BEGIN
  SELECT vq_notify('TABLE ROW INSERT: table ' || NEW.table_index || ' with data ' || NEW.row_json);
END;
```

**Test:** Add a row with this button:

`vq[Add Test Row]{INSERT INTO table_rows (path, table_index, row_json) VALUES ('{this.path}', 0, '{"Name": "Item C", "Value": "300", "Status": "new"}')}`

---

## Combined Test Area

Mixed element area:

### Test Heading

- [ ] Task in combined area
- List item in combined area

| Col1 | Col2 |
|------|------|
| A | B |

Add a #test-tag here.

Link to [[another note]].

---

## Summary of Trigger Events

| Table | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|
| notes | New file created | Content changed | File deleted |
| properties | New property added | Property value changed | Property removed |
| tags | Tag added | Tag moved (rare) | Tag removed |
| headings | New heading added | Heading text/level changed | Heading removed |
| links | Link added | Link target changed | Link removed |
| tasks | Task added | Status or text changed | Task removed |
| list_items | List item added | Content changed | List item removed |
| table_cells | Cell added | Cell value changed | Cell removed |
| table_rows | Row inserted via SQL | N/A | N/A |

> [!tip] Debugging
> - `vq_log()` keeps debugging output in the console.
> - `vq_debounce()` limits rapid notifications while typing.
> - Developer console output includes detailed trigger execution logs.
