---
status: active
category: views
---

Custom views are reusable SQL queries exposed as virtual tables.

## Creating Views

`vaultquery-view` defines a view:

```vaultquery-view
CREATE VIEW recent_memos AS
SELECT
  path,
  title,
  datetime(modified/1000, 'unixepoch', 'localtime') as modified_at,
  size
FROM notes
WHERE path LIKE 'Dunder Mifflin/%'
ORDER BY modified DESC
LIMIT 50
```

Views can be queried like tables:

```vaultquery
SELECT * FROM recent_memos LIMIT 10
```

---

## View Examples

### Open Tasks with Urgency

Scranton branch tasks by urgency:

```vaultquery-view
CREATE VIEW urgent_tasks AS
SELECT
  t.path,
  t.task_text,
  t.priority,
  t.due_date,
  t.section_heading,
  CASE
    WHEN t.due_date < date('now') THEN 'overdue'
    WHEN t.due_date = date('now') THEN 'today'
    WHEN t.due_date <= date('now', '+7 days') THEN 'this_week'
    ELSE 'later'
  END as urgency
FROM tasks t
WHERE t.status = 'TODO'
```

```vaultquery
SELECT task_text, urgency, due_date
FROM urgent_tasks
WHERE urgency IN ('overdue', 'today')
ORDER BY due_date
```

### Orphan Notes (No Incoming Links)

Notes without incoming links:

```vaultquery-view
CREATE VIEW orphan_notes AS
SELECT n.path, n.title, n.modified
FROM notes n
LEFT JOIN links l ON n.path = l.link_target_path
WHERE l.link_target_path IS NULL
  AND n.path NOT LIKE '%/Threat Level Midnight/%'
ORDER BY n.modified DESC
```

```vaultquery
SELECT title, path FROM orphan_notes LIMIT 10
```

### Tag Statistics

Tag usage across the Scranton branch:

```vaultquery-view
CREATE VIEW tag_stats AS
SELECT
  tag_name,
  COUNT(*) as usage_count,
  COUNT(DISTINCT path) as note_count
FROM tags
GROUP BY tag_name
ORDER BY usage_count DESC
```

```vaultquery
SELECT * FROM tag_stats WHERE usage_count > 1
```

### Notes by Department

Note counts and sizes by department folder:

```vaultquery-view
CREATE VIEW department_summary AS
SELECT
  path_parent(path) as department,
  COUNT(*) as note_count,
  SUM(size) as total_bytes,
  round(SUM(size) / 1024.0, 1) as total_kb,
  MAX(modified) as last_modified
FROM notes
WHERE path_parent(path) IN ('Sales', 'Accounting', 'HR', 'Warehouse', 'Reception')
GROUP BY path_parent(path)
ORDER BY note_count DESC
```

```vaultquery
SELECT department, note_count, total_kb
FROM department_summary
```

### Most Referenced Policies

Most linked Dunder Mifflin policy documents:

```vaultquery-view
CREATE VIEW popular_policies AS
SELECT
  link_target_path as path,
  COUNT(*) as incoming_links
FROM links
WHERE link_type = 'internal'
  AND link_target_path IS NOT NULL
  AND link_target_path LIKE '%Policy%'
GROUP BY link_target_path
ORDER BY incoming_links DESC
```

```vaultquery
SELECT path, incoming_links FROM popular_policies LIMIT 10
```

---

## Views Can Reference Other Views

Views can reference other views:

```vaultquery-view
CREATE VIEW critical_sales_tasks AS
SELECT *
FROM urgent_tasks
WHERE urgency = 'overdue'
  AND priority IN ('high', 'highest')
  AND path LIKE 'Sales/%'
ORDER BY due_date
```

```vaultquery
SELECT task_text, due_date, priority FROM critical_sales_tasks
```

---

## View Persistence

Views are stored in the database and persist across sessions. Modified SQL is recreated when the code block renders.

> [!tip] Views vs Queries
> Views fit reused queries such as quarterly sales reports. One-off queries fit regular `vaultquery` blocks.
