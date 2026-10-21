---
id: examples-functions
title: Custom Function Examples
---

Use `vaultquery-function` to create functions which can be used from queries.

# Custom function examples

> [!important] Requirements
> **Setting:** **Settings > VaultQuery > Changes and automation > Scripts and triggers > Enable JavaScript SQL functions**.
>
> **Plugin default:** Off. 

The sample value describes the saved configuration of the VaultQuery demo vault.

## Text formatting

### Title case

~~~vaultquery-function
function title_case(str) {
  if (!str) return null;
  return str.replace(/\w\S*/g, txt =>
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}
~~~

~~~vaultquery
SELECT title, title_case(title) AS formatted_title
FROM notes
ORDER BY title
LIMIT 10;
~~~

### Extract first word

~~~vaultquery-function
function first_word(text) {
  if (!text) return null;
  const match = text.match(/^\s*(\S+)/);
  return match ? match[1] : null;
}
~~~

~~~vaultquery
SELECT title, first_word(title) AS first_word
FROM notes
ORDER BY title
LIMIT 10;
~~~

### Word count

~~~vaultquery-function
function word_count(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}
~~~

~~~vaultquery
SELECT title, word_count(content) as words
FROM notes
ORDER BY word_count(content) DESC
LIMIT 10
~~~

### Truncate with ellipsis

~~~vaultquery-function
function truncate(text, maxLen) {
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}
~~~

~~~vaultquery
SELECT title, truncate(title, 20) AS short_title
FROM notes
ORDER BY title
LIMIT 10;
~~~

### Remove Markdown

~~~vaultquery-function
function strip_markdown(text) {
  if (!text) return null;
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[\[(.+?)\]\]/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s*/gm, '');
}
~~~

~~~vaultquery
SELECT strip_markdown('# **Scranton** and *Schrute Farms*') AS plain_text;
~~~

## Numeric utilities

### Clamp value

~~~vaultquery-function
function clamp(value, min, max) {
  if (value === null) return null;
  return Math.min(Math.max(value, min), max);
}
~~~

~~~vaultquery
SELECT
  clamp(-5, 0, 100) AS below_range,
  clamp(42, 0, 100) AS within_range,
  clamp(120, 0, 100) AS above_range;
~~~

### Round to decimal places

~~~vaultquery-function
function round_to(value, decimals) {
  if (value === null) return null;
  const factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}
~~~

~~~vaultquery
SELECT
  round_to(123.4567, 2) AS two_decimal_places,
  round_to(123.4567, 0) AS nearest_integer;
~~~

### Percentage

~~~vaultquery-function
function percentage(part, total) {
  if (part === null || total === null || total === 0) return null;
  return Math.round((part / total) * 100);
}
~~~

~~~vaultquery
SELECT
  status,
  COUNT(*) as count,
  percentage(COUNT(*), (SELECT COUNT(*) FROM tasks)) || '%' as pct
FROM tasks
GROUP BY status
~~~

## Date calculations

### Days until date

~~~vaultquery-function
function days_until(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
}
~~~

~~~vaultquery
SELECT task_text, due_date, days_until(due_date) as days_left
FROM tasks
WHERE due_date IS NOT NULL AND days_until(due_date) >= 0
ORDER BY days_until(due_date)
~~~

### Days since date

~~~vaultquery-function
function days_since(dateStr) {
  if (!dateStr) return null;
  const past = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today - past) / (1000 * 60 * 60 * 24));
}
~~~

~~~vaultquery
SELECT days_since('2020-01-01T00:00:00') AS days_since_start;
~~~

### Week number

~~~vaultquery-function
function week_number(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  const start = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - start) / (1000 * 60 * 60 * 24));
  return Math.ceil((days + start.getDay() + 1) / 7);
}
~~~

~~~vaultquery
SELECT week_number('2026-01-15T00:00:00') AS week;
~~~

## Tag and metadata

### Extract priority from text

~~~vaultquery-function
function extract_priority(text) {
  if (!text) return null;
  const match = text.match(/[!@#]\s*(high|medium|low|urgent)/i);
  return match ? match[1].toLowerCase() : null;
}
~~~

~~~vaultquery
SELECT extract_priority('!high Call the client') AS priority;
~~~

### Has hashtag

~~~vaultquery-function
function has_tag(text, tag) {
  if (!text || !tag) return 0;
  const pattern = new RegExp('#' + tag + '\\b', 'i');
  return pattern.test(text) ? 1 : 0;
}
~~~

~~~vaultquery
SELECT title, path
FROM notes
WHERE has_tag(content, 'important') = 1
~~~

### Extract all hashtags

~~~vaultquery-function
function extract_tags(text) {
  if (!text) return null;
  const tags = text.match(/#[^\s\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\]+/g);
  return tags ? tags.join(' ') : null;
}
~~~

~~~vaultquery
SELECT extract_tags('Call #sales about #paper-orders') AS tags;
~~~

## JSON handling

### Get JSON property

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

~~~vaultquery
SELECT
  json_get('{"branch":"Scranton","employees":12}', 'branch') AS branch,
  json_get('{"branch":"Scranton","employees":12}', 'employees') AS employees;
~~~

### Get nested JSON property

~~~vaultquery-function
function json_path(jsonStr, path) {
  if (!jsonStr || !path) return null;
  try {
    const obj = JSON.parse(jsonStr);
    return path.split('.').reduce((o, k) => o?.[k], obj) ?? null;
  } catch {
    return null;
  }
}
~~~

~~~vaultquery
SELECT json_path(row_json, 'Status') as status
FROM table_rows
WHERE json_path(row_json, 'Status') = 'Active'
~~~
