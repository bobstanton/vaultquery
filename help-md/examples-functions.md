---
id: examples-functions
title: Custom Function Examples
---

# Custom Function Examples

## Text formatting

### Capitalize first letter

~~~vaultquery-function
function capitalize(str) {
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
~~~

~~~vaultquery
SELECT capitalize(title) as formatted FROM notes LIMIT 5
~~~

### Title case

~~~vaultquery-function
function title_case(str) {
  if (!str) return null;
  return str.replace(/\w\S*/g, txt =>
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}
~~~

### Extract first word

~~~vaultquery-function
function first_word(text) {
  if (!text) return null;
  const match = text.match(/^\s*(\S+)/);
  return match ? match[1] : null;
}
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
-- Example: json_path('{"user":{"name":"Bob"}}', 'user.name') returns 'Bob'
SELECT json_path(row_json, 'Status') as status
FROM table_rows
WHERE json_path(row_json, 'Status') = 'Active'
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
  const tags = text.match(/#[\w-]+/g);
  return tags ? tags.join(' ') : null;
}
~~~

## Numeric utilities

### Clamp value

~~~vaultquery-function
function clamp(value, min, max) {
  if (value === null) return null;
  return Math.min(Math.max(value, min), max);
}
~~~

### Round to decimal places

~~~vaultquery-function
function round_to(value, decimals) {
  if (value === null) return null;
  const factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}
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

## String utilities

### Truncate with ellipsis

~~~vaultquery-function
function truncate(text, maxLen) {
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}
~~~

### Remove markdown

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
