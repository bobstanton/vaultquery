---
id: vaultquery-calendar-help
title: VaultQuery Calendar Help
---

# Calendar output

Use `vaultquery-calendar` to render query results as calendars. Each result row becomes one calendar item. At minimum, the query must return a date column.

Calendar output uses [FullCalendar Standard](https://fullcalendar.io/). It defaults to month view with weeks displayed Sunday through Saturday. The toolbar can switch between month, week, and day views.

## Calendar result columns

| Column            | Description |
|-------------------|-------------|
| `date`            | Event start date. Required |
| `end_date`        | Optional inclusive date-only end date for multi-day spans |
| `title`           | Event title. Defaults to the date when omitted |
| `description`     | Optional tooltip/details text |
| `path`            | Optional note path. When present, clicking the event opens the note |
| `backgroundColor` | Optional event background color |
| `borderColor`     | Optional event border color |
| `color`           | Optional event label color |
| `allDay`          | Optional boolean. Defaults to `true` |

Date values can be ISO dates (`YYYY-MM-DD`), ISO datetimes, parseable date strings, or Unix timestamps. VaultQuery preserves timed values when they include a time component. `end_date` is inclusive for date-only ranges, so `date: 2026-04-21` with `end_date: 2026-04-24` renders through April 24. If `end_date` is earlier than `date`, VaultQuery swaps the range endpoints.

Return `backgroundColor`, `borderColor`, and `color` to match CSS-style naming for event background, border, and label colors. Alias SQL columns to those names when needed.

## Calendar config options

| Option              | Description |
|---------------------|-------------|
| `initialView`       | FullCalendar initial view: `dayGridMonth` (default), `timeGridWeek`, or `timeGridDay`. Short aliases `month`, `week`, and `day` also work |
| `initialDate`       | Initial date to display, as `YYYY-MM-DD`, `first`, or `last`. `first` uses the earliest event date; `last` uses the latest event date |
| `height`            | FullCalendar height for the whole calendar. Use `auto` (default), a number of pixels, or a CSS size like `70vh` |
| `contentHeight`     | FullCalendar content area height, excluding the toolbar |
| `aspectRatio`       | Width-to-height ratio used by FullCalendar when height is not fixed |
| `expandRows`        | FullCalendar row expansion: `true` or `false` |
| `firstDay`          | FullCalendar week start day: `0` = Sunday (default) through `6` = Saturday |
| `weekNumbers`       | FullCalendar week number display: `true` or `false` |
| `visibleWeeks`      | Number of week rows shown by the Month toolbar button. Use `1` through `6`; omitted means the normal FullCalendar month range |
| `mobileVisibleDays` | On narrow screens, target this many visible day columns at once and page Month/Week forward by that many days. Use `1` through `7` |
| `skipBlankPeriods`  | Replace toolbar previous/next navigation with jumps to the nearest earlier or later period that contains events. Defaults to `false` |
| `dayMaxEvents`      | FullCalendar maximum events to show in month cells before overflow. Use a number or `true` |
| `dayMaxEventRows`   | FullCalendar maximum event rows in day grid cells. Use a number or `true` |
| `dayMinHeight`      | VaultQuery month day-cell minimum height in pixels |
| `eventMaxStack`     | FullCalendar maximum stacked events in time grid views |
| `slotMinTime`       | Earliest visible time in week/day views, e.g. `08:00:00` |
| `slotMaxTime`       | Latest visible time in week/day views, e.g. `18:00:00` |
| `slotDuration`      | Time slot interval in week/day views, e.g. `00:30:00` |

Calendar blocks also accept `autoRefresh`, shared by every query block: set it to `true` or `false` to re-run this calendar when indexed files change, overriding the global setting.

On narrow screens, the Month button stays available. Use `mobileVisibleDays` with `visibleWeeks` to create a horizontally scrollable compact grid. For example, `mobileVisibleDays: 3` and `visibleWeeks: 3` gives an approximately 3-by-3 viewport on portrait phones, and the Month/Week prev/next paging advances by 3 days at a time.

If the result set only contains all-day events, the Week and Day toolbar buttons switch to day-grid views so the hour axis does not waste space. If any event has a time component, Week and Day use FullCalendar time-grid views.

Events are clickable when the query returns a `path` column. Alias the note path column to `path` when needed. If no path column is returned, the event still renders and still has a tooltip, but clicking it does not open a note. Tooltips use a VaultQuery tooltip instead of the browser's native tooltip and include the event title, date range when present, and description when present.

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

## Calendar events without note links

~~~vaultquery-calendar
WITH events(date, title, description, backgroundColor, color) AS (
  VALUES
    ('2026-04-20', 'Planning meeting', 'Generated by SQL; not linked to a note', '#3b82f6', '#ffffff'),
    ('2026-04-21', 'Follow-up', 'Hover shows this tooltip, click does not open a note', '#22c55e', '#052e16')
)
SELECT date, title, description, backgroundColor, color
FROM events
ORDER BY date;

config:
initialView: dayGridMonth
initialDate: 2026-04-01
~~~
