---
status: active
category: documentation
author: VaultQuery
---

## Working with Dates

Timestamps are stored in milliseconds. Use `/1000` when converting with SQLite date functions.

### Recently modified notes

```vaultquery
SELECT path, title,
  datetime(modified/1000, 'unixepoch', 'localtime') as modified_date
FROM notes
ORDER BY modified DESC
LIMIT 20
```

## Searching Content

> [!important] Enable content indexing
> Content search is disabled by default. To enable go to Settings → VaultQuery → Indexing → Index note content

### Full-text search in content

```vaultquery
SELECT path, title
FROM notes
WHERE content LIKE '%VaultQuery%'
```

### Case-insensitive search

```vaultquery
SELECT path, title
FROM notes
WHERE LOWER(content) LIKE '%query%'
```


## Aggregations

### Notes by size

```vaultquery
SELECT
  CASE
    WHEN size < 1000 THEN 'Tiny (<1KB)'
    WHEN size < 5000 THEN 'Small (1-5KB)'
    WHEN size < 20000 THEN 'Medium (5-20KB)'
    ELSE 'Large (>20KB)'
  END as size_category,
  COUNT(*) as count
FROM notes
GROUP BY size_category
```

### Vault statistics

```vaultquery
SELECT
  COUNT(*) as total_notes,
  SUM(size) as total_bytes,
  ROUND(SUM(size) / 1024.0 / 1024.0, 2) as total_mb,
  ROUND(AVG(size) / 1024.0, 1) as avg_kb
FROM notes
```

### Count notes by top-level folder

```vaultquery
SELECT
  CASE
    WHEN INSTR(path, '/') > 0 THEN SUBSTR(path, 1, INSTR(path, '/') - 1)
    ELSE '(root)'
  END as folder,
  COUNT(*) as note_count
FROM notes
GROUP BY folder
ORDER BY note_count DESC
LIMIT 10
```

### Largest notes

```vaultquery
SELECT path, title,
  ROUND(size / 1024.0, 1) as size_kb
FROM notes
ORDER BY size DESC
LIMIT 10
```

### Notes with specific headings
> [!important] Enable heading indexing
> Heading queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index headings

```vaultquery
SELECT DISTINCT n.path, n.title, h.heading_text 
FROM notes n
JOIN headings h ON n.path = h.path
WHERE h.heading_text LIKE '%note%'
   OR h.heading_text LIKE '%headings%'
LIMIT 20
```

### Notes without any tasks
> [!important] Enable task indexing
> Task queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index tasks

```vaultquery
SELECT n.path, n.title
FROM notes n
LEFT JOIN tasks t ON n.path = t.path
WHERE t.id IS NULL
ORDER BY n.path
LIMIT 20
```

### Orphan notes (not linked anywhere)
> [!important] Enable link indexing
> Link queries are disabled by default. To enable go to Settings → VaultQuery → Indexing → Index links

```vaultquery
SELECT n.path, n.title
FROM notes n
LEFT JOIN links l ON n.path = l.link_target
WHERE l.id IS NULL
ORDER BY n.modified DESC
LIMIT 20
```

### Notes with the most outgoing links

```vaultquery
SELECT path, COUNT(*) as link_count
FROM links
WHERE link_type = 'internal'
GROUP BY path
ORDER BY link_count DESC
LIMIT 10
```

## Built-in Functions

VaultQuery provides custom functions in addition to standard SQLite functions.

### Regex Functions

| Function                                     | Description                                    |
| -------------------------------------------- | ---------------------------------------------- |
| `text REGEXP 'pattern'`                      | Returns true if text matches the regex pattern |
| `regexp_replace(text, pattern, replacement)` | Replace all matches of pattern with replacement|

