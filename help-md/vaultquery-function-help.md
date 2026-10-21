---
id: vaultquery-function-help
title: VaultQuery Function Reference
---

# Built-in function reference

## Link functions

Generate internal links using Obsidian's link format settings. 

| Function                                 | Links to            |
| ---------------------------------------- | ------------------- |
| `link(path[, display])`                  | A note              |
| `link_heading(path, heading[, display])` | A heading in a note |
| `link_block(path, block_id[, display])`  | A block reference   |

The optional `display` argument sets custom link text.

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

## resolve_link(wikilink[, sourcePath])

Resolves a wikilink to its full file path using Obsidian's link resolution. Returns `NULL` if the link cannot be resolved.

| Function                             | Description                               |
| ------------------------------------ | ----------------------------------------- |
| `resolve_link(wikilink)`             | Resolve link using vault-wide search      |
| `resolve_link(wikilink, sourcePath)` | Resolve link relative to source file path |

Accepts note names and wikilinks. Display text and heading fragments are ignored.

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

| Function               | Description                | Example                              |
| ---------------------- | -------------------------- | ------------------------------------ |
| `filename(path)`       | Filename with extension    | `folder/note.md` to `note.md`        |
| `path_name(path)`      | Filename with extension    | `folder/note.md` to `note.md`        |
| `path_basename(path)`  | Filename without extension | `folder/note.md` to `note`           |
| `path_extension(path)` | Extension without dot      | `folder/note.md` to `md`             |
| `path_parent(path)`    | Parent folder path         | `folder/sub/note.md` to `folder/sub` |

~~~vaultquery
SELECT filename(path) as file, path_parent(path) as folder
FROM notes
WHERE path_parent(path) = '{this.folder}'
~~~

## parse_date(text)

Extracts and normalizes a date from anywhere in the text. Returns ISO format (YYYY-MM-DD) or `NULL`.

| Format     | Example                           |
| ---------- | --------------------------------- |
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

Formats an ISO date (YYYY-MM-DD) or compact date (YYYYMMDD) using format specifiers. Returns `NULL` if date is invalid.

| Specifier | Output                 | Example    |
| --------- | ---------------------- | ---------- |
| `%Y`      | 4-digit year           | `2024`     |
| `%y`      | 2-digit year           | `24`       |
| `%B`      | Full month name        | `December` |
| `%b`      | Abbreviated month      | `Dec`      |
| `%m`      | Month (zero-padded)    | `12`       |
| `%d`      | Day (zero-padded)      | `08`       |
| `%e`      | Day (no padding)       | `8`        |
| `%A`      | Full weekday name      | `Friday`   |
| `%a`      | Abbreviated weekday    | `Fri`      |
| `%w`      | Weekday number (0=Sun) | `5`        |
| `%j`      | Day of year            | `355`      |
| `%%`      | Literal %              | `%`        |

~~~vaultquery
-- Combine parse_date and format_date
SELECT format_date(parse_date(heading_text), '%B %e, %Y') as formatted_date
FROM headings
WHERE parse_date(heading_text) IS NOT NULL
~~~

## parse_number(value)

Reads a single number with an optional unit suffix. Supports decimal points, signs, exponents, and comma thousands separators: `parse_number('1,046 ft')` returns `1046`. Empty text, nonnumeric values, ranges, and compound measurements return `NULL`. Percentages retain their original scale (`'25%'` returns `25`).

~~~vaultquery
SELECT order_id, client, reams
FROM "Data/paper-orders.csv"
ORDER BY parse_number(reams) ASC NULLS LAST
~~~

## convert_distance(value, target_unit[, bare_unit])

Converts distances between `mm`, `cm`, `m`, `km`, `in`, `ft`, `yd`, and `mi`. Full unit names such as `feet`, `meters`, and `miles` are also supported. Invalid values or unknown units return `NULL`.

- `convert_distance('1,000 ft', 'm')` returns `304.8`.
- `convert_distance('1 km', 'ft')` returns `3280.84`.
- `convert_distance('1000', 'm')` returns `NULL`: a bare number has no known unit.
- `convert_distance('1000', 'm', 'ft')` returns `304.8`. The optional third argument supplies the unit of bare numbers; values with a suffix use that suffix.

## regexp(pattern, text)

Returns 1 if text matches the regex pattern, 0 otherwise. Enables the REGEXP operator.

~~~vaultquery
SELECT * FROM notes WHERE title REGEXP '^Daily.*2024'
~~~

The built-in text helpers return `NULL` for binary or numeric text arguments. `regexp` and `regexp_replace` also return `NULL` for required arguments containing `NULL`.

## regexp_replace(text, pattern, replacement)

Replaces all matches of pattern with replacement. Supports escape sequences: \n, \t, \r, \\.

~~~vaultquery
SELECT regexp_replace(content, '\\s+', ' ') as cleaned FROM notes
~~~

## Geolocation functions

| Function                                  | Description                              |
| ----------------------------------------- | ---------------------------------------- |
| `geo_lat(text)`                           | Extract latitude from coordinate string  |
| `geo_lng(text)`                           | Extract longitude from coordinate string |
| `geo_distance_mi(lat1, lng1, lat2, lng2)` | Distance in miles                        |
| `geo_distance_km(lat1, lng1, lat2, lng2)` | Distance in kilometers                   |

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

# User-defined functions

Use `vaultquery-function` to define JavaScript functions for SQL queries.

## Create a function

~~~vaultquery-function
function capitalize(str) {
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
~~~

Use `function name(args) { ... }` syntax; arrow functions are not supported.

## Use a function

~~~vaultquery
SELECT capitalize(title) as formatted_title FROM notes LIMIT 5
~~~

Functions can use JavaScript built-ins, but cannot access Obsidian APIs or external libraries. See `vaultquery-examples` for more functions.

# Registered functions

{{dynamic:functions}}
