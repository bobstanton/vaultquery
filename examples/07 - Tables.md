---
status: active
category: tables
---

> [!important] Enable Table Indexing
> Table queries require **Settings → VaultQuery → Index Tables** to be enabled. Without this setting, the `table_cells` and `tables` tables will be empty.

### Verify table indexing is working

Run this query to check if tables in this file are indexed:

```vaultquery
SELECT table_index, table_name, block_id
FROM tables
WHERE path = '{this.path}'
```

If no results appear, ensure table indexing is enabled and re-index the vault.

## Table Schema

Tables are stored in related structures:

| Table/View    | Description                                   |
| ------------- | --------------------------------------------- |
| `table_cells` | Individual cell values with position metadata |
| `tables`      | Table-level metadata (block_id, offsets)      |
| `table_rows`  | View for row-based operations with JSON       |

### table_cells columns

| Column        | Description                            |
| ------------- | -------------------------------------- |
| `path`        | File path containing the table         |
| `table_index` | Which table in the file (0-based)      |
| `table_name`  | Optional name from preceding heading   |
| `row_index`   | Row number (0-based, excluding header) |
| `column_name` | Header text for this column            |
| `cell_value`  | The cell's content                     |
| `line_number` | Line number (for INSERT positioning)   |

### tables columns

| Column         | Description                                |
| -------------- | ------------------------------------------ |
| `path`         | File path containing the table             |
| `table_index`  | Which table in the file (0-based)          |
| `table_name`   | Optional name from preceding heading       |
| `block_id`     | Obsidian block reference (e.g., ^products) |
| `start_offset` | Character offset where table starts        |
| `end_offset`   | Character offset where table ends          |
| `line_number`  | Line number (for INSERT positioning)       |

### table_rows view columns

| Column              | Description                            |
| ------------------- | -------------------------------------- |
| `path`              | File path containing the table         |
| `table_index`       | Which table in the file (0-based)      |
| `row_index`         | Row number (0-based, excluding header) |
| `row_json`          | JSON object of column→value pairs      |
| `table_line_number` | Line number (for INSERT positioning)   |

## Querying Tables

### Discover available table views

Enable "Dynamic Table Views" in Settings → VaultQuery to query tables directly. View names are derived from the heading above each table, or from a block ID if specified.

List all dynamic table views with their headings:

```vaultquery
SELECT
  v.name as view_name,
  tc.path,
  tc.table_index,
  tc.table_name as heading
FROM sqlite_master v
JOIN table_cells tc ON tc.table_name = REPLACE(v.name, '_table', '')
  OR LOWER(REPLACE(REPLACE(tc.table_name, ' ', '_'), '-', '_')) || '_table' = v.name
WHERE v.type = 'view'
  AND v.name LIKE '%_table'
GROUP BY v.name, tc.path, tc.table_index
ORDER BY v.name
```

### Query by block ID

Add a block ID after a table to give it an explicit name:

| Product             | Price | Stock |
| ------------------- | ----- | ----- |
| Dunder Mifflin 20lb | 45    | 500   |
| Hammermill Premium  | 52    | 250   |
| Cardstock 110lb     | 89    | 100   |
^products

```vaultquery
SELECT * FROM products_table
```

The view name is `{block_id}_table`. If disabled, an error message stating: `no such table: products_table` will be returned.

### Query by heading

Without a block ID, the heading above the table becomes the view name:

### Team Members

| Name  | Department        |
| ----- | ----------------- |
| Creed | Quality Assurance |
| Oscar | Accounting        |
| Nate  | Warehouse         |

```vaultquery
SELECT * FROM team_members_table
```

The heading "Team Members" becomes `team_members_table` (lowercase, spaces to underscores).

### Query using raw table_cells

Without dynamic views, use `table_cells` with pivot aggregation. Use the `tables` table to find the table by block_id:

```vaultquery
SELECT
  MAX(CASE WHEN column_name = 'Product' THEN cell_value END) as Product,
  MAX(CASE WHEN column_name = 'Price' THEN cell_value END) as Price,
  MAX(CASE WHEN column_name = 'Stock' THEN cell_value END) as Stock
FROM table_cells tc
JOIN tables t ON tc.path = t.path AND tc.table_index = t.table_index
WHERE tc.path = '{this.path}'
  AND t.block_id = 'products'
GROUP BY tc.row_index
ORDER BY tc.row_index
```

### Filter by column value

