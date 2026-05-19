# Calendar output

`vaultquery-calendar` renders query results with [FullCalendar](https://fullcalendar.io/). `vaultquery-calendar-help` shows the calendar reference. The toolbar supports month, week, and day views.

Calendar events open notes when the query returns a `path` column. Events without `path` still render with tooltips.

VaultQuery tooltips show event title, date range, and description.

`backgroundColor` and `borderColor` style event surfaces. `color` styles event labels. Source columns with different names should be aliased in SQL.

## Dated list items to calendar events

- 2005-09-20 - The Dundies
	- Make reservation at Chili's
	- Figure out what OPP stands for
- 2006-05-11 - Casino Night
	- Invite Jan
  - Invite Carol as a backup
- 2007-04-12 - Safety Training
	- Count jelly beans
	- ~~Rent trampoline~~
  - Rent bouncy castle
- 2007-05-10 - Beach Games
	- Hot dog eating contest
  - Sumo-suit competitions
	- Hot coal walk

Dated parent bullets provide dates. Indented child bullets become calendar events. The returned `path` column makes each event clickable.

```vaultquery-calendar
SELECT
  substr(parent_content, 1, 10) as date,
  content as title,
  substr(parent_content, 14) as description,
  path,
  CASE
    WHEN parent_content LIKE '%The Dundies' THEN '#ec4899'
    WHEN parent_content LIKE '%Office follow-up' THEN '#6366f1'
    WHEN parent_content LIKE '%Casino Night' THEN '#22c55e'
    WHEN parent_content LIKE '%Safety Training' THEN '#f59e0b'
    ELSE '#3b82f6'
  END as backgroundColor,
  CASE
    WHEN parent_content LIKE '%Casino Night' THEN '#052e16'
    WHEN parent_content LIKE '%Safety Training' THEN '#451a03'
    ELSE '#ffffff'
  END as color
FROM list_items_view
WHERE path = '{this.path}'
  AND indent_level = 1
  AND parent_content GLOB '????-??-?? - *'
ORDER BY date, parent_content, line_number;

config:
initialView: dayGridMonth
initialDate: 2005-09-01
weekNumbers: true
visibleWeeks: 2
mobileVisibleDays: 3
dayMaxEvents: 2
dayMaxEventRows: 3
dayMinHeight: 120
aspectRatio: 1.6
```

On phones, `mobileVisibleDays: 3` keeps the Month button available and makes month/week grids horizontally scroll. `visibleWeeks: 2` limits the displayed rows.

## Weekly view

`initialView: timeGridWeek` opens the weekly time-grid view. All-day events appear at the top of the week.

```vaultquery-calendar
SELECT
  substr(parent_content, 1, 10) as date,
  content as title,
  substr(parent_content, 14) as description,
  path,
  '#ec4899' as backgroundColor,
  '#ffffff' as color
FROM list_items_view
WHERE path = '{this.path}'
  AND indent_level = 1
  AND parent_content GLOB '????-??-?? - *'
ORDER BY date, parent_content, line_number;

config:
initialView: timeGridWeek
initialDate: 2005-09-20
firstDay: 0
contentHeight: 650
expandRows: true
eventMaxStack: 3
slotMinTime: 08:00:00
slotMaxTime: 18:00:00
slotDuration: 00:30:00
```

## Daily view

`initialView: timeGridDay` opens a single-day view.

```vaultquery-calendar
SELECT
  substr(parent_content, 1, 10) as date,
  content as title,
  substr(parent_content, 14) as description,
  path,
  '#ec4899' as backgroundColor,
  '#ffffff' as color
FROM list_items_view
WHERE path = '{this.path}'
  AND indent_level = 1
  AND parent_content LIKE '2005-09-20 - %'
ORDER BY parent_content, line_number;

config:
initialView: timeGridDay
initialDate: 2005-09-20
height: auto
contentHeight: 600
slotMinTime: 08:00:00
slotMaxTime: 18:00:00
```

## Generated events without note links

Calendar events can come directly from SQL values. Without a `path` column, events are not note links.

```vaultquery-calendar
WITH events(date, title, description, backgroundColor, color) AS (
  VALUES
    ('2005-03-24', 'Basketball', 'Warehouse versus office', '#f97316', '#431407'),
    ('2005-04-26', 'Hot Girl', 'Katy to sell purses in the conference room', '#06b6d4', '#083344'),
    ('2005-09-20', 'The Dundies', 'Annual Dundie Awards at Chili''s', '#ec4899', '#ffffff'),
    ('2005-09-20', 'Party Planning follow-up', 'Angela reviews the post-Dundies budget', '#6366f1', '#ffffff'),
    ('2005-09-20', 'Emergency binder update', 'Dwight adds a Chili''s incident appendix', '#f59e0b', '#451a03')
)
SELECT date, title, description, backgroundColor, color
FROM events
ORDER BY date;

config:
initialView: dayGridMonth
initialDate: 2005-09-01
```

## Aliasing event columns

Source columns with different names can be aliased to calendar result columns (`date`, `title`, `description`, `path`, etc.):

```vaultquery-calendar
SELECT
  substr(parent_content, 1, 10) as date,
  content as title,
  substr(parent_content, 14) as description,
  path
FROM list_items_view
WHERE path = '{this.path}'
  AND indent_level = 1
  AND parent_content GLOB '????-??-?? - *'
ORDER BY date, parent_content, line_number;

config:
initialView: dayGridMonth
initialDate: 2005-09-01
firstDay: 1
dayMaxEvents: 2
```
