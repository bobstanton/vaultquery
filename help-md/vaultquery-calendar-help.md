---
id: vaultquery-calendar-help
title: VaultQuery Calendar Help
---

# Calendar output

Use `vaultquery-calendar` to render query results as a calendar. Query must include a `date` column.

## Basic calendar

~~~vaultquery-calendar
SELECT
  due_date as date,
  task_text as title,
  path
FROM tasks
WHERE due_date IS NOT NULL
ORDER BY due_date;
~~~

## Weekly calendar

Week and Day views show an hour axis only when events include times.

~~~vaultquery-calendar
SELECT
  due_date as date,
  task_text as title,
  path,
  status as description
FROM tasks
WHERE due_date IS NOT NULL
ORDER BY due_date;

config:
initialView: timeGridWeek
initialDate: 2026-04-20
firstDay: 0
~~~

## Daily calendar

~~~vaultquery-calendar
SELECT
  due_date as date,
  task_text as title,
  path,
  status as description
FROM tasks
WHERE due_date IS NOT NULL
ORDER BY due_date;

config:
initialView: timeGridDay
initialDate: 2026-04-21
~~~

## Calendar with colors and descriptions

~~~vaultquery-calendar
SELECT
  due_date as date,
  done_date as end_date,
  task_text as title,
  path,
  status as description,
  CASE
    WHEN status = 'DONE' THEN '#22c55e'
    WHEN priority = 'high' THEN '#ef4444'
    ELSE '#3b82f6'
  END as backgroundColor,
  CASE
    WHEN priority = 'high' THEN '#ffffff'
    WHEN status = 'DONE' THEN '#052e16'
    ELSE '#ffffff'
  END as color
FROM tasks
WHERE due_date IS NOT NULL
ORDER BY due_date;

config:
weekNumbers: true
~~~

## Calendar result columns

| Column            | Description                             |
| ----------------- | --------------------------------------- |
| `date`            | Required. Event start date              |
| `end_date`        | Inclusive end date for date-only ranges |
| `title`           | Event title. Defaults to the date       |
| `description`     | Tooltip text                            |
| `path`            | Note path to open on click              |
| `backgroundColor` | Event background color                  |
| `borderColor`     | Event border color                      |
| `color`           | Event label color                       |
| `allDay`          | Defaults to `true`                      |

Dates accept ISO dates, datetimes, parseable date strings, or Unix timestamps. Reversed ranges are swapped.

## Calendar config options

| Setting             | Description                                                                             | Examples                                          |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `initialView`       | Also accepts `month`, `week`, and `day`                                                 | **`dayGridMonth`**, `timeGridWeek`, `timeGridDay` |
| `initialDate`       | `first` selects the earliest event; `last` selects the latest                           | `2026-04-21`, `first`, `last`                     |
| `height`            | Includes the toolbar; pixels or CSS size                                                | **`auto`**, `600`, `70vh`                         |
| `contentHeight`     | Excludes the toolbar; pixels or CSS size                                                | `500`, `60vh`                                     |
| `aspectRatio`       | Width divided by height when height is not fixed                                        | `1.5`                                             |
| `expandRows`        | Expands rows to fill the available height                                               | `true`, `false`                                   |
| `firstDay`          | 0 = Sunday through 6 = Saturday                                                         | **`0`**, `1`                                      |
| `weekNumbers`       |                                                                                         | **`false`**, `true`                               |
| `visibleWeeks`      | Week rows shown by the Month button. Omit for the full month.                           | `1`, `3`, `6`                                     |
| `mobileVisibleDays` | Visible day columns on narrow screens. Month and Week navigation advance by this count. | `1`, `3`, `7`                                     |
| `skipBlankPeriods`  | Previous and next skip periods without events                                           | **`false`**, `true`                               |
| `dayMaxEvents`      | Events per month cell before overflow. `true` fits the available height.                | **`true`**, `3`                                   |
| `dayMaxEventRows`   | Event rows per day cell before overflow                                                 | `true`, `3`                                       |
| `dayMinHeight`      | Month day-cell height in pixels                                                         | `100`                                             |
| `eventMaxStack`     | Stacked events in time grid views before overflow                                       | `3`                                               |
| `slotMinTime`       | Earliest visible time in week and day views                                             | `08:00:00`                                        |
| `slotMaxTime`       | Latest visible time in week and day views                                               | `18:00:00`                                        |
| `slotDuration`      | Time interval in week and day views                                                     | `00:30:00`                                        |
| `autoRefresh`       | Reruns when indexed files change. Defaults to the global setting.                       | `true`, `false`                                   |
