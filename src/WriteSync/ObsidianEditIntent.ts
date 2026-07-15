import type { HeadingRow, ListItemRow, TableCellRow, TaskRow } from '../Services/ContentLocationService';

export type ObsidianEditIntent =
  | CreateNoteIntent
  | DeleteNoteIntent
  | ReplaceNoteBodyIntent
  | ReplaceNoteContentIntent
  | SetPropertyIntent
  | DeletePropertyIntent
  | ReplaceTaskIntent
  | DeleteTaskIntent
  | InsertTaskIntent
  | ReplaceHeadingIntent
  | DeleteHeadingIntent
  | InsertHeadingIntent
  | ReplaceListItemIntent
  | DeleteListItemIntent
  | InsertListItemIntent
  | RewriteTableIntent;

export type CreateNoteIntent = {
  type: 'createNote';
  path: string;
  content: string;
};

export type DeleteNoteIntent = {
  type: 'deleteNote';
  path: string;
};

export type ReplaceNoteBodyIntent = {
  type: 'replaceNoteBody';
  path: string;
  content: string;
};

export type ReplaceNoteContentIntent = {
  type: 'replaceNoteContent';
  path: string;
  content: string;
  baselineContent?: string;
  mode?: 'replace' | 'patch';
};

export type SetPropertyIntent = {
  type: 'setProperty';
  path: string;
  key: string;
  value: string | null;
  valueType: string | null;
};

export type DeletePropertyIntent = {
  type: 'deleteProperty';
  path: string;
  key: string;
};

export type ObsidianEntityLocation = {
  path: string;
  blockId?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
  lineNumber?: number | null;
};

export type ReplaceTaskIntent = {
  type: 'replaceTask';
  location: ObsidianEntityLocation;
  task: TaskRow;
};

export type DeleteTaskIntent = {
  type: 'deleteTask';
  location: ObsidianEntityLocation;
  task: TaskRow;
};

export type InsertTaskIntent = {
  type: 'insertTask';
  path: string;
  lineNumber?: number | null;
  task: TaskRow;
};

export type ReplaceHeadingIntent = {
  type: 'replaceHeading';
  location: ObsidianEntityLocation;
  heading: HeadingRow;
};

export type DeleteHeadingIntent = {
  type: 'deleteHeading';
  location: ObsidianEntityLocation;
  heading: HeadingRow;
};

export type InsertHeadingIntent = {
  type: 'insertHeading';
  path: string;
  lineNumber?: number | null;
  heading: HeadingRow;
};

export type ReplaceListItemIntent = {
  type: 'replaceListItem';
  location: ObsidianEntityLocation;
  listItem: ListItemRow;
};

export type DeleteListItemIntent = {
  type: 'deleteListItem';
  location: ObsidianEntityLocation;
  listItem: ListItemRow;
};

export type InsertListItemIntent = {
  type: 'insertListItem';
  path: string;
  lineNumber?: number | null;
  listItem: ListItemRow;
};

export type RewriteTableIntent = {
  type: 'rewriteTable';
  path: string;
  tableCells: TableCellRow[];
};