```vaultquery
-- Find notes with code blocks
SELECT path, title
FROM notes
WHERE content REGEXP '```[a-z]+\n'
LIMIT 20
```

```vaultquery
-- Clean up titles by removing brackets
SELECT path, regexp_replace(title, '\\[.*?\\]', '') as clean_title
FROM notes
LIMIT 10
```

### Link Functions

| Function              | Description                                      |
| --------------------- | ------------------------------------------------ |
| `link(path)`          | Creates an Obsidian link `[[path]]`              |
| `link(path, display)` | Creates a link with display text `[[path\|display]]` |

```vaultquery
-- Generate clickable links
SELECT link(path) as note_link, title
FROM notes
ORDER BY modified DESC
LIMIT 10
```

### Path Functions

| Function             | Description                            |
| -------------------- | -------------------------------------- |
| `path_name(path)`    | Filename with extension (`note.md`)    |
| `path_basename(path)`| Filename without extension (`note`)    |
| `path_extension(path)`| Extension without dot (`md`)          |
| `path_parent(path)`  | Parent folder path (`folder/subfolder`)|

```vaultquery
-- Group notes by folder
SELECT path_parent(path) as folder, COUNT(*) as count
FROM notes
GROUP BY folder
ORDER BY count DESC
LIMIT 10
```

### Date Functions

| Function                    | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `parse_date(text)`          | Extract date from text, returns ISO format (YYYY-MM-DD) |
| `format_date(date, format)` | Format ISO date using specifiers (see below)    |

**Format specifiers:** `%Y` (2024), `%y` (24), `%B` (December), `%b` (Dec), `%m` (12), `%d` (08), `%e` (8), `%A` (Friday), `%a` (Fri), `%w` (weekday 0-6), `%j` (day of year), `%%` (literal %)

```vaultquery
-- Parse dates from note titles
SELECT title, parse_date(title) as extracted_date
FROM notes
WHERE parse_date(title) IS NOT NULL
LIMIT 10
```

```vaultquery
-- Format dates nicely
SELECT title, format_date(parse_date(title), '%B %e, %Y') as formatted
FROM notes
WHERE parse_date(title) IS NOT NULL
LIMIT 10
```

### Geo Functions

| Function                                  | Description                             |
| ----------------------------------------- | --------------------------------------- |
| `geo_lat(text)`                           | Extract latitude from "lat, lng" format |
| `geo_lng(text)`                           | Extract longitude from "lat, lng" format|
| `geo_distance_km(lat1, lng1, lat2, lng2)` | Haversine distance in kilometers        |
| `geo_distance_mi(lat1, lng1, lat2, lng2)` | Haversine distance in miles             |

```vaultquery
-- Find notes with location property near a point
SELECT path, title, location,
  ROUND(geo_distance_mi(
    geo_lat(location), geo_lng(location),
    40.7128, -74.0060  -- New York City
  ), 1) as miles_from_nyc
FROM notes_with_properties
WHERE location IS NOT NULL
ORDER BY miles_from_nyc
LIMIT 10
```

### Common SQLite Functions

These standard SQLite functions are available in all queries:

| Category      | Functions                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------- |
| **String**    | `LENGTH`, `LOWER`, `UPPER`, `TRIM`, `LTRIM`, `RTRIM`, `SUBSTR`, `REPLACE`, `INSTR`, `LIKE`, `GLOB`|
| **Numeric**   | `ABS`, `ROUND`, `MIN`, `MAX`, `SUM`, `AVG`, `COUNT`, `RANDOM`                                     |
| **Date/Time** | `date()`, `time()`, `datetime()`, `julianday()`, `strftime()`                                     |
| **Null**      | `COALESCE`, `NULLIF`, `IFNULL`, `IIF`                                                             |
| **Type**      | `TYPEOF`, `CAST`, `PRINTF`                                                                        |
| **Aggregate** | `GROUP_CONCAT`, `TOTAL`                                                                           |

```vaultquery
-- SQLite date functions with timestamps (divide by 1000)
SELECT title,
  date(modified/1000, 'unixepoch') as mod_date,
  strftime('%W', modified/1000, 'unixepoch') as week_number
FROM notes
ORDER BY modified DESC
LIMIT 10
```

```vaultquery
-- String manipulation
SELECT
  UPPER(SUBSTR(title, 1, 1)) || LOWER(SUBSTR(title, 2)) as title_case,
  LENGTH(content) as char_count
FROM notes
LIMIT 10
```