```vaultquery
SELECT tc1.cell_value as Product, tc2.cell_value as Stock
FROM table_cells tc1
JOIN table_cells tc2 ON tc1.path = tc2.path
  AND tc1.table_index = tc2.table_index
  AND tc1.row_index = tc2.row_index
WHERE tc1.path = '{this.path}'
  AND tc1.column_name = 'Product'
  AND tc2.column_name = 'Stock'
  AND CAST(tc2.cell_value AS INTEGER) < 50
```

### Count tables in vault

```vaultquery
SELECT path, COUNT(DISTINCT table_index) as table_count
FROM table_cells
GROUP BY path
HAVING table_count > 0
ORDER BY table_count DESC
LIMIT 20
```

## Updating Tables

### Update a single cell

| Product           | Quantity | Status       |
| ----------------- | -------- | ------------ |
| Letter Size 24lb  | 50       | In Stock     |
| Legal Size 20lb   | 0        | Out of Stock |
^inventory

```vaultquery-write
UPDATE table_cells
SET cell_value = 'Restocked'
WHERE path = '{this.path}'
  AND table_index = (SELECT table_index FROM tables WHERE path = '{this.path}' AND block_id = 'inventory')
  AND row_index = 1
  AND column_name = 'Status'
```

### Update multiple cells in same row

| Task                      | Owner  | Status  |
| ------------------------- | ------ | ------- |
| Call Lackawanna County    | Pam    | Pending |
| Rundown of clients        | Jim    | Pending |
^tasks

```vaultquery-write
UPDATE table_cells
SET cell_value = 'Complete'
WHERE path = '{this.path}'
  AND table_index = (SELECT table_index FROM tables WHERE path = '{this.path}' AND block_id = 'tasks')
  AND row_index = 0
  AND column_name = 'Status';

UPDATE table_cells
SET cell_value = 'Dwight'
WHERE path = '{this.path}'
  AND table_index = (SELECT table_index FROM tables WHERE path = '{this.path}' AND block_id = 'tasks')
  AND row_index = 0
  AND column_name = 'Owner'
```

### Update cells by value match

| Product        | Category      | Price |
| -------------- | ------------- | ----- |
| Sticky Notes   | Office Supply | 4.50  |
| Binder Clips   | Office Supply | 3.75  |
| Manila Folders | Filing        | 8.50  |
^supplies

```vaultquery-write
UPDATE table_cells
SET cell_value = 'Desk Supply'
WHERE path = '{this.path}'
  AND table_index = (SELECT table_index FROM tables WHERE path = '{this.path}' AND block_id = 'supplies')
  AND column_name = 'Category'
  AND cell_value = 'Office Supply'
```

### Move a value between columns

Robert California's notebook:

| Winners  | Losers   |
| -------- | -------- |
| Dwight   | Pam      |
| Jim      | Erin     |
| Phyllis  | Ryan     |
| Oscar    | Kelly    |
| Kevin    | Old man  |
| Andy     | Meredith |
^the-list

```vaultquery-write
-- Make corrections based on observations
UPDATE table_cells
SET cell_value = ''
WHERE path = '{this.path}'
  AND table_index = (SELECT table_index FROM tables WHERE path = '{this.path}' AND block_id = 'the-list')
  AND column_name = 'Winners'
  AND cell_value = 'Andy';

INSERT INTO table_rows (path, table_index, row_json)
SELECT '{this.path}', table_index, '{"Winners": "", "Losers": "Andy"}'
FROM tables
WHERE path = '{this.path}' AND block_id = 'the-list'
```

### Insert a new table row

Use `SELECT` instead of `VALUES` to avoid NULL constraint errors when the table doesn't exist:

```vaultquery-write
INSERT INTO table_rows (path, table_index, row_json)
SELECT
  '{this.path}',
  table_index,
  '{"Product": "Highlighters", "Category": "Desk Supply", "Price": "5.25"}'
FROM tables
WHERE path = '{this.path}' AND block_id = 'supplies'
```

---

## Creating Tables at Specific Positions

By default, new tables are appended at the end of the file. Use `line_number` or `table_line_number` to insert tables at specific positions.

### Create table at specific line using table_rows

Use `table_line_number` to position a new table. The table will be inserted at that line, pushing existing content down:

```vaultquery-write
-- Create a new table after line 30
INSERT INTO table_rows (path, table_index, row_json, table_line_number) VALUES
('{this.path}', 99, json_object('Branch', 'Scranton', 'Manager', 'Michael Scott'), 30),
('{this.path}', 99, json_object('Branch', 'Stamford', 'Manager', 'Josh Porter'), 30),
('{this.path}', 99, json_object('Branch', 'Utica', 'Manager', 'Karen Filippelli'), 30);
```

