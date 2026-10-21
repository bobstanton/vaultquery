---
id: vaultquery-chart-help
title: VaultQuery Chart Help
---

# Chart output

Use `vaultquery-chart` to render query results as a chart. Query must include `label` and `value` columns (or `x`/`y` for scatter). Add a `series` column for multiple datasets.

## Bar chart

~~~vaultquery-chart
SELECT tag_name as label, COUNT(*) as value
FROM tags
GROUP BY tag_name
ORDER BY value DESC
LIMIT 10;

config:
type: bar
datasetLabel: Tag count
~~~

## Line chart with axis labels

~~~vaultquery-chart
SELECT done_date as label, COUNT(*) as value
FROM tasks
WHERE status = 'DONE'
GROUP BY done_date
ORDER BY done_date;

config:
type: line
xLabel: Date
yLabel: Completed
datasetLabel: Tasks completed
~~~

## Scatter chart

~~~vaultquery-chart
SELECT
  size as x,
  length(content) as y,
  title as series
FROM notes
WHERE size IS NOT NULL
ORDER BY size DESC
LIMIT 25;

config:
type: scatter
xLabel: File size
yLabel: Content length
~~~

## Bar chart with custom color

~~~vaultquery-chart
SELECT tag_name as label, COUNT(*) as value
FROM tags
GROUP BY tag_name
LIMIT 5;

config:
type: bar
datasetBackgroundColor: rgba(75, 192, 192, 0.8)
datasetBorderColor: rgba(75, 192, 192, 1)
~~~

## Per-bar colors via SQL

~~~vaultquery-chart
SELECT
  tag_name as label,
  COUNT(*) as value,
  CASE
    WHEN tag_name = '#important' THEN 'rgba(255, 99, 132, 0.8)'
    ELSE 'rgba(54, 162, 235, 0.8)'
  END as backgroundColor
FROM tags
GROUP BY tag_name
LIMIT 5;

config:
type: bar
~~~

## Multi-series bar chart

~~~vaultquery-chart
SELECT status as label, priority as series, COUNT(*) as value
FROM tasks
GROUP BY status, priority;

config:
type: bar
title: Tasks by status and priority
~~~

## Mixed chart

~~~vaultquery-chart
SELECT label, value, series, chartType, backgroundColor FROM (
  SELECT 'Jan' as label, 10 as value, 'Sales' as series,
         'bar' as chartType, 'rgba(54, 162, 235, 0.8)' as backgroundColor
  UNION ALL
  SELECT 'Jan', 8, 'Trend', 'line', 'rgba(255, 99, 132, 1)'
  UNION ALL
  SELECT 'Feb', 15, 'Sales', 'bar', 'rgba(54, 162, 235, 0.8)'
  UNION ALL
  SELECT 'Feb', 12, 'Trend', 'line', 'rgba(255, 99, 132, 1)'
);

config:
type: bar
title: Sales vs Trend
~~~

## Chart result columns

| Column            | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `label`           | Category label for bar, line, pie, and doughnut charts |
| `value`           | Numeric value for bar, line, pie, and doughnut charts  |
| `x`               | X value for scatter charts                             |
| `y`               | Y value for scatter charts                             |
| `series`          | Dataset name for multiple datasets                     |
| `chartType`       | Per-series chart type for mixed charts                 |
| `backgroundColor` | Color for a point, bar, slice, or dataset item         |
| `borderColor`     | Border or line color                                   |

## Chart config options

| Setting                  | Description                                                       | Examples                                    |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| `type`                   | Required                                                          | `bar`, `line`, `pie`, `doughnut`, `scatter` |
| `title`                  | Shown above the chart                                             | `Task count`                                |
| `datasetLabel`           | Shown in the legend                                               | `Tasks`                                     |
| `xLabel`                 | Applies to bar, line, and scatter charts                          | `Status`                                    |
| `yLabel`                 | Applies to bar, line, and scatter charts                          | `Count`                                     |
| `datasetBackgroundColor` | Applies to the whole dataset                                      | `rgba(54, 162, 235, 0.8)`                   |
| `datasetBorderColor`     | Applies to the whole dataset                                      | `rgba(54, 162, 235, 1)`                     |
| `autoRefresh`            | Reruns when indexed files change. Defaults to the global setting. | `true`, `false`                             |
