---
status: active
priority: medium
category: documentation
---

Render query results using custom HTML templates instead of the SlickGrid view.


## Basic syntax

End the query with a semicolon (`;`), then add `template:` followed by JavaScript that returns an HTML string.

### Variables

| Variable  | Description                    |
| --------- | ------------------------------ |
| `results` | Array of row objects from query|
| `count`   | Number of rows returned        |
| `query`   | The SQL query string           |

### Helper functions (via `h`)

| Function                    | Description                                  |
| --------------------------- | -------------------------------------------- |
| `h.link(path, text?)`       | Create an internal Obsidian link             |
| `h.escape(text)`            | Escape HTML characters to prevent XSS        |
| `h.truncate(text, length?)` | Truncate text (default 200 characters)       |
| `h.formatDate(timestamp)`   | Format a timestamp as a localized date string|


## List example

Display notes as a bulleted list with clickable links:

```vaultquery
SELECT title, path FROM notes LIMIT 5;
template:
return `<ul>
  ${results.map(r => `<li>${h.link(r.path, r.title)}</li>`).join('')}
</ul>`
```

## Card layout example

Display notes as styled cards with truncated content preview:

```vaultquery
SELECT title, path, content FROM notes WHERE content IS NOT NULL LIMIT 3;
template:
return `<div style="display: grid; gap: 1em;">
  ${results.map(r => `
    <div style="border: 1px solid var(--background-modifier-border); padding: 1em; border-radius: 8px;">
      <h4>${h.link(r.path, r.title)}</h4>
      <p style="color: var(--text-muted);">${h.truncate(h.escape(r.content || ''), 100)}</p>
    </div>
  `).join('')}
</div>`
```

## Summary statistics example

Show task status breakdown with counts:

```vaultquery
SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status ORDER BY cnt DESC;
template:
return `<div>
  <p><strong>Task Summary</strong> (${count} statuses)</p>
  <ul>
    ${results.map(r => `<li><strong>${h.escape(r.status || 'Unknown')}</strong>: ${r.cnt} tasks</li>`).join('')}
  </ul>
</div>`
```

## Table with custom styling example


```vaultquery
SELECT title, path, modified FROM notes ORDER BY modified DESC LIMIT 5;
template:
return `<table style="width: 100%; border-collapse: collapse;">
  <thead>
    <tr style="border-bottom: 2px solid var(--background-modifier-border);">
      <th style="text-align: left; padding: 0.5em;">Note</th>
      <th style="text-align: right; padding: 0.5em;">Last Modified</th>
    </tr>
  </thead>
  <tbody>
    ${results.map(r => `
      <tr style="border-bottom: 1px solid var(--background-modifier-border);">
        <td style="padding: 0.5em;">${h.link(r.path, r.title)}</td>
        <td style="text-align: right; padding: 0.5em; color: var(--text-muted);">${h.formatDate(r.modified)}</td>
      </tr>
    `).join('')}
  </tbody>
</table>`
```


## Tags cloud example

Display tags with size based on frequency:

```vaultquery
SELECT tag_name, COUNT(*) as cnt FROM tags GROUP BY tag_name ORDER BY cnt DESC LIMIT 10;
template:
const maxCnt = Math.max(...results.map(r => r.cnt));
return `<div style="display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center;">
  ${results.map(r => {
    const size = 0.8 + (r.cnt / maxCnt) * 0.8;
    return `<span style="font-size: ${size}em; padding: 0.2em 0.5em; background: var(--background-modifier-hover); border-radius: 4px;">#${h.escape(r.tag_name)} <small>(${r.cnt})</small></span>`;
  }).join('')}
</div>`
```

---

## Conditional rendering example

Show different content based on results:

```vaultquery
SELECT task_text, status, priority FROM tasks WHERE status != 'DONE' ORDER BY priority LIMIT 5;
template:
if (count === 0) {
  return `<p style="color: var(--text-success);">All tasks completed!</p>`;
}
return `<div>
  <p><strong>${count} pending task${count === 1 ? '' : 's'}:</strong></p>
  <ul>
    ${results.map(r => {
      const priorityColor = r.priority === 'high' ? 'var(--text-error)' :
                           r.priority === 'medium' ? 'var(--text-warning)' : 'inherit';
      return `<li style="color: ${priorityColor};">${h.escape(r.task_text)} <small>[${r.status}]</small></li>`;
    }).join('')}
  </ul>
</div>`
```