> [!tip] Table index for new tables
> Use a high `table_index` (like 99) for new tables to avoid conflicts with existing tables. After re-indexing, tables are renumbered based on their position in the file.

### Create table at specific line using table_cells

Use `line_number` on the first cell to position the new table:

```vaultquery-write
-- Create a new table at line 35
INSERT INTO table_cells (path, table_index, row_index, column_name, cell_value, line_number) VALUES
('{this.path}', 98, 0, 'Product', 'Dunder Mifflin Infinity', 35),
('{this.path}', 98, 0, 'Status', 'Discontinued', NULL),
('{this.path}', 98, 1, 'Product', 'Sabre Pyramid', NULL),
('{this.path}', 98, 1, 'Status', 'Recalled', NULL);
```

> [!note] Only the first cell needs line_number
> The `line_number` only needs to be set on one cell (typically the first). All cells with the same `path` and `table_index` will be grouped into a single table at that position.

### Insert table under a specific heading

Find the heading's line number and insert the table after it:

```vaultquery-write
-- Insert table 2 lines after the "Team Members" heading
INSERT INTO table_rows (path, table_index, row_json, table_line_number)
SELECT
  '{this.path}',
  97,
  json_object('Name', 'Toby Flenderson', 'Department', 'Human Resources'),
  line_number + 2
FROM headings
WHERE path = '{this.path}'
  AND heading_text = 'Team Members'
LIMIT 1;
```

### Positioning priority

When creating tables, the system checks for position hints in this order:
1. `table_line_number` on `table_rows` INSERT
2. `line_number` on the first `table_cells` INSERT for that table
3. If neither specified, appends to end of file

---

## Transposing Tables (Rows to Columns)

### Source table for transpose examples

Scranton branch quarterly metrics:

| Metric         | Value |
| -------------- | ----- |
| Paper Sales    | 50000 |
| Office Supplies| 12000 |
| Complaints     | 3     |
| Dundies Won    | 7     |
^metrics

### Query as transposed (pivot to columns)

Convert the vertical metric/value pairs into a single row with columns:

```vaultquery
SELECT
  MAX(CASE WHEN column_name = 'Metric' AND cell_value = 'Paper Sales' THEN
    (SELECT cell_value FROM table_cells tc2
     WHERE tc2.path = tc.path AND tc2.table_index = tc.table_index
     AND tc2.row_index = tc.row_index AND tc2.column_name = 'Value')
  END) as Paper_Sales,
  MAX(CASE WHEN column_name = 'Metric' AND cell_value = 'Office Supplies' THEN
    (SELECT cell_value FROM table_cells tc2
     WHERE tc2.path = tc.path AND tc2.table_index = tc.table_index
     AND tc2.row_index = tc.row_index AND tc2.column_name = 'Value')
  END) as Office_Supplies,
  MAX(CASE WHEN column_name = 'Metric' AND cell_value = 'Complaints' THEN
    (SELECT cell_value FROM table_cells tc2
     WHERE tc2.path = tc.path AND tc2.table_index = tc.table_index
     AND tc2.row_index = tc.row_index AND tc2.column_name = 'Value')
  END) as Complaints,
  MAX(CASE WHEN column_name = 'Metric' AND cell_value = 'Dundies Won' THEN
    (SELECT cell_value FROM table_cells tc2
     WHERE tc2.path = tc.path AND tc2.table_index = tc.table_index
     AND tc2.row_index = tc.row_index AND tc2.column_name = 'Value')
  END) as Dundies_Won
FROM table_cells tc
JOIN tables t ON tc.path = t.path AND tc.table_index = t.table_index
WHERE t.path = '{this.path}' AND t.block_id = 'metrics'
```

### Simpler transpose using self-joins

Join each metric row to get values as columns:

