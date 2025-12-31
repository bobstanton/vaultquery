---
id: examples-views
title: Custom View Examples
---

# Custom View Examples

## Recent activity

### Recently modified notes

~~~vaultquery-view
CREATE VIEW recent_notes AS
SELECT
  path,
  title,
  datetime(modified/1000, 'unixepoch', 'localtime') as modified_at,
  size
FROM notes
ORDER BY modified DESC
LIMIT 50
~~~

~~~vaultquery
SELECT * FROM recent_notes WHERE title LIKE '%project%'
~~~

### Recently created notes

~~~vaultquery-view
CREATE VIEW new_notes AS
SELECT
  path,
  title,
  datetime(created/1000, 'unixepoch', 'localtime') as created_at
FROM notes
WHERE created > (strftime('%s', 'now', '-7 days') * 1000)
ORDER BY created DESC
~~~

## Task management

### Open tasks with context

~~~vaultquery-view
CREATE VIEW open_tasks AS
SELECT
  t.path,
  t.task_text,
  t.priority,
  t.due_date,
  t.tags,
  t.section_heading,
  CASE
    WHEN t.due_date < date('now') THEN 'overdue'
    WHEN t.due_date = date('now') THEN 'today'
    WHEN t.due_date <= date('now', '+7 days') THEN 'this_week'
    ELSE 'later'
  END as urgency
FROM tasks t
WHERE t.status = 'TODO'
~~~

~~~vaultquery
SELECT * FROM open_tasks
WHERE urgency IN ('overdue', 'today')
ORDER BY due_date
~~~

### Tasks by project

~~~vaultquery-view
CREATE VIEW project_tasks AS
SELECT
  path_parent(t.path) as project,
  t.status,
  COUNT(*) as task_count
FROM tasks t
GROUP BY path_parent(t.path), t.status
~~~

~~~vaultquery
SELECT
  project,
  SUM(CASE WHEN status = 'DONE' THEN task_count ELSE 0 END) as done,
  SUM(CASE WHEN status = 'TODO' THEN task_count ELSE 0 END) as todo
FROM project_tasks
GROUP BY project
ORDER BY todo DESC
~~~

### Overdue tasks

~~~vaultquery-view
CREATE VIEW overdue_tasks AS
SELECT
  path,
  task_text,
  due_date,
  julianday('now') - julianday(due_date) as days_overdue
FROM tasks
WHERE status = 'TODO'
  AND due_date IS NOT NULL
  AND due_date < date('now')
ORDER BY due_date
~~~

## Note organization

### Orphan notes (no incoming links)

~~~vaultquery-view
CREATE VIEW orphan_notes AS
SELECT n.path, n.title, n.modified
FROM notes n
LEFT JOIN links l ON n.path = l.link_target
WHERE l.link_target IS NULL
  AND n.path NOT LIKE '%/_templates/%'
  AND n.path NOT LIKE '%.excalidraw.md'
ORDER BY n.modified DESC
~~~

### Notes by folder

~~~vaultquery-view
CREATE VIEW folder_stats AS
SELECT
  path_parent(path) as folder,
  COUNT(*) as note_count,
  SUM(size) as total_size,
  MAX(modified) as last_modified
FROM notes
GROUP BY path_parent(path)
ORDER BY note_count DESC
~~~

### Large notes

~~~vaultquery-view
CREATE VIEW large_notes AS
SELECT
  path,
  title,
  size,
  round(size / 1024.0, 1) as size_kb
FROM notes
WHERE size > 10000
ORDER BY size DESC
~~~

## Tag analysis

### Tag usage statistics

~~~vaultquery-view
CREATE VIEW tag_stats AS
SELECT
  tag_name,
  COUNT(*) as usage_count,
  COUNT(DISTINCT path) as note_count
FROM tags
GROUP BY tag_name
ORDER BY usage_count DESC
~~~

~~~vaultquery
SELECT * FROM tag_stats WHERE usage_count > 5
~~~

### Notes with multiple tags

~~~vaultquery-view
CREATE VIEW multi_tag_notes AS
SELECT
  path,
  COUNT(*) as tag_count,
  GROUP_CONCAT(tag_name, ', ') as all_tags
FROM tags
GROUP BY path
HAVING COUNT(*) > 3
ORDER BY tag_count DESC
~~~

## Link analysis

### Most linked notes

~~~vaultquery-view
CREATE VIEW popular_notes AS
SELECT
  link_target as path,
  COUNT(*) as incoming_links
FROM links
WHERE link_type = 'internal'
GROUP BY link_target
ORDER BY incoming_links DESC
~~~

### Broken links

Using `resolve_link()` to find links that don't resolve to any file:

~~~vaultquery-view
CREATE VIEW broken_links AS
SELECT
  l.path as source,
  l.link_text as target
FROM links l
WHERE l.link_type = 'internal'
  AND resolve_link(l.link_text, l.path) IS NULL
~~~

### Link graph edges

~~~vaultquery-view
CREATE VIEW link_graph AS
SELECT DISTINCT
  l.path as source,
  l.link_target as target
FROM links l
JOIN notes n ON l.link_target = n.path
WHERE l.link_type = 'internal'
~~~

## Content analysis

### Heading structure

~~~vaultquery-view
CREATE VIEW heading_outline AS
SELECT
  path,
  level,
  heading_text,
  line_number,
  SUBSTR('      ', 1, (level - 1) * 2) || heading_text as indented
FROM headings
ORDER BY path, line_number
~~~

~~~vaultquery
SELECT indented FROM heading_outline WHERE path = '{this.path}'
~~~

### Notes with properties

~~~vaultquery-view
CREATE VIEW notes_by_status AS
SELECT
  n.path,
  n.title,
  p.value as status
FROM notes n
JOIN properties p ON n.path = p.path
WHERE p.key = 'status'
ORDER BY p.value, n.title
~~~

### Property value counts

~~~vaultquery-view
CREATE VIEW property_stats AS
SELECT
  key,
  value,
  COUNT(*) as count
FROM properties
WHERE key IN ('status', 'type', 'category', 'priority')
GROUP BY key, value
ORDER BY key, count DESC
~~~

## Daily notes

### Daily notes summary

~~~vaultquery-view
CREATE VIEW daily_notes AS
SELECT
  path,
  title,
  SUBSTR(path_basename(path), 1, 10) as date,
  size,
  (SELECT COUNT(*) FROM tasks t WHERE t.path = n.path) as task_count
FROM notes n
WHERE path LIKE 'Daily/%'
  OR path LIKE 'Journal/%'
ORDER BY date DESC
~~~

### Weekly summary

~~~vaultquery-view
CREATE VIEW weekly_summary AS
SELECT
  strftime('%Y-W%W', SUBSTR(path_basename(path), 1, 10)) as week,
  COUNT(*) as entries,
  SUM(size) as total_size
FROM notes
WHERE path LIKE 'Daily/%'
GROUP BY week
ORDER BY week DESC
~~~

## Combining views

Views can reference other views:

~~~vaultquery-view
CREATE VIEW high_priority_overdue AS
SELECT *
FROM overdue_tasks
WHERE task_text LIKE '%#urgent%'
   OR task_text LIKE '%!high%'
ORDER BY days_overdue DESC
~~~
