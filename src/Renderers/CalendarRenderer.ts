import { Calendar } from '@fullcalendar/core';
import type { CalendarOptions, EventClickArg, EventInput, EventMountArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import timeGridPlugin from '@fullcalendar/timegrid';
import type { RenderContext } from './BaseRenderer';
import { parseBooleanOptionOrNull, parseCssDimensionOrNull } from '../utils/ConfigParsingUtils';

declare const activeWindow: Window;

interface CalendarEvent {
  start: string;
  end?: string;
  startDate: string;
  endDate?: string;
  title: string;
  description?: string;
  path?: string;
  backgroundColor?: string;
  borderColor?: string;
  color?: string;
  allDay: boolean;
  startHasTime: boolean;
  endHasTime: boolean;
  inclusiveEndDateOnly: boolean;
  sortOrder?: number;
}

interface CalendarConfig {
  initialView?: 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay';
  initialDate?: string;
  height?: string | number;
  contentHeight?: string | number;
  aspectRatio?: number;
  expandRows?: boolean;
  firstDay?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  weekNumbers?: boolean;
  visibleWeeks?: number;
  mobileVisibleDays?: number;
  dayMaxEvents?: boolean | number;
  dayMaxEventRows?: boolean | number;
  dayMinHeight?: number;
  eventMaxStack?: number;
  slotMinTime?: string;
  slotMaxTime?: string;
  slotDuration?: string;
  skipBlankPeriods?: boolean;
}

interface CalendarInstance {
  calendar: Calendar;
  resizeObserver?: ResizeObserver;
  intersectionObserver?: IntersectionObserver;
  animationFrames: number[];
  timeouts: ReturnType<typeof setTimeout>[];
  responsiveConfig: ResponsiveCalendarConfig;
  isMobileLayout: boolean | null;
  lastDesktopView: string | null;
}

interface CalendarReference {
  current?: Calendar;
}

interface CalendarNavigationRange {
  start: string;
  endExclusive: string;
}

interface NormalizedTemporalValue {
  value: string;
  date: string;
  hasTime: boolean;
}

interface ResponsiveCalendarConfig {
  desktopMonthViewName: string;
  mobileMonthViewName: string;
  desktopWeekViewName: string;
  mobileWeekViewName: string;
  desktopDayViewName: string;
  mobileDayViewName: string;
  requestedInitialView: NonNullable<CalendarConfig['initialView']>;
  skipBlankPeriods: boolean;
}

const DEFAULT_FIELDS = {
  date: ['date'],
  endDate: ['end_date', 'enddate'],
  title: ['title'],
  description: ['description'],
  path: ['path'],
  backgroundColor: ['backgroundcolor'],
  borderColor: ['bordercolor'],
  color: ['color'],
  allDay: ['allday'],
  sortOrder: ['sort_order', 'sortorder'],
} as const;

export class CalendarRenderer {
  private static instances = new WeakMap<HTMLElement, CalendarInstance>();
  private static readonly VISIBLE_WEEKS_VIEW = 'vaultqueryDayGridWeeks';
  private static readonly MOBILE_MONTH_VIEW = 'vaultqueryMobileDayGridMonth';
  private static readonly MOBILE_VISIBLE_WEEKS_VIEW = 'vaultqueryMobileDayGridWeeks';
  private static readonly ALL_DAY_WEEK_VIEW = 'vaultqueryDayGridWeek';
  private static readonly MOBILE_ALL_DAY_WEEK_VIEW = 'vaultqueryMobileDayGridWeek';
  private static readonly ALL_DAY_DAY_VIEW = 'vaultqueryDayGridDay';
  private static readonly MOBILE_TIME_GRID_WEEK_VIEW = 'vaultqueryMobileTimeGridWeek';
  private static readonly MOBILE_TIME_GRID_DAY_VIEW = 'vaultqueryMobileTimeGridDay';
  private static readonly MOBILE_BREAKPOINT_PX = 720;

  static parseConfig(options?: Record<string, unknown>): CalendarConfig {
    const config: CalendarConfig = {};
    const set = <K extends keyof CalendarConfig>(key: K, value: CalendarConfig[K] | null) => {
      if (value !== null) config[key] = value;
    };

    if (typeof options?.initialview === 'string') config.initialView = this.parseInitialView(options.initialview);
    if (typeof options?.initialdate === 'string') config.initialDate = options.initialdate.trim();

    set('height', parseCssDimensionOrNull(options?.height, {
      allowNumber: true,
      allowAuto: true,
      bareNumber: 'number',
      units: ['px', 'em', 'rem', 'vh', 'vw', '%'],
    }));
    set('contentHeight', parseCssDimensionOrNull(options?.contentheight, {
      allowNumber: true,
      allowAuto: true,
      bareNumber: 'number',
      units: ['px', 'em', 'rem', 'vh', 'vw', '%'],
    }));

    const aspectRatio = this.parseNumberOption(options?.aspectratio);
    if (aspectRatio !== null && aspectRatio > 0) set('aspectRatio', aspectRatio);

    set('expandRows', parseBooleanOptionOrNull(options?.expandrows));

    const firstDay = this.parseBoundedIntegerOption(options?.firstday, 0, 6);
    if (firstDay !== null) set('firstDay', firstDay as CalendarConfig['firstDay']);

    set('weekNumbers', parseBooleanOptionOrNull(options?.weeknumbers));

    set('visibleWeeks', this.parseBoundedIntegerOption(options?.visibleweeks, 1, 6));

    set('mobileVisibleDays', this.parseBoundedIntegerOption(options?.mobilevisibledays, 1, 7));

    set('dayMaxEvents', this.parseIntegerOrBooleanOption(options?.daymaxevents, 0));

    set('dayMaxEventRows', this.parseIntegerOrBooleanOption(options?.daymaxeventrows, 0));

    set('dayMinHeight', this.parseBoundedIntegerOption(options?.dayminheight, 40));

    set('eventMaxStack', this.parseBoundedIntegerOption(options?.eventmaxstack, 0));

    set('slotMinTime', this.parseDurationOption(options?.slotmintime));
    set('slotMaxTime', this.parseDurationOption(options?.slotmaxtime));
    set('slotDuration', this.parseDurationOption(options?.slotduration));
    set('skipBlankPeriods', parseBooleanOptionOrNull(options?.skipblankperiods));

    return config;
  }

  static render(context: RenderContext, config: CalendarConfig): void {
    const { container, results, openFile } = context;

    this.destroyExistingInstance(container);
    container.empty();

    if (!results.length) {
      container.createDiv({
        cls: 'vaultquery-empty',
        text: 'Query returned no results'
      });
      return;
    }

    const normalized = this.normalizeResults(results);
    const root = container.createDiv({ cls: 'vaultquery-calendar-root' });
    root.setCssProps({
      '--vaultquery-calendar-day-min-height': `${config.dayMinHeight ?? 120}px`,
    });
    if (config.visibleWeeks) {
      root.dataset.vaultqueryCalendarVisibleWeeks = String(config.visibleWeeks);
    }

    const calendarRef: CalendarReference = {};
    const { options, responsiveConfig } = this.createCalendarOptions(normalized, config, openFile, root, calendarRef);
    const calendar = new Calendar(root, options);
    calendarRef.current = calendar;
    calendar.render();

    const instance: CalendarInstance = {
      calendar,
      animationFrames: [],
      timeouts: [],
      responsiveConfig,
      isMobileLayout: null,
      lastDesktopView: null,
    };

    this.instances.set(container, instance);
    this.applyResponsiveLayout(root, instance);
    this.watchCalendarSize(container, root, instance);
    this.scheduleCalendarSizeUpdate(container, root, instance);
  }

  static cleanupContainer(container: HTMLElement): void {
    this.destroyExistingInstance(container);
    container.querySelectorAll('.vaultquery-calendar-root').forEach((root) => root.remove());
  }

  private static normalizeResults(results: Record<string, unknown>[]): CalendarEvent[] {
    const availableColumns = Object.keys(results[0]);
    const dateColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.date);

    if (!dateColumn) {
      throw new Error('Calendar output requires a date column. Alias a query column to date.');
    }

    const endDateColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.endDate);
    const titleColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.title);
    const descriptionColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.description);
    const pathColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.path);
    const backgroundColorColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.backgroundColor);
    const borderColorColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.borderColor);
    const colorColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.color);
    const allDayColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.allDay);
    const sortOrderColumn = this.resolveFieldName(availableColumns, DEFAULT_FIELDS.sortOrder);

    const events: CalendarEvent[] = [];

    for (const row of results) {
      const startValue = this.normalizeTemporalValue(row[dateColumn]);
      if (!startValue) {
        continue;
      }

      const endValue = endDateColumn ? (this.normalizeTemporalValue(row[endDateColumn]) ?? undefined) : undefined;
      const normalizedRange = this.normalizeDateRange(startValue, endValue);
      const allDay = allDayColumn
        ? this.toBoolean(row[allDayColumn])
        : (!normalizedRange.start.hasTime && !normalizedRange.end?.hasTime);

      const sortOrderValue = sortOrderColumn ? this.parseNumberOption(row[sortOrderColumn]) : null;

      events.push({
        start: normalizedRange.start.value,
        end: normalizedRange.end?.value,
        startDate: normalizedRange.start.date,
        endDate: normalizedRange.end?.date,
        title: titleColumn ? this.toDisplayString(row[titleColumn], normalizedRange.start.date) : normalizedRange.start.date,
        description: descriptionColumn ? this.toOptionalString(row[descriptionColumn]) : undefined,
        path: pathColumn ? this.toOptionalString(row[pathColumn]) : undefined,
        backgroundColor: backgroundColorColumn ? this.toOptionalColor(row[backgroundColorColumn]) : undefined,
        borderColor: borderColorColumn ? this.toOptionalColor(row[borderColorColumn]) : undefined,
        color: colorColumn ? this.toOptionalColor(row[colorColumn]) : undefined,
        allDay,
        startHasTime: normalizedRange.start.hasTime,
        endHasTime: normalizedRange.end?.hasTime ?? false,
        inclusiveEndDateOnly: allDay && !normalizedRange.start.hasTime && !normalizedRange.end?.hasTime,
        sortOrder: sortOrderValue ?? undefined,
      });
    }

    if (!events.length) {
      throw new Error('Calendar output requires at least one valid date value.');
    }

    return events;
  }

  private static createCalendarOptions(events: CalendarEvent[], config: CalendarConfig, openFile: (path: string) => void, root: HTMLElement, calendarRef: CalendarReference): { options: CalendarOptions; responsiveConfig: ResponsiveCalendarConfig } {
    const initialDate = this.resolveInitialDate(config.initialDate, events);
    const desktopMonthViewName = config.visibleWeeks ? this.VISIBLE_WEEKS_VIEW : 'dayGridMonth';
    const mobileMonthViewName = config.mobileVisibleDays
      ? (config.visibleWeeks ? this.MOBILE_VISIBLE_WEEKS_VIEW : this.MOBILE_MONTH_VIEW)
      : desktopMonthViewName;
    const visibleWeeks = config.visibleWeeks ?? 1;
    const firstDay = config.firstDay ?? 0;
    const hasTimedEvents = events.some((event) => !event.allDay);
    const desktopWeekViewName = hasTimedEvents ? 'timeGridWeek' : this.ALL_DAY_WEEK_VIEW;
    const mobileWeekViewName = config.mobileVisibleDays
      ? (hasTimedEvents ? this.MOBILE_TIME_GRID_WEEK_VIEW : this.MOBILE_ALL_DAY_WEEK_VIEW)
      : desktopWeekViewName;
    const desktopDayViewName = hasTimedEvents ? 'timeGridDay' : this.ALL_DAY_DAY_VIEW;
    const mobileDayViewName = config.mobileVisibleDays && hasTimedEvents
      ? this.MOBILE_TIME_GRID_DAY_VIEW
      : desktopDayViewName;
    const requestedInitialView = config.initialView ?? 'dayGridMonth';
    const responsiveConfig: ResponsiveCalendarConfig = {
      desktopMonthViewName,
      mobileMonthViewName,
      desktopWeekViewName,
      mobileWeekViewName,
      desktopDayViewName,
      mobileDayViewName,
      requestedInitialView,
      skipBlankPeriods: config.skipBlankPeriods ?? false,
    };
    const initialView = this.resolvePreferredView(false, responsiveConfig);

    const options: CalendarOptions = {
      plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
      initialView,
      initialDate,
      firstDay,
      weekNumbers: config.weekNumbers ?? false,
      headerToolbar: this.getHeaderToolbar(false, responsiveConfig),
      buttonText: {
        today: 'Today',
        month: 'Month',
        week: 'Week',
        day: 'Day'
      },
      views: {
        ...(config.visibleWeeks
          ? {
            [this.VISIBLE_WEEKS_VIEW]: {
              type: 'dayGrid',
              duration: { weeks: visibleWeeks },
              dateAlignment: 'week',
              dateIncrement: { weeks: visibleWeeks },
              buttonText: 'Month',
              fixedWeekCount: false,
            }
          }
          : {}),
        ...(config.mobileVisibleDays
          ? {
            [this.MOBILE_MONTH_VIEW]: {
              type: 'dayGrid',
              duration: { days: config.mobileVisibleDays },
              dateIncrement: { days: config.mobileVisibleDays },
              buttonText: 'Month',
            },
            [this.MOBILE_VISIBLE_WEEKS_VIEW]: {
              type: 'dayGrid',
              duration: { days: config.mobileVisibleDays },
              dateIncrement: { days: config.mobileVisibleDays },
              buttonText: 'Month',
            }
          }
          : {}),
        ...(!hasTimedEvents
          ? {
            [this.ALL_DAY_WEEK_VIEW]: {
              type: 'dayGrid',
              duration: { weeks: 1 },
              dateAlignment: 'week',
              dateIncrement: { weeks: 1 },
              buttonText: 'Week',
            },
            [this.ALL_DAY_DAY_VIEW]: {
              type: 'dayGrid',
              duration: { days: 1 },
              dateIncrement: { days: 1 },
              buttonText: 'Day',
            }
          }
          : {}),
        ...(config.mobileVisibleDays
          ? (hasTimedEvents
            ? {
              [this.MOBILE_TIME_GRID_WEEK_VIEW]: {
                type: 'timeGrid',
                duration: { days: config.mobileVisibleDays },
                dateIncrement: { days: config.mobileVisibleDays },
                buttonText: 'Week',
              },
              [this.MOBILE_TIME_GRID_DAY_VIEW]: {
                type: 'timeGrid',
                duration: { days: 1 },
                dateIncrement: { days: 1 },
                buttonText: 'Day',
              }
            }
            : {
              [this.MOBILE_ALL_DAY_WEEK_VIEW]: {
                type: 'dayGrid',
                duration: { days: config.mobileVisibleDays },
                dateIncrement: { days: config.mobileVisibleDays },
                buttonText: 'Week',
              }
            })
          : {})
      },
      events: events.map((event) => this.toEventInput(event)),
      ...(config.skipBlankPeriods
        ? { customButtons: this.createSkipBlankPeriodButtons(events, calendarRef) }
        : {}),
      eventOrder: events.some((e) => e.sortOrder !== undefined)
        ? 'order,start,-duration,allDay,title'
        : 'start,-duration,allDay,title',
      dayMaxEvents: config.dayMaxEvents ?? true,
      moreLinkClick: 'popover',
      navLinks: false,
      height: config.height ?? 'auto',
      fixedWeekCount: false,
      showNonCurrentDates: true,
      displayEventTime: hasTimedEvents,
      eventClick: (info) => this.handleEventClick(info, openFile),
      eventDidMount: (info) => this.handleEventDidMount(info),
      eventWillUnmount: (info) => this.hideTooltip(info.el),
      viewDidMount: ({ view }) => {
        root.dataset.vaultqueryCalendarView = view.type;
      },
      datesSet: ({ view }) => {
        root.dataset.vaultqueryCalendarView = view.type;
      },
    };

    if (config.dayMaxEventRows !== undefined) options.dayMaxEventRows = config.dayMaxEventRows;
    if (config.eventMaxStack !== undefined) options.eventMaxStack = config.eventMaxStack;
    if (config.contentHeight !== undefined) options.contentHeight = config.contentHeight;
    if (config.aspectRatio !== undefined) options.aspectRatio = config.aspectRatio;
    if (config.expandRows !== undefined) options.expandRows = config.expandRows;
    if (config.slotMinTime !== undefined) options.slotMinTime = config.slotMinTime;
    if (config.slotMaxTime !== undefined) options.slotMaxTime = config.slotMaxTime;
    if (config.slotDuration !== undefined) options.slotDuration = config.slotDuration;

    if (!config.visibleWeeks && !config.mobileVisibleDays && hasTimedEvents) {
      delete options.views;
    } else if (
      !config.visibleWeeks &&
      !config.mobileVisibleDays &&
      options.views &&
      !(this.ALL_DAY_WEEK_VIEW in options.views)
    ) {
      delete options.views;
    }

    return { options, responsiveConfig };
  }

  private static watchCalendarSize(container: HTMLElement, root: HTMLElement, instance: CalendarInstance): void {
    const ResizeObserverCtor = root.ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserverCtor) {
      instance.resizeObserver = new ResizeObserverCtor((entries) => {
        if (entries.some(entry => entry.contentRect.width > 0)) {
          this.scheduleCalendarSizeUpdate(container, root, instance);
        }
      });
      instance.resizeObserver.observe(root);
      instance.resizeObserver.observe(container);
    }

    const IntersectionObserverCtor = root.ownerDocument.defaultView?.IntersectionObserver;
    if (IntersectionObserverCtor) {
      instance.intersectionObserver = new IntersectionObserverCtor((entries) => {
        if (entries.some(entry => entry.isIntersecting)) {
          this.scheduleCalendarSizeUpdate(container, root, instance);
        }
      }, { threshold: 0, rootMargin: '100px' });
      instance.intersectionObserver.observe(root);
    }
  }

  private static scheduleCalendarSizeUpdate(container: HTMLElement, root: HTMLElement, instance: CalendarInstance): void {
    const win = root.ownerDocument.defaultView ?? activeWindow;
    const delays = [0, 50, 150, 350];

    this.clearScheduledCalendarSizeUpdates(root, instance);

    const update = () => {
      if (!root.isConnected || this.instances.get(container) !== instance) {
        return;
      }

      this.applyResponsiveLayout(root, instance);
      instance.calendar.updateSize();

      if (root.offsetWidth === 0) {
        return;
      }

      instance.calendar.updateSize();
    };

    const rafId = win.requestAnimationFrame(() => {
      update();
      const nestedRafId = win.requestAnimationFrame(update);
      instance.animationFrames.push(nestedRafId);
    });
    instance.animationFrames.push(rafId);

    for (const delay of delays) {
      const timeoutId = win.setTimeout(update, delay);
      instance.timeouts.push(timeoutId);
    }
  }

  private static clearScheduledCalendarSizeUpdates(root: HTMLElement, instance: CalendarInstance): void {
    const win = root.ownerDocument.defaultView ?? activeWindow;

    for (const frame of instance.animationFrames) {
      win.cancelAnimationFrame(frame);
    }
    instance.animationFrames = [];

    for (const timeout of instance.timeouts) {
      win.clearTimeout(timeout);
    }
    instance.timeouts = [];
  }

  private static parseInitialView(value: string): CalendarConfig['initialView'] {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'timegridweek' || normalized === 'week') {
      return 'timeGridWeek';
    }

    if (normalized === 'timegridday' || normalized === 'day') {
      return 'timeGridDay';
    }

    if (normalized === 'daygridmonth' || normalized === 'month') {
      return 'dayGridMonth';
    }

    return 'dayGridMonth';
  }

  private static applyResponsiveLayout(root: HTMLElement, instance: CalendarInstance): void {
    const isMobile = this.shouldUseMobileLayout(root);
    const currentView = instance.calendar.view.type;
    const preferredView = this.resolvePreferredView(isMobile, instance.responsiveConfig);

    root.dataset.vaultqueryCalendarLayout = isMobile ? 'mobile' : 'desktop';
    instance.calendar.setOption('headerToolbar', this.getHeaderToolbar(isMobile, instance.responsiveConfig));

    if (!isMobile && instance.isMobileLayout === true) {
      const restoreView = instance.lastDesktopView ?? preferredView;
      if (currentView !== restoreView) {
        instance.calendar.changeView(restoreView, instance.calendar.getDate());
      }
    } else if (isMobile) {
      if (currentView === instance.responsiveConfig.desktopMonthViewName) {
        instance.lastDesktopView = currentView;
        instance.calendar.changeView(preferredView, instance.calendar.getDate());
      } else if (instance.isMobileLayout !== true && currentView !== preferredView) {
        instance.lastDesktopView = currentView;
        instance.calendar.changeView(preferredView, instance.calendar.getDate());
      }
    } else if (currentView !== preferredView && instance.isMobileLayout === null) {
      instance.calendar.changeView(preferredView, instance.calendar.getDate());
    }

    if (
      !isMobile &&
      currentView !== instance.responsiveConfig.desktopDayViewName &&
      currentView !== instance.responsiveConfig.desktopWeekViewName
    ) {
      instance.lastDesktopView = currentView;
    }

    instance.isMobileLayout = isMobile;
  }

  private static shouldUseMobileLayout(root: HTMLElement): boolean {
    const win = root.ownerDocument.defaultView ?? activeWindow;
    const viewportWidth = win.innerWidth;
    const containerWidth = root.getBoundingClientRect().width;
    const effectiveWidth = containerWidth > 0 ? Math.min(viewportWidth, containerWidth) : viewportWidth;
    return effectiveWidth <= this.MOBILE_BREAKPOINT_PX;
  }

  private static resolvePreferredView(isMobile: boolean, responsiveConfig: ResponsiveCalendarConfig): string {
    if (isMobile) {
      if (responsiveConfig.requestedInitialView === 'dayGridMonth') {
        return responsiveConfig.mobileMonthViewName;
      }

      if (responsiveConfig.requestedInitialView === 'timeGridWeek') {
        return responsiveConfig.mobileWeekViewName;
      }

      return responsiveConfig.mobileDayViewName;
    }

    if (responsiveConfig.requestedInitialView === 'dayGridMonth') {
      return responsiveConfig.desktopMonthViewName;
    }

    if (responsiveConfig.requestedInitialView === 'timeGridWeek') {
      return responsiveConfig.desktopWeekViewName;
    }

    return responsiveConfig.desktopDayViewName;
  }

  private static getHeaderToolbar(isMobile: boolean, responsiveConfig: ResponsiveCalendarConfig): CalendarOptions['headerToolbar'] {
    const navigationButtons = responsiveConfig.skipBlankPeriods
      ? 'vaultqueryPrev,vaultqueryNext today'
      : 'prev,next today';

    return {
      left: navigationButtons,
      center: 'title',
      right: isMobile
        ? `${responsiveConfig.mobileMonthViewName},${responsiveConfig.mobileWeekViewName},${responsiveConfig.mobileDayViewName}`
        : `${responsiveConfig.desktopMonthViewName},${responsiveConfig.desktopWeekViewName},${responsiveConfig.desktopDayViewName}`
    };
  }

  private static createSkipBlankPeriodButtons(events: CalendarEvent[], calendarRef: CalendarReference): NonNullable<CalendarOptions['customButtons']> {
    return {
      vaultqueryPrev: {
        icon: 'chevron-left',
        hint: 'Previous period with events',
        click: () => this.navigateToAdjacentEventPeriod(calendarRef.current, events, -1),
      },
      vaultqueryNext: {
        icon: 'chevron-right',
        hint: 'Next period with events',
        click: () => this.navigateToAdjacentEventPeriod(calendarRef.current, events, 1),
      },
    };
  }

  private static navigateToAdjacentEventPeriod(calendar: Calendar | undefined, events: CalendarEvent[], direction: -1 | 1): void {
    if (!calendar) {
      return;
    }

    const targetDate = this.findAdjacentEventDate(calendar, events, direction);
    if (targetDate) {
      calendar.gotoDate(targetDate);
    }
  }

  private static findAdjacentEventDate(calendar: Calendar, events: CalendarEvent[], direction: -1 | 1): string | null {
    const currentStart = this.formatDate(calendar.view.currentStart);
    const currentEnd = this.formatDate(calendar.view.currentEnd);
    const eventRanges = events
      .map(event => this.toNavigationRange(event))
      .sort((left, right) => left.start.localeCompare(right.start));

    if (direction > 0) {
      const targetDates = eventRanges
        .filter(range => range.endExclusive > currentEnd)
        .map(range => range.start < currentEnd ? currentEnd : range.start)
        .sort((left, right) => left.localeCompare(right));
      return targetDates[0] ?? null;
    }

    const targetDates = eventRanges
      .filter(range => range.start < currentStart)
      .map((range) => {
        const rangeLastDate = this.addDays(range.endExclusive, -1);
        return rangeLastDate >= currentStart
          ? this.addDays(currentStart, -1)
          : rangeLastDate;
      })
      .sort((left, right) => right.localeCompare(left));

    return targetDates[0] ?? null;
  }

  private static toNavigationRange(event: CalendarEvent): CalendarNavigationRange {
    return {
      start: event.startDate,
      endExclusive: this.addDays(event.endDate ?? event.startDate, 1),
    };
  }

  private static toEventInput(event: CalendarEvent): EventInput {
    const eventInput: EventInput = {
      title: event.title,
      start: event.start,
      allDay: event.allDay,
      classNames: event.path
        ? ['vaultquery-calendar-event-clickable']
        : ['vaultquery-calendar-event-static'],
      extendedProps: {
        description: event.description,
        path: event.path,
        tooltip: this.buildEventTooltip(event),
        textColor: event.color,
      },
    };

    if (event.sortOrder !== undefined) {
      eventInput.order = event.sortOrder;
    }

    if (event.end) {
      eventInput.end = event.inclusiveEndDateOnly && event.endDate
        ? this.addDays(event.endDate, 1)
        : event.end;
    }

    if (event.backgroundColor) {
      eventInput.backgroundColor = event.backgroundColor;
    }

    if (event.borderColor) {
      eventInput.borderColor = event.borderColor;
    } else if (event.backgroundColor) {
      eventInput.borderColor = event.backgroundColor;
    }

    if (event.color) {
      eventInput.textColor = event.color;
    }

    return eventInput;
  }

  private static handleEventClick(info: EventClickArg, openFile: (path: string) => void): void {
    info.jsEvent.preventDefault();

    const path = typeof info.event.extendedProps.path === 'string'
      ? info.event.extendedProps.path
      : null;

    if (!path) {
      return;
    }

    openFile(path);
  }

  private static handleEventDidMount(info: EventMountArg): void {
    const textColor = typeof info.event.extendedProps.textColor === 'string'
      ? info.event.extendedProps.textColor
      : null;
    if (textColor) {
      info.el.setCssProps({
        '--vaultquery-calendar-event-text-color': textColor,
      });
      info.el.querySelector<HTMLElement>('.fc-event-main')?.addClass('vaultquery-calendar-event-text-custom');
    }

    const tooltip = typeof info.event.extendedProps.tooltip === 'string'
      ? info.event.extendedProps.tooltip
      : info.event.title;

    info.el.removeAttribute('title');
    info.el.setAttribute('aria-label', tooltip);
    info.el.dataset.vaultqueryCalendarTooltip = tooltip;

    const win = info.el.ownerDocument.defaultView ?? activeWindow;
    let showTimeout: number | null = null;

    const show = () => {
      if (showTimeout) {
        win.clearTimeout(showTimeout);
      }
      showTimeout = win.setTimeout(() => {
        this.showTooltip(info.el, tooltip);
      }, 80);
    };

    const hide = () => {
      if (showTimeout) {
        win.clearTimeout(showTimeout);
        showTimeout = null;
      }
      this.hideTooltip(info.el);
    };

    const reposition = () => {
      this.positionTooltip(info.el);
    };

    info.el.addEventListener('mouseenter', show);
    info.el.addEventListener('mouseleave', hide);
    info.el.addEventListener('focus', show);
    info.el.addEventListener('blur', hide);
    info.el.addEventListener('mousemove', reposition);
  }

  private static showTooltip(anchor: HTMLElement, text: string): void {
    const doc = anchor.ownerDocument;
    const existing = doc.querySelector<HTMLElement>('.vaultquery-calendar-tooltip');
    existing?.remove();

    const tooltip = doc.createElement('div');
    tooltip.className = 'vaultquery-calendar-tooltip';
    tooltip.textContent = text;
    tooltip.setAttribute('role', 'tooltip');
    doc.body.appendChild(tooltip);
    anchor.dataset.vaultqueryCalendarTooltipVisible = 'true';
    this.positionTooltip(anchor, tooltip);
  }

  private static hideTooltip(anchor: HTMLElement): void {
    delete anchor.dataset.vaultqueryCalendarTooltipVisible;
    anchor.ownerDocument.querySelector('.vaultquery-calendar-tooltip')?.remove();
  }

  private static positionTooltip(anchor: HTMLElement, tooltip?: HTMLElement | null): void {
    if (anchor.dataset.vaultqueryCalendarTooltipVisible !== 'true') {
      return;
    }

    const doc = anchor.ownerDocument;
    const tooltipEl = tooltip ?? doc.querySelector<HTMLElement>('.vaultquery-calendar-tooltip');
    const win = doc.defaultView;
    if (!tooltipEl || !win) {
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    const maxLeft = win.innerWidth - tooltipRect.width - margin;
    const top = rect.top >= tooltipRect.height + gap + margin
      ? rect.top - tooltipRect.height - gap
      : rect.bottom + gap;
    const left = Math.min(Math.max(rect.left, margin), Math.max(margin, maxLeft));

    tooltipEl.setCssProps({
      '--vaultquery-calendar-tooltip-left': `${left}px`,
      '--vaultquery-calendar-tooltip-top': `${Math.min(Math.max(top, margin), win.innerHeight - tooltipRect.height - margin)}px`,
    });
  }

  private static resolveFieldName(availableColumns: string[], defaultNames: readonly string[]): string | undefined {
    return availableColumns.find(column => defaultNames.includes(column.toLowerCase()));
  }

  private static resolveInitialDate(configInitialDate: string | undefined, events: CalendarEvent[]): string | undefined {
    const sortedStartDates = events
      .map(event => event.startDate)
      .sort((left, right) => left.localeCompare(right));

    if (configInitialDate) {
      const normalizedKeyword = configInitialDate.trim().toLowerCase();
      if (normalizedKeyword === 'first') {
        return sortedStartDates[0];
      }
      if (normalizedKeyword === 'last') {
        return sortedStartDates[sortedStartDates.length - 1];
      }

      const normalizedInitialDate = this.normalizeTemporalValue(configInitialDate)?.date ?? null;
      if (normalizedInitialDate) {
        return normalizedInitialDate;
      }
    }

    return sortedStartDates[0];
  }

  private static normalizeDateRange(start: NormalizedTemporalValue, end?: NormalizedTemporalValue): { start: NormalizedTemporalValue; end?: NormalizedTemporalValue } {
    if (!end || end.value === start.value) {
      return { start };
    }

    return this.toComparableTime(end) < this.toComparableTime(start)
      ? { start: end, end: start }
      : { start, end };
  }

  private static normalizeTemporalValue(value: unknown): NormalizedTemporalValue | null {
    if (value == null) {
      return null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return this.normalizeTimestamp(value);
    }

    const stringValue = String(value).trim();
    if (!stringValue) {
      return null;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
      return this.isValidIsoDate(stringValue)
        ? { value: stringValue, date: stringValue, hasTime: false }
        : null;
    }

    if (/^\d{10}$/.test(stringValue) || /^\d{13}$/.test(stringValue)) {
      return this.normalizeTimestamp(Number(stringValue));
    }

    const isoDateTimeMatch = stringValue.match(/^(\d{4}-\d{2}-\d{2})([T\s]\d{2}:\d{2}(?::\d{2})?)?/);
    if (isoDateTimeMatch && this.isValidIsoDate(isoDateTimeMatch[1])) {
      const parsedIso = new Date(stringValue);
      if (!Number.isNaN(parsedIso.getTime())) {
        return isoDateTimeMatch[2]
          ? this.formatDateTime(parsedIso)
          : { value: isoDateTimeMatch[1], date: isoDateTimeMatch[1], hasTime: false };
      }
    }

    const parsed = new Date(stringValue);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return this.hasExplicitTime(stringValue)
      ? this.formatDateTime(parsed)
      : {
        value: this.formatDate(parsed),
        date: this.formatDate(parsed),
        hasTime: false,
      };
  }

  private static normalizeTimestamp(value: number): NormalizedTemporalValue | null {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
    const parsed = new Date(milliseconds);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return this.formatDateTime(parsed);
  }

  private static formatDate(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private static formatDateTime(value: Date): NormalizedTemporalValue {
    const date = this.formatDate(value);
    const hours = String(value.getHours()).padStart(2, '0');
    const minutes = String(value.getMinutes()).padStart(2, '0');
    const seconds = String(value.getSeconds()).padStart(2, '0');
    return {
      value: `${date}T${hours}:${minutes}:${seconds}`,
      date,
      hasTime: true,
    };
  }

  private static addDays(value: string, days: number): string {
    const date = new Date(`${value}T00:00:00`);
    date.setDate(date.getDate() + days);
    return this.formatDate(date);
  }

  private static isValidIsoDate(value: string): boolean {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  private static toDisplayString(value: unknown, fallback: string): string {
    const normalized = this.toOptionalString(value);
    return normalized || fallback;
  }

  private static toOptionalString(value: unknown): string | undefined {
    if (value == null) {
      return undefined;
    }

    const stringValue = String(value).trim();
    return stringValue || undefined;
  }

  private static toOptionalColor(value: unknown): string | undefined {
    const color = this.toOptionalString(value);
    return color || undefined;
  }

  private static toBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  private static parseIntegerOption(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }

    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }

    return null;
  }

  private static parseBoundedIntegerOption(value: unknown, min: number, max: number = Number.POSITIVE_INFINITY): number | null {
    const parsed = this.parseIntegerOption(value);
    return parsed !== null && parsed >= min && parsed <= max ? parsed : null;
  }

  private static parseIntegerOrBooleanOption(value: unknown, min: number): boolean | number | null {
    return this.parseBoundedIntegerOption(value, min) ?? parseBooleanOptionOrNull(value);
  }

  private static parseNumberOption(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private static parseDurationOption(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
      return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
    }

    return null;
  }

  private static buildEventTooltip(event: CalendarEvent): string {
    const lines = [event.title];
    const range = this.formatEventRange(event);
    if (range) {
      lines.push(range);
    }
    if (event.description) {
      lines.push(event.description);
    }
    return lines.join('\n');
  }

  private static formatEventRange(event: CalendarEvent): string | null {
    if (event.end && event.end !== event.start) {
      return `${this.formatDisplayTemporal(event.start, event.startHasTime)} to ${this.formatDisplayTemporal(event.end, event.endHasTime)}`;
    }

    if (event.startHasTime) {
      return this.formatDisplayTemporal(event.start, true);
    }

    return null;
  }

  private static formatDisplayTemporal(value: string, hasTime: boolean): string {
    const parsed = new Date(hasTime ? value : `${value}T00:00:00`);
    if (hasTime) {
      return parsed.toLocaleString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    }

    return parsed.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  private static hasExplicitTime(value: string): boolean {
    return /(?:\d{1,2}:\d{2}(?::\d{2})?|\b(am|pm)\b)/i.test(value);
  }

  private static toComparableTime(value: NormalizedTemporalValue): number {
    return new Date(value.hasTime ? value.value : `${value.value}T00:00:00`).getTime();
  }

  private static destroyExistingInstance(container: HTMLElement): void {
    const existing = this.instances.get(container);
    if (!existing) {
      return;
    }

    existing.calendar.destroy();
    existing.resizeObserver?.disconnect();
    existing.intersectionObserver?.disconnect();
    this.clearScheduledCalendarSizeUpdates(container, existing);
    container.ownerDocument.querySelector('.vaultquery-calendar-tooltip')?.remove();

    this.instances.delete(container);
  }
}
