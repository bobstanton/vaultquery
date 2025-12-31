---
status: active
category: tasks
---

> [!important] Enable task indexing
> Task queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index tasks

VaultQuery parses tasks using the Obsidian Tasks emoji format:

| Field              | Emoji | Example           |
| ------------------ | ----- | ----------------- |
| Priority (Highest) | `🔺`  | `🔺`              |
| Priority (High)    | `⏫`  | `⏫`              |
| Priority (Medium)  | `🔼`  | `🔼`              |
| Priority (Low)     | `🔽`  | `🔽`              |
| Priority (Lowest)  | `⏬`  | `⏬`              |
| Created Date       | `➕`  | `➕ YYYY-MM-DD`   |
| Scheduled Date     | `⏳`  | `⏳ YYYY-MM-DD`   |
| Start Date         | `🛫`  | `🛫 YYYY-MM-DD`   |
| Due Date           | `📅`  | `📅 YYYY-MM-DD`   |
| Done Date          | `✅`  | `✅ YYYY-MM-DD`   |
| Cancelled Date     | `❌`  | `❌ YYYY-MM-DD`   |
| Recurrence         | `🔁`  | `🔁 every week`   |
| Task ID            | `🆔`  | `🆔 task-123`     |
| Depends On         | `⛔`  | `⛔ task-456`     |

### Status Characters

| Status      | Character | Description   |
| ----------- | --------- | ------------- |
| TODO        | `[ ]`     | Not started   |
| DONE        | `[x]`     | Completed     |
| IN_PROGRESS | `[/]`     | In progress   |
| CANCELLED   | `[-]`     | Cancelled     |

---

## Querying Tasks

### List all tasks with status and priority

- [ ] Finalize Dundies award categories ⏫ 📅 2025-12-15
- [ ] Review quarterly sales report 🔼 📅 2025-12-20
- [ ] Submit expense reports 🔽 📅 2025-01-01
- [ ] Get Stanley cake before he dies 🔁 every week
- [ ] Plan office birthday party 🆔 task-main ⛔ task-blocker
- [ ] Pick up a peach cobbler 🆔 task-blocker
- [/] Organizing company picnic
- [x] Update emergency contact list ✅ 2025-12-01
- [-] Migrate to new copier system ❌ 2025-11-15

```vaultquery
SELECT task_text, status, priority
FROM tasks_view
WHERE path = '{this.path}'
ORDER BY status_order, priority_order
```


### Task summary statistics

```vaultquery
SELECT
  COUNT(*) as total,
  SUM(is_complete) as completed,
  SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) as in_progress,
  SUM(CASE WHEN NOT is_complete THEN 1 ELSE 0 END) as remaining,
  SUM(is_overdue) as overdue
FROM tasks_view
WHERE path = '{this.path}'
```

### Computed columns in tasks_view

The `tasks_view` includes computed columns:

| Column           | Type | Description                                          |
| ---------------- | ---- | ---------------------------------------------------- |
| `status_order`   | INT  | 1=IN_PROGRESS, 2=TODO, 3=DONE, 4=CANCELLED           |
| `priority_order` | INT  | 1=highest, 2=high, 3=medium, 4=low, 5=lowest, 6=none |
| `is_complete`    | INT  | 1 if DONE or CANCELLED, 0 otherwise                  |
| `is_overdue`     | INT  | 1 if incomplete and past due_date                    |
| `days_until_due` | INT  | Days until due (negative = overdue)                  |

```vaultquery
-- Find overdue tasks
SELECT task_text, due_date, days_until_due
FROM tasks_view
WHERE is_overdue = 1
ORDER BY days_until_due
```

```vaultquery
-- Tasks due this week
SELECT task_text, due_date, days_until_due
FROM tasks_view
WHERE is_complete = 0
  AND days_until_due BETWEEN 0 AND 7
ORDER BY days_until_due
```

### Query recurring tasks

```vaultquery
SELECT task_text, recurrence
FROM tasks
WHERE path = '{this.path}'
  AND recurrence IS NOT NULL
```

### Query task dependencies

Find tasks that depend on others, or are depended upon:

