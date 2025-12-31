---
status: active
category: testing
---

Tests for SQL parsing: comments, string literals with special characters, CTEs, and multi-statement queries.


## Comments

### Trailing line comment

- [ ] Task for trailing comment test ^task-trailing-comment

```vaultquery-write
UPDATE tasks
SET status = 'DONE'
WHERE path = '{this.path}'
  AND block_id = 'task-trailing-comment'
-- This comment should not break the query
```

### Block comment at start

- [ ] Task for block comment test ^task-block-comment

```vaultquery-write
/* This is a block comment */
UPDATE tasks
SET status = 'DONE'
WHERE path = '{this.path}'
  AND block_id = 'task-block-comment'
```

### Multi-line block comment

- [ ] Task for multi-line comment test ^task-multiline-comment

```vaultquery-write
/*
   This is a multi-line block comment
   describing what this query does
*/
UPDATE tasks
SET priority = 'high'
WHERE path = '{this.path}'
  AND block_id = 'task-multiline-comment'
```

### CTE with comment inside

- [ ] Task for CTE comment test ⏫ ^task-cte-comment

```vaultquery-write
WITH target AS (
  -- This comment is inside the CTE
  SELECT path, line_number
  FROM tasks
  WHERE path = '{this.path}'
    AND block_id = 'task-cte-comment'
)
UPDATE tasks
SET status = 'IN_PROGRESS'
WHERE (path, line_number) IN (SELECT path, line_number FROM target)
```

---

## Special Characters in Strings

### Semicolon in string

- [ ] Task with semicolon; in the middle ^task-semicolon

```vaultquery-write
UPDATE tasks
SET task_text = 'Updated; with semicolon'
WHERE path = '{this.path}'
  AND block_id = 'task-semicolon'
```

### Dashes in string

- [ ] Task with -- dash dash in text ^task-dashes

```vaultquery-write
UPDATE tasks
SET task_text = 'Updated -- with dashes'
WHERE path = '{this.path}'
  AND block_id = 'task-dashes'
```

### Block comment syntax in string

- [ ] Task with /* block comment */ style text ^task-block-style

```vaultquery-write
UPDATE tasks
SET task_text = 'Updated /* block comment */ style'
WHERE path = '{this.path}'
  AND block_id = 'task-block-style'
```

---

## CTEs and Escaped Quotes

### Simple CTE

- [ ] Task for CTE test ^task-cte

```vaultquery-write
WITH target AS (
  SELECT path, line_number FROM tasks
  WHERE path = '{this.path}' AND block_id = 'task-cte'
)
UPDATE tasks
SET priority = 'high'
WHERE (path, line_number) IN (SELECT * FROM target)
```

### Escaped quotes

- [ ] Task for escaped quotes test ^task-escaped-quotes

```vaultquery-write
UPDATE tasks
SET task_text = 'Updated ''quoted'' text'
WHERE path = '{this.path}'
  AND block_id = 'task-escaped-quotes'
```

### Multiple CTEs

- [ ] Task for multiple CTEs test ^task-multiple-ctes

```vaultquery-write
WITH
  first_cte AS (
    SELECT path, line_number FROM tasks
    WHERE path = '{this.path}' AND block_id = 'task-multiple-ctes'
  ),
  second_cte AS (
    SELECT path, line_number FROM first_cte
  )
UPDATE tasks
SET status = 'IN_PROGRESS'
WHERE (path, line_number) IN (SELECT * FROM second_cte)
```

---

## RETURNING Keyword Confusion

The word "returning" in comments or strings should not be confused with the RETURNING clause.

### Comment contains returning

- [ ] Task about returning video tapes ^task-video-tapes

```vaultquery-write
UPDATE tasks
SET status = 'DONE'
WHERE path = '{this.path}'
  AND block_id = 'task-video-tapes'
-- returning results after this
```

### String contains returning

- [ ] Task for returning string test ^task-returning-string

```vaultquery-write
UPDATE tasks
SET task_text = 'Customer returning product'
WHERE path = '{this.path}'
  AND block_id = 'task-returning-string'
```

---

## Unicode and Special Characters

### Unicode characters

- [ ] áàãâä éèêë íìîï óòõôö úùûü ç ñ ^task-unicode

