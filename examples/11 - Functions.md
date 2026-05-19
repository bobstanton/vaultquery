---
status: active
category: functions
---

Custom functions add user-authored JavaScript functions to SQL. JavaScript SQL functions must be enabled in VaultQuery settings.

## Creating Functions

`vaultquery-function` defines a function:

```vaultquery-function
function capitalize(str) {
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
```

> [!warning] Function Syntax
> Functions must use the `function name(args) { ... }` syntax. Arrow functions and other forms are not supported.

Registered functions are available in queries:

```vaultquery
SELECT capitalize('dwight') as formatted_name
-- Returns: Dwight
```

---

## Function Examples

### Extract Job Title

First word from a job title:

```vaultquery-function
function first_word(text) {
  if (!text) return null;
  const match = text.match(/^\s*(\S+)/);
  return match ? match[1] : null;
}
```

```vaultquery
SELECT first_word('Assistant to the Regional Manager') as title_start
-- Returns: Assistant
```

### Days Until Event

Days until a date:

```vaultquery-function
function days_until(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = target - today;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}
```

```vaultquery
SELECT task_text, due_date, days_until(due_date) as days_left
FROM tasks
WHERE due_date IS NOT NULL
  AND status = 'TODO'
  AND task_text LIKE '%Dundies%'
ORDER BY days_left
```

### JSON Property Extraction

Value lookup in JSON text:

```vaultquery-function
function json_get(jsonStr, key) {
  if (!jsonStr || !key) return null;
  try {
    const obj = JSON.parse(jsonStr);
    return obj[key] ?? null;
  } catch {
    return null;
  }
}
```

### Word Count

Word count:

```vaultquery-function
function word_count(text) {
  if (!text) return 0;
  const words = text.trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}
```

```vaultquery
SELECT title, word_count(content) as words
FROM notes
WHERE path LIKE '%Threat Level Midnight%'
ORDER BY words DESC
```

### Slugify Text

URL-friendly slugs:

```vaultquery-function
function slugify(text) {
  if (!text) return null;
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

```vaultquery
SELECT title, slugify(title) as slug
FROM notes
WHERE title IN ('Threat Level Midnight', 'Somehow I Manage', 'Serenity by Jan')
```

### Extract Year from Date

Year extraction from date text:

```vaultquery-function
function year_of(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{4})/);
  return match ? parseInt(match[1]) : null;
}
```

```vaultquery
SELECT task_text, year_of(done_date) as completed_year
FROM tasks
WHERE done_date IS NOT NULL
GROUP BY completed_year
```

### Sales Commission Calculator

Commission calculation:

```vaultquery-function
function commission(sales_amount, rate) {
  if (!sales_amount || !rate) return 0;
  return Math.round(sales_amount * rate * 100) / 100;
}
```

---

## Built-in Functions

Common built-in functions:

### Date Functions

| Function | Description | Example |
|----------|-------------|---------|
| `parse_date(text)` | Extract date from text | `parse_date('Dundies on 2024-12-20')` |
| `format_date(date, format)` | Format a date | `format_date('2024-12-20', '%B %d')` |

```vaultquery
SELECT
  heading_text,
  parse_date(heading_text) as event_date,
  format_date(parse_date(heading_text), '%B %d, %Y') as formatted
FROM headings
WHERE parse_date(heading_text) IS NOT NULL
  AND heading_text LIKE '%Party%'
LIMIT 5
```

### Path Functions

| Function | Description | Example |
|----------|-------------|---------|
| `path_basename(path)` | Filename without extension | `path_basename('Sales/Q4 Report.md')` = `Q4 Report` |
| `path_parent(path)` | Parent folder | `path_parent('Sales/Leads/Client.md')` = `Sales/Leads` |
| `path_extension(path)` | File extension | `path_extension('report.md')` = `md` |

```vaultquery
SELECT
  path_basename(path) as document,
  path_parent(path) as department
FROM notes
WHERE path_parent(path) IN ('Sales', 'Accounting', 'HR')
```

### Link Functions

| Function | Description |
|----------|-------------|
| `link(path)` | Create `[[path]]` |
| `link(path, display)` | Create `[[path\|display]]` |
| `link_heading(path, heading)` | Create `[[path#heading]]` |
| `resolve_link(text, source)` | Resolve wikilink to full path |

### Regex Functions

| Function | Description |
|----------|-------------|
| `regexp(pattern, text)` | Returns 1 if text matches pattern |
| `regexp_replace(text, pattern, replacement)` | Replace matches |

```vaultquery
-- Find notes starting with employee names
SELECT title
FROM notes
WHERE title REGEXP '^(Michael|Dwight|Jim|Pam|Andy)'
LIMIT 10
```

---

## Function Limitations

> [!note] Limitations
> - Functions have access to JavaScript built-ins only
> - No access to Obsidian APIs or external libraries (sorry, no WUPHF integration)
> - Functions must be scalar (process one row, return one value)
> - Aggregate functions are not supported
