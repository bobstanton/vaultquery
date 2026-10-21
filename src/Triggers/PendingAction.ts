export interface SetPropertyParams { path: string; key: string; value: string }
export interface RemovePropertyParams { path: string; key: string }
interface NotifyParams { message: string }
export interface RenameNoteParams { path: string; newName: string }
export interface SetContentParams { path: string; content: string }
export interface ReplaceContentParams { path: string; search: string; replacement: string }
export interface UpdateTaskParams { path: string; lineNumber: number; status: string | null; taskText: string | null }
export interface CompleteTaskParams { path: string; lineNumber: number; status: string }
export interface AddTaskParams { path: string; text: string; afterLine: number }
export interface DeleteTaskParams { path: string; lineNumber: number }
export interface UpdateHeadingParams { path: string; lineNumber: number; level: number | null; headingText: string | null }
export interface AddHeadingParams { path: string; level: number; text: string; afterLine: number }
export interface DeleteHeadingParams { path: string; lineNumber: number }
export interface UpdateListItemParams { path: string; lineNumber: number; itemText: string }
export interface AddListItemParams { path: string; text: string; afterLine: number }
export interface DeleteListItemParams { path: string; lineNumber: number }
export interface AddTableRowParams { path: string; tableIndex: number; values: Record<string, string> }
export interface SetTableCellParams { path: string; tableIndex: number; rowIndex: number; columnName: string; value: string }
export interface DeleteTableRowParams { path: string; tableIndex: number; rowIndex: number }
export interface CreateNoteParams { path: string; content: string }

export type PendingAction =
  | { type: 'set_property'; params: SetPropertyParams }
  | { type: 'remove_property'; params: RemovePropertyParams }
  | { type: 'notify'; params: NotifyParams }
  | { type: 'rename_note'; params: RenameNoteParams }
  | { type: 'set_content'; params: SetContentParams }
  | { type: 'replace_content'; params: ReplaceContentParams }
  | { type: 'update_task'; params: UpdateTaskParams }
  | { type: 'complete_task'; params: CompleteTaskParams }
  | { type: 'add_task'; params: AddTaskParams }
  | { type: 'delete_task'; params: DeleteTaskParams }
  | { type: 'update_heading'; params: UpdateHeadingParams }
  | { type: 'add_heading'; params: AddHeadingParams }
  | { type: 'delete_heading'; params: DeleteHeadingParams }
  | { type: 'update_list_item'; params: UpdateListItemParams }
  | { type: 'add_list_item'; params: AddListItemParams }
  | { type: 'delete_list_item'; params: DeleteListItemParams }
  | { type: 'add_table_row'; params: AddTableRowParams }
  | { type: 'set_table_cell'; params: SetTableCellParams }
  | { type: 'delete_table_row'; params: DeleteTableRowParams }
  | { type: 'create_note'; params: CreateNoteParams };