```vaultquery-write
UPDATE tasks
SET task_text = 'ÁÀÃÂÄ ÉÈÊË ÍÌÎÏ ÓÒÕÔÖ ÚÙÛÜ Ç Ñ'
WHERE path = '{this.path}'
  AND block_id = 'task-unicode'
```

### Emoji

- [ ] Task with emoji 🎉 inside ^task-emoji

```vaultquery-write
UPDATE tasks
SET task_text = 'Updated emoji 🎉🚀'
WHERE path = '{this.path}'
  AND block_id = 'task-emoji'
```

---

## Identifier Quote Styles

SQLite accepts backticks, double quotes, and brackets for identifiers.

### Backtick identifiers

- [ ] Task for backtick test ^task-backtick

```vaultquery-write
UPDATE `tasks`
SET `status` = 'DONE'
WHERE `path` = '{this.path}'
  AND `block_id` = 'task-backtick'
```

### Double-quoted identifiers

- [ ] Task for double-quote test ^task-double-quote

```vaultquery-write
UPDATE tasks
SET "status" = 'DONE'
WHERE "path" = '{this.path}'
  AND "block_id" = 'task-double-quote'
```

### Square bracket identifiers

- [ ] Task for bracket test ^task-bracket

```vaultquery-write
UPDATE [tasks]
SET [priority] = 'high'
WHERE [path] = '{this.path}'
  AND [block_id] = 'task-bracket'
```

---

## Multi-Statement Queries

### Two statements with comments

- [ ] Task for first multi-statement ^task-multi-1
- [ ] Task for second multi-statement ^task-multi-2

```vaultquery-write
-- First operation
UPDATE tasks
SET status = 'DONE'
WHERE path = '{this.path}'
  AND block_id = 'task-multi-1';

-- Second operation
UPDATE tasks
SET priority = 'low'
WHERE path = '{this.path}'
  AND block_id = 'task-multi-2'
```

### Comments between statements

- [ ] Task for comments-between-1 ^task-between-1
- [ ] Task for comments-between-2 ^task-between-2

```vaultquery-write
UPDATE tasks SET priority = 'high' WHERE path = '{this.path}' AND block_id = 'task-between-1';

-- This is just a comment, not a statement

/* Another comment block */

UPDATE tasks SET status = 'IN_PROGRESS' WHERE path = '{this.path}' AND block_id = 'task-between-2'
```

---

## Subqueries

### UPDATE with subquery in SET

- [ ] Task for subquery-set test ^task-subquery-set

```vaultquery-write
UPDATE tasks
SET priority = (
  SELECT CASE
    WHEN COUNT(*) > 5 THEN 'high'
    ELSE 'low'
  END
  FROM tasks
  WHERE path = '{this.path}'
)
WHERE path = '{this.path}'
  AND block_id = 'task-subquery-set'
```

### Deeply nested subqueries

- [ ] Task for nested-subquery test ^task-nested-subquery

```vaultquery-write
UPDATE tasks
SET priority = 'highest'
WHERE path = '{this.path}'
  AND block_id = 'task-nested-subquery'
```

---

## INSERT Edge Cases

Single INSERT with multiple VALUES testing various edge cases.

- [ ] Anchor task for inserts ^task-insert-anchor

```vaultquery-write
INSERT INTO tasks (path, task_text, status, line_number)
VALUES
  ('{this.path}', 'Inserted; with semicolon', 'TODO',
    (SELECT line_number + 1 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-insert-anchor')),
  ('{this.path}', 'Inserted -- with dashes', 'TODO',
    (SELECT line_number + 2 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-insert-anchor')),
  ('{this.path}', 'Inserted /* block */ comment', 'TODO',
    (SELECT line_number + 3 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-insert-anchor')),
  ('{this.path}', 'Inserted ''escaped'' quotes', 'TODO',
    (SELECT line_number + 4 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-insert-anchor')),
  ('{this.path}', 'Inserted with emoji 🎉', 'TODO',
    (SELECT line_number + 5 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-insert-anchor')),
  ('{this.path}', 'Inserted Señor café', 'TODO',
    (SELECT line_number + 6 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-insert-anchor')),
  ('{this.path}', 'Inserted returning keyword', 'TODO',
    (SELECT line_number + 7 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-insert-anchor'))
-- Trailing comment on INSERT
```

#testing #edge-cases