```vaultquery
SELECT
  ps.cell_value as Paper_Sales,
  os.cell_value as Office_Supplies,
  c.cell_value as Complaints,
  d.cell_value as Dundies_Won
FROM table_cells ps
JOIN table_cells os ON ps.path = os.path AND ps.table_index = os.table_index
JOIN table_cells c ON ps.path = c.path AND ps.table_index = c.table_index
JOIN table_cells d ON ps.path = d.path AND ps.table_index = d.table_index
JOIN tables t ON ps.path = t.path AND ps.table_index = t.table_index
WHERE t.block_id = 'metrics'
  AND ps.column_name = 'Value' AND (SELECT cell_value FROM table_cells WHERE path = ps.path AND table_index = ps.table_index AND row_index = ps.row_index AND column_name = 'Metric') = 'Paper Sales'
  AND os.column_name = 'Value' AND (SELECT cell_value FROM table_cells WHERE path = os.path AND table_index = os.table_index AND row_index = os.row_index AND column_name = 'Metric') = 'Office Supplies'
  AND c.column_name = 'Value' AND (SELECT cell_value FROM table_cells WHERE path = c.path AND table_index = c.table_index AND row_index = c.row_index AND column_name = 'Metric') = 'Complaints'
  AND d.column_name = 'Value' AND (SELECT cell_value FROM table_cells WHERE path = d.path AND table_index = d.table_index AND row_index = d.row_index AND column_name = 'Metric') = 'Dundies Won'
```

### Insert transposed data as new note

Create a new note with the Scranton metrics transposed (rows become columns). The query dynamically reads from the `^metrics` table and builds the markdown content:

```vaultquery-write
INSERT INTO notes (path, content)
SELECT path, content FROM (
  SELECT
    '{this.folder}scranton-metrics-transposed.md' as path,
    '# Scranton Branch Summary

| Paper Sales | Office Supplies | Complaints | Dundies Won |
| ----------- | --------------- | ---------- | ----------- |
| ' || COALESCE(MAX(CASE WHEN metric = 'Paper Sales' THEN value END), '') ||
    ' | ' || COALESCE(MAX(CASE WHEN metric = 'Office Supplies' THEN value END), '') ||
    ' | ' || COALESCE(MAX(CASE WHEN metric = 'Complaints' THEN value END), '') ||
    ' | ' || COALESCE(MAX(CASE WHEN metric = 'Dundies Won' THEN value END), '') || ' |
' as content,
    COUNT(*) as row_count
  FROM (
    SELECT m.cell_value as metric, v.cell_value as value
    FROM table_cells m
    JOIN table_cells v ON m.path = v.path AND m.table_index = v.table_index AND m.row_index = v.row_index
    JOIN tables t ON m.path = t.path AND m.table_index = t.table_index
    WHERE t.path = '{this.path}' AND t.block_id = 'metrics'
      AND m.column_name = 'Metric' AND v.column_name = 'Value'
  )
)
WHERE row_count > 0
```

> [!note] If the preview shows "0 rows will be inserted"
> This means the source table wasn't found. Run this to verify it's indexed:
> ```sql
> SELECT table_index, block_id FROM tables WHERE path = '{this.path}' AND block_id = 'metrics'
> ```

---

## Vault-Wide Table Queries

### Find tables with specific column

```vaultquery
SELECT DISTINCT path, table_index
FROM table_cells
WHERE column_name = 'Status'
LIMIT 20
```

### Search table contents

```vaultquery
SELECT path, table_index, row_index, column_name, cell_value
FROM table_cells
WHERE cell_value LIKE '%review%'
LIMIT 20
```

### Table statistics

```vaultquery
SELECT
  COUNT(DISTINCT path || '-' || table_index) as total_tables,
  COUNT(*) as total_cells,
  COUNT(DISTINCT column_name) as unique_columns
FROM table_cells
```

---

## Inline Buttons

> [!important] Enable Inline Buttons
> Inline buttons require **Settings → VaultQuery → Enable write operations** AND **Enable inline buttons** to be enabled.

Inline buttons let you execute SQL with a single click, without showing a preview modal. Use the syntax:

```
`vq[Button Label]{SQL QUERY}`
```

In Live Preview mode, this renders as a clickable button. Template variables like `{this.path}` work inside the SQL.

### Quick add row to table

Add a row to the supplies table with today's date:

| Date | Item | Quantity |
| ---- | ---- | -------- |
| 2024-01-15 | Paper clips | 100 |
| 2024-01-16 | Staples | 50 |
^daily-supplies

