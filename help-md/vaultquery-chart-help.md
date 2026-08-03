---
id: vaultquery-chart-help
title: VaultQuery Chart Help
---

# Charts & visualizations

Use `vaultquery-chart` to render query results as charts. Query must use `label` and `value` columns (or `x`/`y` for scatter). Add a `series` column for multiple datasets.

Chart output uses [Chart.js](https://www.chartjs.org/).

## Chart result columns

| Column            | Description |
|-------------------|-------------|
| `label`           | X/category label for bar, line, pie, and doughnut charts |
| `value`           | Numeric value for bar, line, pie, and doughnut charts |
| `x`               | X value for scatter charts |
| `y`               | Y value for scatter charts |
| `series`          | Optional dataset/group name for multiple datasets |
| `chartType`       | Optional per-series chart type for mixed charts |
| `backgroundColor` | Optional color for a point, bar, slice, or dataset item |
| `borderColor`     | Optional border/line color |

## Chart config options

| Option                   | Description |
|--------------------------|-------------|
| `type`                   | `bar`, `line`, `pie`, `doughnut`, or `scatter` (required) |
| `title`                  | Chart title |
| `datasetLabel`           | Legend label for the dataset |
| `xLabel`                 | X-axis label for bar, line, and scatter charts |
| `yLabel`                 | Y-axis label for bar, line, and scatter charts |
| `datasetBackgroundColor` | Dataset fill color, e.g. `rgba(54, 162, 235, 0.8)` |
| `datasetBorderColor`     | Dataset border/line color |

Use result columns for per-row or per-series colors when colors should come from SQL. Use config colors when one dataset-level color is enough.

Chart blocks also accept `autoRefresh`, shared by every query block: set it to `true` or `false` to re-run this chart when indexed files change, overriding the global setting.

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

Use a `backgroundColor` column to set colors per data point:

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

Use a `chartType` column to mix chart types:

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
