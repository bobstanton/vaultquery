---
status: active
category: documentation
---


# Working with List Items

Query and modify bulleted and numbered lists in the vault.

> [!note] Enable List Indexing
> List item indexing must be enabled in VaultQuery settings under "Index list items".

---

## Querying List Items

### List items in the current note

**Lunch Order:**

- Jim: Chicken piccata, side salad
- Robert California: Chicken piccata, side salad
- Kevin: Chicken piccata, side salad
- Darryl: Chicken piccata, salad on the side
- Oscar: Side salad, chicken piccata
- Toby: Chicken piccata, side salad
- Angela: Side salad, chicken piccata on the side ^angela-order
- Phyllis: Side salad, then chicken piccata
- Dwight: Steak. Rare. ^dwight-order

```vaultquery
SELECT list_index, item_index, indent_level, content
FROM list_items
WHERE path = '{this.path}'
ORDER BY list_index, item_index
```

### Using list_items_view for hierarchical queries

The `list_items_view` includes parent content for easier hierarchical queries:

```vaultquery
SELECT content, parent_content, indent_level
FROM list_items_view
WHERE path = '{this.path}'
ORDER BY item_index
```

### Search list content

**Michael's Daily Priorities:**

- That's what she said jokes
- Avoid Toby at all costs
- Schedule meeting with David Wallace
- World's Best Boss mug maintenance

```vaultquery
SELECT path, content
FROM list_items
WHERE content LIKE '%meeting%'
   OR content LIKE '%David Wallace%'
LIMIT 20
```

### Bullet vs numbered lists

**Dwight's Sales Strategy:**

1. Assert dominance
2. Know the product better than anyone
3. Close the sale
   1. Use the Schrute method
   2. Never take no for an answer

```vaultquery
SELECT list_type, COUNT(*) as count
FROM list_items
WHERE path = '{this.path}'
GROUP BY list_type
```

### Notes with the most list items

```vaultquery
SELECT path, COUNT(*) as list_item_count
FROM list_items
GROUP BY path
ORDER BY list_item_count DESC
LIMIT 10
```

### Items from a specific list by index

Each separate list in a note has a unique `list_index` (0-based):

```vaultquery
SELECT list_index, content, indent_level
FROM list_items
WHERE path = '{this.path}'
  AND list_index = 0
ORDER BY item_index
```

### Find items with block references

Block IDs enable precise targeting for updates:

```vaultquery
SELECT path, content, block_id
FROM list_items
WHERE block_id IS NOT NULL
ORDER BY path
LIMIT 20
```

### Numbered vs bullet items in current note

```vaultquery
SELECT
  list_type,
  COUNT(*) as count,
  GROUP_CONCAT(content, ', ') as items
FROM list_items
WHERE path = '{this.path}'
GROUP BY list_type
```

---

## Modifying List Items

Write operations update list items in the vault's files.

### Insert new list items

**Kevin's Famous Chili Ingredients:**

- Ground beef
- Onions
- Tomatoes
- Ancho chilies ^chili-anchor

Add to Kevin's recipe:

```vaultquery-write
INSERT INTO list_items (path, content, list_type, indent_level, line_number)
SELECT '{this.path}', 'The secret is to undercook the onions', 'bullet', 0,
  (SELECT line_number + 1 FROM list_items WHERE path = '{this.path}' AND block_id = 'chili-anchor')
```

### Update list item content

Change Dwight's order (he changed his mind):

```vaultquery-write
UPDATE list_items
SET content = 'Dwight: Steak. Medium rare. With a side of beet salad.'
WHERE path = '{this.path}'
  AND block_id = 'dwight-order'
```

### Update item with block reference

Change Angela's order to be even more particular:

```vaultquery-write
UPDATE list_items
SET content = 'Angela: Side salad, no dressing, chicken piccata on the side, hold the chicken'
WHERE path = '{this.path}'
  AND block_id = 'angela-order'
```

### Delete a list item

Remove Toby from the lunch order:

```vaultquery-write
DELETE FROM list_items
WHERE path = '{this.path}'
  AND content LIKE '%Toby:%'
```

---

## Hierarchical Queries

### Find parent-child relationships

**Jim's Pranks on Dwight:**

- Desk pranks
	- Stapler in jello
	- Move desk to bathroom
	- Fill phone with nickels
- Items in vending machine
	- Pencils
	- Wallet
- Identity pranks
	- Asian Jim
	- Future Dwight fax

The `parent_index` column links items to their parents:

```vaultquery
SELECT
  child.path,
  child.content as item,
  parent.content as parent_item,
  child.indent_level
FROM list_items child
LEFT JOIN list_items parent
  ON child.path = parent.path
  AND child.parent_index = parent.item_index
  AND child.list_index = parent.list_index
WHERE child.path = '{this.path}'
ORDER BY child.item_index
```

### Count children per item

```vaultquery
SELECT parent.content, COUNT(child.id) as child_count
FROM list_items parent
LEFT JOIN list_items child ON parent.path = child.path
  AND parent.item_index = child.parent_index
  AND parent.list_index = child.list_index
WHERE parent.path = '{this.path}'
  AND parent.indent_level = 0
GROUP BY parent.id
HAVING child_count > 0
ORDER BY child_count DESC
```

---

## Combining with Other Tables

### Notes with both lists and tasks

```vaultquery
SELECT DISTINCT n.path, n.title
FROM notes n
JOIN list_items l ON n.path = l.path
JOIN tasks t ON n.path = t.path
ORDER BY n.path
LIMIT 20
```

### List items near specific headings

Find list items that appear after a heading:

```vaultquery
SELECT l.content, h.heading_text
FROM list_items l
JOIN headings h ON l.path = h.path
WHERE l.path = '{this.path}'
  AND l.line_number > h.line_number
  AND h.heading_text LIKE '%Party%'
ORDER BY l.line_number
```

---

## Statistics

### List density by folder

```vaultquery
SELECT
  CASE
    WHEN INSTR(path, '/') > 0 THEN SUBSTR(path, 1, INSTR(path, '/') - 1)
    ELSE '(root)'
  END as folder,
  COUNT(*) as list_items,
  COUNT(DISTINCT path) as notes_with_lists
FROM list_items
GROUP BY folder
ORDER BY list_items DESC
LIMIT 10
```

### Average items per list

```vaultquery
SELECT
  path,
  list_index,
  COUNT(*) as items_in_list
FROM list_items
GROUP BY path, list_index
ORDER BY items_in_list DESC
LIMIT 10
```
