---
status: active
category: visualization
---

## Chart Types

| Type     | Config Value     | Best For                          |
| -------- | ---------------- | --------------------------------- |
| Bar      | `type: bar`      | Comparisons                       |
| Pie      | `type: pie`      | Parts of a whole                  |
| Doughnut | `type: doughnut` | Parts of a whole (with center)    |
| Line     | `type: line`     | Trends over time                  |
| Scatter  | `type: scatter`  | Relationships between variables   |

Charts require columns named `label` and `value` (or `x` and `y` for scatter plots). Add a `series` column for multiple datasets.

## Config Options

| Option         | Description                                             |
| -------------- | ------------------------------------------------------- |
| `type`         | Chart type: bar, line, pie, doughnut, or scatter (required) |
| `title`        | Chart title displayed above the chart                   |
| `datasetLabel` | Legend label for the dataset                            |
| `xLabel`       | X-axis label (bar, line, scatter only)                  |
| `yLabel`       | Y-axis label (bar, line, scatter only)                  |

---

## Self-Contained Charts

> [!important] Enable tag indexing
> Tag queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index tags

### Tags bar chart

#sales #quarterly #scranton #clients #priority-high #regional

```vaultquery-chart
SELECT tag_name as label, COUNT(*) as value
FROM tags
WHERE path = '{this.path}'
GROUP BY tag_name
ORDER BY value DESC;
config:
type: bar
datasetLabel: Tag count
```

> [!important] Enable task indexing
> Task queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index tasks

### Task status pie chart

- [ ] Finalize Q4 sales report #sales ⏫
- [ ] Call Blue Cross about renewal #sales 🔼
- [/] Update client database #sales
- [x] Send invoice to Lackawanna County #sales ✅ 2025-01-05
- [x] Order paper for Harper Collins deal #sales ✅ 2025-01-05
- [x] Schedule meeting with Jan #sales ✅ 2025-01-04
- [x] Review Dwight's commission structure #sales ✅ 2025-01-04
- [x] File expense reports #sales ✅ 2025-01-03
- [x] Close Dunmore High School deal #sales 🔼 ✅ 2025-12-14
- [x] Prepare Scranton presentation #sales ✅ 2025-01-03
- [x] Set up new client folders #sales ✅ 2025-01-02
- [x] Update CRM contacts #sales ✅ 2025-01-01

```vaultquery-chart
SELECT
  CASE WHEN status = 'DONE' THEN 'Completed' ELSE 'Incomplete' END as label,
  COUNT(*) as value
FROM tasks
WHERE path = '{this.path}'
GROUP BY (status = 'DONE');
config:
type: pie
```

### Priority doughnut chart

```vaultquery-chart
SELECT
  COALESCE(priority, 'No Priority') as label,
  COUNT(*) as value
FROM tasks
WHERE path = '{this.path}'
GROUP BY priority;
config:
type: doughnut
```

### How Michael spends his time

```vaultquery-chart
SELECT 'Procrastinating' as label, 54 as value
UNION ALL
SELECT 'Distracting others' as label, 45 as value
UNION ALL
SELECT 'Critical thinking' as label, 1 as value;
config:
type: pie
title: How Michael spends his time
```

---

## Multi-Series Charts

Add a `series` column to create multiple datasets (bars, lines, etc.) grouped by category.

### Tasks by status and priority

```vaultquery-chart
SELECT
  status as label,
  COALESCE(priority, 'none') as series,
  COUNT(*) as value
FROM tasks
WHERE path = '{this.path}'
GROUP BY status, priority;
config:
type: bar
title: Tasks by status and priority
```

---

## Vault-Wide Charts

### Task status distribution

```vaultquery-chart
SELECT status as label, COUNT(*) as value
FROM tasks
GROUP BY status
ORDER BY
  CASE status
    WHEN 'IN_PROGRESS' THEN 1
    WHEN 'TODO' THEN 2
    WHEN 'DONE' THEN 3
    WHEN 'CANCELLED' THEN 4
  END;
config:
type: bar
```

### Priority distribution (incomplete tasks)

```vaultquery-chart
SELECT
  COALESCE(priority, 'No Priority') as label,
  COUNT(*) as value
FROM tasks
WHERE status NOT IN ('DONE', 'CANCELLED')
GROUP BY priority
ORDER BY value DESC;
config:
type: doughnut
```

### Top 10 tags

```vaultquery-chart
SELECT tag_name as label, COUNT(*) as value
FROM tags
GROUP BY tag_name
ORDER BY value DESC
LIMIT 10;
config:
type: bar
```

### Notes by size category

```vaultquery-chart
SELECT
  CASE
    WHEN size < 1000 THEN 'Tiny (<1KB)'
    WHEN size < 5000 THEN 'Small (1-5KB)'
    WHEN size < 20000 THEN 'Medium (5-20KB)'
    ELSE 'Large (>20KB)'
  END as label,
  COUNT(*) as value
FROM notes
GROUP BY label;
config:
type: pie
```

### Tasks completed over time

Shows completion trend from tasks in this note 

```vaultquery-chart
SELECT done_date as label, COUNT(*) as value
FROM tasks
WHERE path = '{this.path}'
  AND status = 'DONE'
  AND done_date IS NOT NULL
GROUP BY done_date
ORDER BY done_date;
config:
type: line
xLabel: Date
yLabel: Tasks Completed
```

> [!important] Enable heading indexing
> Heading queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index headings

### Note size vs heading count

```vaultquery-chart
SELECT
  n.size / 1000.0 as x,
  COUNT(h.id) as y,
  n.title as label
FROM notes n
LEFT JOIN headings h ON n.path = h.path
GROUP BY n.path
HAVING COUNT(h.id) > 0
LIMIT 50;
config:
type: scatter
xLabel: Size (KB)
yLabel: Heading Count
```

