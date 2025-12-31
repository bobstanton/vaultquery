---
status: active
priority: 8
project: scranton-branch
rating: 5
published: true
due: 2099-12-31
manager: Michael Scott
department: Sales
branch: Scranton
tags:
  - sales
  - clients
  - quarterly
---

> [!important] Enable frontmatter indexing
> Frontmatter queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index frontmatter

# Working with Properties

Query and modify frontmatter properties from notes in the vault.

## The notes_with_properties View

VaultQuery automatically creates a `notes_with_properties` view that pivots all property keys into columns. This is the easiest way to query properties.

```vaultquery
SELECT path, title, status, priority, project, manager
FROM notes_with_properties
WHERE status IS NOT NULL
ORDER BY title
LIMIT 20
```

### Filter by property value

```vaultquery
SELECT path, title, status, branch
FROM notes_with_properties
WHERE status = 'active'
ORDER BY path
LIMIT 20
```

### Find notes by manager

```vaultquery
SELECT path, title, manager, department
FROM notes_with_properties
WHERE manager = 'Michael Scott'
LIMIT 20
```

### Current note's properties

```vaultquery
SELECT status, priority, project, rating, published, due
FROM notes_with_properties
WHERE path = '{this.path}'
```

## Numeric Properties

Values are stored as TEXT. Cast for numeric operations:

```vaultquery
SELECT path, title, CAST(priority AS INTEGER) as priority
FROM notes_with_properties
WHERE priority IS NOT NULL
  AND CAST(priority AS INTEGER) >= 5
ORDER BY CAST(priority AS INTEGER) DESC
LIMIT 20
```

### Aggregating numeric properties

```vaultquery
SELECT
  AVG(CAST(rating AS REAL)) as avg_rating,
  MIN(CAST(rating AS INTEGER)) as min_rating,
  MAX(CAST(rating AS INTEGER)) as max_rating
FROM notes_with_properties
WHERE rating IS NOT NULL
```

## Boolean Properties

Booleans are stored as `true` or `false` strings:

```vaultquery
SELECT path, title, published
FROM notes_with_properties
WHERE published = 'true'
LIMIT 20
```

## Date Properties

Date values are stored as ISO strings (YYYY-MM-DD). This note has `due: 2099-12-31`.

```vaultquery
-- Notes with future due dates
SELECT path, title, due
FROM notes_with_properties
WHERE due IS NOT NULL
  AND due >= date('now')
ORDER BY due
LIMIT 20
```

## Filter by Multiple Properties

```vaultquery
SELECT path, title, status, published, branch
FROM notes_with_properties
WHERE status = 'active'
  AND published = 'true'
LIMIT 20
```

## Notes with Same Project

Find other notes with the same project property value:

```vaultquery
SELECT path, title, project, status
FROM notes_with_properties
WHERE project = (
    SELECT project FROM notes_with_properties
    WHERE path = '{this.path}'
  )
  AND path != '{this.path}'
```

## Property Analytics

### Notes missing a property

```vaultquery
SELECT path, title
FROM notes_with_properties
WHERE status IS NULL
ORDER BY path
LIMIT 20
```

### Property completeness

```vaultquery
SELECT
  COUNT(*) as total_notes,
  COUNT(status) as has_status,
  COUNT(priority) as has_priority,
  COUNT(project) as has_project
FROM notes_with_properties
```

---

## Write Operations

> [!important] Enable write operations
> Write operations are disabled by default. To enable go to Settings → VaultQuery → Write operations → Enable write operations

### Update a property value

Change this note's status from `active` to `completed`:

```vaultquery-write
UPDATE notes_with_properties
SET status = 'completed'
WHERE path = '{this.path}'
```

### Update multiple properties at once

```vaultquery-write
UPDATE notes_with_properties
SET status = 'completed',
    priority = '10',
    published = 'false'
WHERE path = '{this.path}'
```

### Clear a property (set to NULL)

Remove the manager property from this note:

```vaultquery-write
UPDATE notes_with_properties
SET manager = NULL
WHERE path = '{this.path}'
```

### Insert a new note with properties

Create a new note with frontmatter properties:

```vaultquery-write
INSERT INTO notes_with_properties (path, title, content, status, priority, project)
VALUES (
  'Projects/New Task.md',
  'New Task',
  '# New Task\n\nTask description here.',
  'active',
  '5',
  'scranton-branch'
)
```

### Delete a note

Delete a note (and all its properties):

```vaultquery-write
DELETE FROM notes_with_properties
WHERE path = 'Projects/Old Task.md'
```

### Bulk update property values

Update all notes with a specific status:

```vaultquery-write
UPDATE notes_with_properties
SET status = 'archived'
WHERE status = 'completed'
  AND path LIKE 'Projects/%'
```

---

## The properties Table (Advanced)

Alternatively, the underlying `properties` table can be used directly.

### Properties Schema

| Column        | Description                                                     |
| ------------- | --------------------------------------------------------------- |
| `path`        | File path                                                       |
| `key`         | Property name                                                   |
| `value`       | Property value (stored as TEXT)                                 |
| `value_type`  | Original type: `string`, `number`, `boolean`, `date`, `array`   |
| `array_index` | Index for array items (NULL for scalar values)                  |

### All properties in vault

```vaultquery
SELECT key, COUNT(*) as usage_count
FROM properties
GROUP BY key
ORDER BY usage_count DESC
LIMIT 20
```

### Array Properties

Array properties have an `array_index` value (0-based). The `notes_with_properties` view only shows scalar properties, so use the `properties` table for arrays:

```vaultquery
-- All tags array values for current note
SELECT path, value as tag, array_index
FROM properties
WHERE path = '{this.path}'
  AND key = 'tags'
  AND array_index IS NOT NULL
ORDER BY array_index
```

```vaultquery
-- Notes with multiple array items
SELECT path, COUNT(*) as tag_count
FROM properties
WHERE key = 'tags'
  AND array_index IS NOT NULL
GROUP BY path
HAVING tag_count > 2
ORDER BY tag_count DESC
LIMIT 20
```

### Property value distribution

```vaultquery
SELECT value, COUNT(*) as count
FROM properties
WHERE key = 'status'
GROUP BY value
ORDER BY count DESC
```

### Manual pivot query

```vaultquery
SELECT n.path,
  MAX(CASE WHEN p.key = 'status' THEN p.value END) as status,
  MAX(CASE WHEN p.key = 'branch' THEN p.value END) as branch,
  MAX(CASE WHEN p.key = 'manager' THEN p.value END) as manager,
  MAX(CASE WHEN p.key = 'department' THEN p.value END) as department
FROM notes n
JOIN properties p ON n.path = p.path
GROUP BY n.path
HAVING status IS NOT NULL
ORDER BY n.path
LIMIT 20
```

### Write to properties table directly

For fine-grained control, write to the properties table:

```vaultquery-write
-- Insert a new property
INSERT INTO properties (path, key, value, value_type)
VALUES ('{this.path}', 'reviewed', 'true', 'boolean')
```

```vaultquery-write
-- Update a property
UPDATE properties
SET value = 'completed'
WHERE path = '{this.path}'
  AND key = 'status'
```

```vaultquery-write
-- Delete a property
DELETE FROM properties
WHERE path = '{this.path}'
  AND key = 'reviewed'
```
