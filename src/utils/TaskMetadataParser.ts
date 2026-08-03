const DATE_PATTERN = String.raw`\d{4}-\d{2}-\d{2}`;

export const TASK_PRIORITY_EMOJIS: ReadonlyArray<{ emoji: string; priority: string }> = [
  { emoji: '🔺', priority: 'highest' },
  { emoji: '⏫', priority: 'high' },
  { emoji: '🔼', priority: 'medium' },
  { emoji: '🔽', priority: 'low' },
  { emoji: '⏬', priority: 'lowest' },
];

export const TASK_DATE_REGEXES = {
  createdDate: new RegExp(`➕\\s*(${DATE_PATTERN})`),
  scheduledDate: new RegExp(`⏳\\s*(${DATE_PATTERN})`),
  startDate: new RegExp(`🛫\\s*(${DATE_PATTERN})`),
  dueDate: new RegExp(`📅\\s*(${DATE_PATTERN})`),
  doneDate: new RegExp(`✅\\s*(${DATE_PATTERN})`),
  cancelledDate: new RegExp(`❌\\s*(${DATE_PATTERN})`),
} as const;

export const TASK_RECURRENCE_TERMINATORS = '📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🆔⛔🏁#';

export const TASK_RECURRENCE_REGEX = new RegExp(`🔁\\s*([^${TASK_RECURRENCE_TERMINATORS}]+)`, 'u');
export const TASK_ON_COMPLETION_REGEX = /🏁\s*(\w+)/;
export const TASK_ID_REGEX = /🆔\s*([\w-]+)/;
export const TASK_DEPENDS_ON_REGEX = /⛔\s*([\w,-]+)/;
export const TASK_TAGS_REGEX = /#[\w-]+/g;

export interface TaskMetadata {
  priority?: string;
  createdDate?: string;
  scheduledDate?: string;
  startDate?: string;
  dueDate?: string;
  doneDate?: string;
  cancelledDate?: string;
  recurrence?: string;
  onCompletion?: string;
  taskId?: string;
  dependsOn?: string;
  tags?: string;
}

export function extractTaskMetadata(taskText: string): TaskMetadata {
  const priority = TASK_PRIORITY_EMOJIS.find(({ emoji }) => taskText.includes(emoji))?.priority;

  const createdDate = taskText.match(TASK_DATE_REGEXES.createdDate)?.[1];
  const scheduledDate = taskText.match(TASK_DATE_REGEXES.scheduledDate)?.[1];
  const startDate = taskText.match(TASK_DATE_REGEXES.startDate)?.[1];
  const dueDate = taskText.match(TASK_DATE_REGEXES.dueDate)?.[1];
  const doneDate = taskText.match(TASK_DATE_REGEXES.doneDate)?.[1];
  const cancelledDate = taskText.match(TASK_DATE_REGEXES.cancelledDate)?.[1];

  const recurrence = taskText.match(TASK_RECURRENCE_REGEX)?.[1]?.trim();
  const onCompletion = taskText.match(TASK_ON_COMPLETION_REGEX)?.[1];
  const taskId = taskText.match(TASK_ID_REGEX)?.[1];
  const dependsOn = taskText.match(TASK_DEPENDS_ON_REGEX)?.[1];

  const tagMatches = taskText.match(TASK_TAGS_REGEX);
  const tags = tagMatches ? tagMatches.join(' ') : undefined;

  return {
    priority,
    createdDate,
    scheduledDate,
    startDate,
    dueDate,
    doneDate,
    cancelledDate,
    recurrence,
    onCompletion,
    taskId,
    dependsOn,
    tags
  };
}