Click to add: `vq[+ Paper]{INSERT INTO table_rows (path, table_index, row_json) SELECT '{this.path}', table_index, json_object('Date', date('now'), 'Item', 'Copy Paper', 'Quantity', '1') FROM tables WHERE path = '{this.path}' AND block_id = 'daily-supplies'}` `vq[+ Pens]{INSERT INTO table_rows (path, table_index, row_json) SELECT '{this.path}', table_index, json_object('Date', date('now'), 'Item', 'Ballpoint Pens', 'Quantity', '12') FROM tables WHERE path = '{this.path}' AND block_id = 'daily-supplies'}` `vq[+ Folders]{INSERT INTO table_rows (path, table_index, row_json) SELECT '{this.path}', table_index, json_object('Date', date('now'), 'Item', 'Manila Folders', 'Quantity', '25') FROM tables WHERE path = '{this.path}' AND block_id = 'daily-supplies'}`

### Daily log entry (insert at top)

Perfect for daily journals where newest entries should appear first. Use `row_index = 0` to insert at the top:

| Date | Notes |
| ---- | ----- |
| 2024-01-15 | Closed Lackawanna deal |
^work-log

`vq[+ Today's Entry]{INSERT INTO table_rows (path, table_index, row_index, row_json) SELECT '{this.path}', table_index, 0, json_object('Date', date('now'), 'Notes', '') FROM tables WHERE path = '{this.path}' AND block_id = 'work-log'}`

### Insert in the middle

Use a subquery to compute the middle index dynamically:

| Priority | Task |
| -------- | ---- |
| 1 | First task |
| 2 | Second task |
| 3 | Third task |
| 4 | Fourth task |
^priority-list

`vq[+ Insert Middle]{INSERT INTO table_rows (path, table_index, row_index, row_json) SELECT '{this.path}', t.table_index, (SELECT (MAX(row_index) + 1) / 2 FROM table_cells WHERE path = '{this.path}' AND table_index = t.table_index), json_object('Priority', '-', 'Task', 'New middle task') FROM tables t WHERE path = '{this.path}' AND block_id = 'priority-list'}`


### Update status with one click

| Client | Status |
| ------ | ------ |
| Blue Cross | Pending |
| Dunmore High School | Active |
^clients

Mark Blue Cross as complete: `vq[✓ Complete]{UPDATE table_cells SET cell_value = 'Complete' WHERE path = '{this.path}' AND table_index = (SELECT table_index FROM tables WHERE path = '{this.path}' AND block_id = 'clients') AND row_index = 0 AND column_name = 'Status'}`

### Recalculate totals

Michael Scott Paper Company monthly budget:

| Category | Amount |
| -------- | ------ |
| Paper costs | 1200 |
| Office rent | 800 |
| Copier lease | 400 |
| **Total** | 2400 |
^mspc-budget

`vq[Crunch those numbers again]{UPDATE mspc_budget_table SET Amount = (SELECT SUM(CAST(Amount AS INTEGER)) FROM mspc_budget_table WHERE Category NOT LIKE '%Total%') WHERE Category LIKE '%Total%'}`

### Button with datetime

Track timestamps for time-sensitive data:

| Timestamp | Event |
| --------- | ----- |
^event-log

`vq[+ Log Event]{INSERT INTO table_rows (path, table_index, row_json) SELECT '{this.path}', table_index, json_object('Timestamp', datetime('now', 'localtime'), 'Event', 'Manual entry') FROM tables WHERE path = '{this.path}' AND block_id = 'event-log'}`

### Syntax tips

- **Label**: Text between `[` and `]` becomes the button text
- **SQL**: Everything between `{` and `}` is executed as SQL
- **Template vars**: Use `{this.path}`, `{this.folder}`, `{this.title}`
- **Dates**: Use SQLite functions like `date('now')`, `datetime('now', 'localtime')`
- **Escaping**: If SQL contains `}`, the button won't parse correctly—keep SQL simple

### Custom button classes

Add CSS classes to customize button appearance using dot notation before the label:

```
`vq.[Label]{SQL}`              -- plain button (no accent color)
`vq.classname[Label]{SQL}`     -- custom class
`vq.class1.class2[Label]{SQL}` -- multiple classes
```

**Built-in Obsidian classes:**

| Syntax                      | Style                           |
| --------------------------- | ------------------------------- |
| `vq[Label]`                 | Default accent button (mod-cta) |
| `vq.[Label]`                | Plain button (no styling)       |
| `vq.mod-warning[Label]`     | Yellow/orange warning           |
| `vq.mod-destructive[Label]` | Red destructive                 |

**Live examples** (these are clickable buttons that do nothing harmful):

`vq[Default]{SELECT 1}` `vq.[Plain]{SELECT 1}` `vq.mod-warning[Warning]{SELECT 1}` `vq.mod-destructive[Destructive]{SELECT 1}`

#tables #data #structured #inline-buttons
