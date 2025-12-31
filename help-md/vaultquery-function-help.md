---
id: vaultquery-function-help
title: VaultQuery Function Reference
---

# Available Functions

{{dynamic:functions}}

# User-defined functions

Use `vaultquery-function` blocks to create custom [scalar SQL functions](https://sql.js.org/documentation/Database.html#%5B%22create_function%22%5D) in JavaScript. Scalar functions process one row at a time and return a single value. 

## Creating a function

~~~vaultquery-function
function capitalize(str) {
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
~~~

> [!warning] Warning
> VaultQuery parses the function name and requires functions to use the `function name(args) { ... }` syntax. Arrow functions and other forms are not supported.

## Using a function

Once created, use the function in any SQL query:

~~~vaultquery
SELECT capitalize(title) as formatted_title FROM notes LIMIT 5
~~~

## String manipulation function

~~~vaultquery-function
function extract_first_word(text) {
  if (!text) return null;
  const match = text.match(/^\s*(\S+)/);
  return match ? match[1] : null;
}
~~~

## Days until calculation function

~~~vaultquery-function
function days_until(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = target - today;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}
~~~

## JSON extraction function

~~~vaultquery-function
function json_get(jsonStr, key) {
  if (!jsonStr || !key) return null;
  try {
    const obj = JSON.parse(jsonStr);
    return obj[key] ?? null;
  } catch {
    return null;
  }
}
~~~

> [!note] Note
> Functions have access to JavaScript built-ins but not to Obsidian APIs or external libraries.

# Built-in function reference

## regexp(pattern, text)

Returns 1 if text matches the regex pattern, 0 otherwise. Enables the REGEXP operator.

~~~vaultquery
SELECT * FROM notes WHERE title REGEXP '^Daily.*2024'
~~~

## regexp_replace(text, pattern, replacement)

Replaces all matches of pattern with replacement. Supports escape sequences: \n, \t, \r, \\.

~~~vaultquery
SELECT regexp_replace(content, '\\s+', ' ') as cleaned FROM notes
~~~

## parse_date(text)

Extracts and normalizes a date from anywhere in the text. Returns ISO format (YYYY-MM-DD) or null.

| Format     | Example                           |
|------------|-----------------------------------|
| ISO        | `2024-12-20, 2024/12/20`          |
| Compact    | `20241220`                        |
| US         | `12/20/2024, 12-20-2024`          |
| European   | `20.12.2024`                      |
| Month name | `December 20, 2024`               |
| Day-first  | `20 December 2024, 20th Dec 2024` |

~~~vaultquery
SELECT parse_date(heading_text) as visit_date
FROM headings
WHERE parse_date(heading_text) IS NOT NULL
ORDER BY visit_date DESC
~~~

## format_date(date, format)

Formats an ISO date (YYYY-MM-DD) using format specifiers. Returns null if date is invalid.

| Specifier | Output                 | Example     |
|-----------|------------------------|-------------|
| `%Y`      | 4-digit year           | `2024`      |
| `%y`      | 2-digit year           | `24`        |
| `%B`      | Full month name        | `December`  |
| `%b`      | Abbreviated month      | `Dec`       |
| `%m`      | Month (zero-padded)    | `12`        |
| `%d`      | Day (zero-padded)      | `08`        |
| `%e`      | Day (no padding)       | `8`         |
| `%A`      | Full weekday name      | `Friday`    |
| `%a`      | Abbreviated weekday    | `Fri`       |
| `%w`      | Weekday number (0=Sun) | `5`         |
| `%j`      | Day of year            | `355`       |
| `%%`      | Literal %              | `%`         |

~~~vaultquery
-- Combine parse_date and format_date
SELECT format_date(parse_date(heading_text), '%B %e, %Y') as formatted_date
FROM headings
WHERE parse_date(heading_text) IS NOT NULL
~~~

## Link functions

Build [Obsidian internal links](https://help.obsidian.md/links) (wikilinks). Use in `vaultquery-markdown` blocks for clickable links.

| Function                                 | Output                       | Example                            |
|------------------------------------------|------------------------------|------------------------------------|
| `link(path)`                             | `[[path]]`                   | `[[folder/note.md]]`               |
| `link(path, display)`                    | `[[path\|display]]`          | `[[folder/note.md\|My Note]]`      |
| `link_heading(path, heading)`            | `[[path#heading]]`           | `[[note.md#Section]]`              |
| `link_heading(path, heading, display)`   | `[[path#heading\|display]]`  | `[[note.md#Section\|See Section]]` |
| `link_block(path, block_id)`             | `[[path#^block-id]]`         | `[[note.md#^abc123]]`              |
| `link_block(path, block_id, display)`    | `[[path#^block-id\|display]]`| `[[note.md#^abc123\|Reference]]`   |

~~~vaultquery
-- Basic links
SELECT link(path, title) as note FROM notes LIMIT 5

-- Link to specific headings
SELECT link_heading(path, heading_text, 'Jump to section') as link
FROM headings
WHERE level = 2

-- Link to blocks with block_id
SELECT link_block(path, block_id, task_text) as task_link
FROM tasks
WHERE block_id IS NOT NULL
~~~

## resolve_link(wikilink [, sourcePath])

Resolves a wikilink to its full file path using Obsidian's link resolution. Returns null if the link cannot be resolved.

| Function                         | Description                                      |
|----------------------------------|--------------------------------------------------|
| `resolve_link(wikilink)`         | Resolve link using vault-wide search             |
| `resolve_link(wikilink, source)` | Resolve link relative to source file path        |

The function handles various wikilink formats:
- Plain text: `My Note`
- Wikilink syntax: `[[My Note]]`
- With display text: `[[My Note|Display]]` (display text is ignored)
- With heading: `[[My Note#Section]]` (heading is stripped, returns note path)

~~~vaultquery
-- Resolve links from the links table
SELECT l.link_text, resolve_link(l.link_text, l.path) as resolved_path
FROM links l
WHERE resolve_link(l.link_text, l.path) IS NOT NULL

-- Find broken links (links that don't resolve)
SELECT path, link_text
FROM links
WHERE resolve_link(link_text, path) IS NULL
~~~

## Path functions

Extract components from file paths. Names match Obsidian's TFile properties.

| Function               | Description                | Example                             |
|------------------------|----------------------------|-------------------------------------|
| `filename(path)`       | Filename with extension    | `folder/note.md` → `note.md`        |
| `path_name(path)`      | Filename with extension    | `folder/note.md` → `note.md`        |
| `path_basename(path)`  | Filename without extension | `folder/note.md` → `note`           |
| `path_extension(path)` | Extension without dot      | `folder/note.md` → `md`             |
| `path_parent(path)`    | Parent folder path         | `folder/sub/note.md` → `folder/sub` |

~~~vaultquery
SELECT filename(path) as file, path_parent(path) as folder
FROM notes
WHERE path_parent(path) = '{this.folder}'
~~~

## Geolocation functions

Calculate distances between geographic coordinates using the Haversine formula.

| Function                                  | Description                             |
|-------------------------------------------|-----------------------------------------|
| `geo_lat(text)`                           | Extract latitude from coordinate string |
| `geo_lng(text)`                           | Extract longitude from coordinate string|
| `geo_distance_mi(lat1, lng1, lat2, lng2)` | Distance in miles                       |
| `geo_distance_km(lat1, lng1, lat2, lng2)` | Distance in kilometers                  |

Coordinate parsing supports formats: `"lat, lng"`, `"lat,lng"`, `"lat lng"`

Using the `notes_with_properties` view:

~~~vaultquery
-- Find notes within 15 miles of a location
-- Assumes frontmatter: Location: 40.748333, -73.985556
SELECT path, title,
  geo_distance_mi(geo_lat(Location), geo_lng(Location), 40.689167, -74.044444) as distance_miles
FROM notes_with_properties
WHERE Location IS NOT NULL
  AND geo_distance_mi(geo_lat(Location), geo_lng(Location), 40.689167, -74.044444) < 15
ORDER BY distance_miles
~~~

Or using a JOIN with the `properties` table:

~~~vaultquery
SELECT n.path, n.title,
  geo_distance_mi(geo_lat(p.value), geo_lng(p.value), 40.689167, -74.044444) as distance_miles
FROM notes n
JOIN properties p ON n.path = p.path
WHERE p.key = 'Location'
  AND geo_distance_mi(geo_lat(p.value), geo_lng(p.value), 40.689167, -74.044444) < 15
ORDER BY distance_miles
~~~
