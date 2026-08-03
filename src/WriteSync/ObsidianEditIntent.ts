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

type CreateNoteIntent = {
  type: 'createNote';
  path: string;
  content: string;
};

type DeleteNoteIntent = {
  type: 'deleteNote';
  path: string;
};

type ReplaceNoteBodyIntent = {
  type: 'replaceNoteBody';
  path: string;
  content: string;
};

type ReplaceNoteContentIntent = {
  type: 'replaceNoteContent';
  path: string;
  content: string;
  baselineContent: string;
};

type SetPropertyIntent = {
  type: 'setProperty';
  path: string;
  key: string;
  value: string | null;
  valueType: string | null;
};

type DeletePropertyIntent = {
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

type ReplaceTaskIntent = {
  type: 'replaceTask';
  location: ObsidianEntityLocation;
  task: TaskRow;
};

type DeleteTaskIntent = {
  type: 'deleteTask';
  location: ObsidianEntityLocation;
  task: TaskRow;
};

type InsertTaskIntent = {
  type: 'insertTask';
  path: string;
  lineNumber?: number | null;
  task: TaskRow;
};

type ReplaceHeadingIntent = {
  type: 'replaceHeading';
  location: ObsidianEntityLocation;
  heading: HeadingRow;
};

type DeleteHeadingIntent = {
  type: 'deleteHeading';
  location: ObsidianEntityLocation;
  heading: HeadingRow;
};

type InsertHeadingIntent = {
  type: 'insertHeading';
  path: string;
  lineNumber?: number | null;
  heading: HeadingRow;
};

type ReplaceListItemIntent = {
  type: 'replaceListItem';
  location: ObsidianEntityLocation;
  listItem: ListItemRow;
};

type DeleteListItemIntent = {
  type: 'deleteListItem';
  location: ObsidianEntityLocation;
  listItem: ListItemRow;
};

type InsertListItemIntent = {
  type: 'insertListItem';
  path: string;
  lineNumber?: number | null;
  listItem: ListItemRow;
};

type RewriteTableIntent = {
  type: 'rewriteTable';
  path: string;
  tableCells: TableCellRow[];
};