```vaultquery
SELECT t.task_text, t.task_id, t.depends_on
FROM tasks t
WHERE t.path = '{this.path}'
  AND (
    t.depends_on IS NOT NULL
    OR t.task_id IN (SELECT depends_on FROM tasks WHERE path = '{this.path}')
  )
```

### Query by block ID

Tasks can have block IDs for precise referencing. Add `^block-id` at the end of a task line.

- [ ] Order pizza from Pizza by Alfredo ^order-pizza

Update a specific task by block ID:

> [!important] Enable write operations
> Write operations are disabled by default. To enable go to Settings → VaultQuery → Write operations → Enable write operations

```vaultquery-write
UPDATE tasks
SET task_text = 'Order pizza from Alfredo''s Pizza Cafe'
WHERE path = '{this.path}'
  AND block_id = 'order-pizza'
```

Mark a specific task as DONE:

- [ ] Dispose the hot circle of garbage ^trash-pizza-by-alfredo

```vaultquery-write
UPDATE tasks
SET status = 'DONE', done_date = date('now')
WHERE path = '{this.path}'
  AND block_id = 'trash-pizza-by-alfredo'
```

### Add due and scheduled dates

- [ ] Schedule conference room for meeting ^task-conference

```vaultquery-write
UPDATE tasks
SET due_date = date('now', '+7 days'),
    scheduled_date = date('now', '+3 days')
WHERE path = '{this.path}'
  AND block_id = 'task-conference'
```

### Mark task in-progress

- [ ] Prepare client presentation for Dunder Mifflin Infinity ^task-infinity

```vaultquery-write
UPDATE tasks
SET status = 'IN_PROGRESS',
    start_date = date('now')
WHERE path = '{this.path}'
  AND block_id = 'task-infinity'
```

### Cancel a task

- [ ] Plan branch merger celebration ^task-celebration

```vaultquery-write
UPDATE tasks
SET status = 'CANCELLED',
    cancelled_date = date('now')
WHERE path = '{this.path}'
  AND block_id = 'task-celebration'
```

### Bulk update: complete all tasks in note

- [ ] Shred confidential documents ^task-shred
- [ ] Update client contact info ^task-contact
- [ ] Send thank you cards to clients ^task-cards

```vaultquery-write
UPDATE tasks
SET status = 'DONE', done_date = date('now')
WHERE path = '{this.path}'
  AND block_id IN ('task-shred', 'task-contact', 'task-cards')
  AND status != 'DONE'
```

---

## Creating Tasks

The `tasks_view` makes creating tasks simpler with sensible defaults:
- `status` defaults to `TODO`
- `created_date` defaults to today
- `line_number` defaults to end of file (or use explicit placement)

### Insert a new task (simple)

```vaultquery-write
INSERT INTO tasks_view (path, task_text, priority, due_date)
VALUES ('{this.path}', 'Call Hammermill about paper shortage', 'high', date('now', '+7 days'))
```

### Insert at specific location

- [ ] Anchor for task inserts ^task-anchor

```vaultquery-write
INSERT INTO tasks_view (path, task_text, priority, line_number)
VALUES (
  '{this.path}',
  'Task inserted after anchor',
  'medium',
  (SELECT line_number + 1 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-anchor')
)
```

### Insert multiple tasks

- [ ] Task list anchor ^task-list-anchor

```vaultquery-write
INSERT INTO tasks_view (path, task_text, priority, line_number)
VALUES
  ('{this.path}', 'Reserve parking spots for office Olympics', 'high',
    (SELECT line_number + 1 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-list-anchor')),
  ('{this.path}', 'Order new business cards for sales team', 'medium',
    (SELECT line_number + 2 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-list-anchor')),
  ('{this.path}', 'Complete workplace safety training', 'low',
    (SELECT line_number + 3 FROM tasks WHERE path = '{this.path}' AND block_id = 'task-list-anchor'))
```


Delete a specific task:
- [ ] Invest in Serenity by Jan ^task-candle-investment

```vaultquery-write
DELETE FROM tasks
WHERE path = '{this.path}'
  AND block_id = 'task-candle-investment'
```

### Delete all completed tasks

- [x] Open package from Sabre ^task-box
- [x] Put Gabe's equipment back in the box ^task-gabe

```vaultquery-write
DELETE FROM tasks
WHERE path = '{this.path}'
  AND status = 'DONE'
```

