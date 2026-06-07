import type { Database } from 'sql.js';
import { CustomSQLFunctions } from '../Database/CustomSQLFunctions';
import { logger as rootLogger } from '../utils/logger';

declare const activeWindow: Window;

const logger = rootLogger.scope('TriggerFunctions');

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
export interface AddTableRowParams { path: string; tableIndex: number; valuesJson: string }
export interface SetTableCellParams { path: string; tableIndex: number; rowIndex: number; columnName: string; value: string }
export interface DeleteTableRowParams { path: string; tableIndex: number; rowIndex: number }
export interface CreateNoteParams { path: string; content: string }

interface DeferTimer {
  id: number;
  win: Window;
}

type TriggerArgumentType = 'string' | 'number';
type TriggerArgumentValues = Record<string, string | number>;

interface TriggerArgumentSpec {
  name: string;
  type: TriggerArgumentType;
}

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

/**
 * Manages trigger action functions (vq_*) that queue actions for later execution.
 * These functions are registered with SQLite and called from user-defined triggers.
 */
export class TriggerFunctions {
  private pendingActions: PendingAction[] = [];
  private isProcessingTriggers = false;
  private isPreviewMode = false;
  private debounceTimestamps: Map<string, number> = new Map();

  private deferredActionsByKey: Map<string, PendingAction[]> = new Map();
  private deferTimers: Map<string, DeferTimer> = new Map();
  private currentDeferKey: string | null = null;
  private onDeferredReady: (() => void) | null = null;

  // Track direct apply targets to distinguish them from cascades.
  // During applyDML, only block sync for DIRECT targets; allow cascades to queue.
  private directApplyTargets: Set<string> | null = null;

  /**
   * Central guard for standard trigger functions: blocks during processing/preview,
   * calls fn() to build the action, queues it, and returns 1 on success or 0 on failure.
   * Pass allowInPreview=true for actions that are safe during preview (e.g. notifications).
   */
  private guarded(fn: () => PendingAction | null, allowInPreview = false): 0 | 1 {
    if (this.isProcessingTriggers) return 0;
    if (!allowInPreview && this.isPreviewMode) return 0;
    const action = fn();
    if (action === null) return 0;
    this.queueAction(action);
    return 1;
  }

  private actionFromArgs(functionName: string, args: unknown[], specs: TriggerArgumentSpec[], build: (values: TriggerArgumentValues) => PendingAction | null): PendingAction | null {
    const values: TriggerArgumentValues = {};
    const invalidValues: Record<string, unknown> = {};

    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      const value = args[index];
      if (typeof value !== spec.type) {
        invalidValues[spec.name] = value;
        continue;
      }
      values[spec.name] = value as string | number;
    }

    if (Object.keys(invalidValues).length > 0) {
      logger.warn(`${functionName}: invalid arguments`, invalidValues);
      return null;
    }

    return build(values);
  }

  /**
   * Queue an action, respecting deferred mode if active.
   */
  private queueAction(action: PendingAction): void {
    if (this.currentDeferKey) {
      const existing = this.deferredActionsByKey.get(this.currentDeferKey) || [];
      existing.push(action);
      this.deferredActionsByKey.set(this.currentDeferKey, existing);
    } else {
      this.pendingActions.push(action);
    }
  }

  /**
   * Register all vq_* functions with the SQLite database.
   */
  public register(db: Database): void {
    db.create_function('vq_set_property', (path: unknown, key: unknown, value: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_set_property', [path, key], [{ name: 'path', type: 'string' }, { name: 'key', type: 'string' }], values => ({
        type: 'set_property',
        params: { path: values.path as string, key: values.key as string, value: value == null ? '' : String(value) }
      })))
    );

    db.create_function('vq_remove_property', (path: unknown, key: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_remove_property', [path, key], [{ name: 'path', type: 'string' }, { name: 'key', type: 'string' }], values => ({
        type: 'remove_property',
        params: { path: values.path as string, key: values.key as string }
      })))
    );

    // Allow during preview mode since notifications don't modify files.
    // Still block during isProcessingTriggers to prevent cascade spam.
    db.create_function('vq_notify', (message: unknown) =>
      this.guarded(() => ({
        type: 'notify',
        params: { message: message == null ? '' : String(message) }
      }), true)
    );

    db.create_function('vq_log', (message: unknown) => {
      logger.debug('vq_log', message);
      return 1;
    });

    db.create_function('vq_rename_note', (path: unknown, newName: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_rename_note', [path, newName], [{ name: 'path', type: 'string' }, { name: 'newName', type: 'string' }], values => ({
        type: 'rename_note',
        params: { path: values.path as string, newName: values.newName as string }
      })))
    );

    db.create_function('vq_set_content', (path: unknown, content: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_set_content', [path], [{ name: 'path', type: 'string' }], values => ({
        type: 'set_content',
        params: { path: values.path as string, content: content == null ? '' : String(content) }
      })))
    );

    db.create_function('vq_replace_content', (path: unknown, search: unknown, replacement: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_replace_content', [path, search], [{ name: 'path', type: 'string' }, { name: 'search', type: 'string' }], values => ({
        type: 'replace_content',
        params: { path: values.path as string, search: values.search as string, replacement: replacement == null ? '' : String(replacement) }
      })))
    );

    // Use after direct SQL changes to notes.content:
    //   UPDATE notes SET content = replace(content, '{{today}}', date('now')) WHERE path = NEW.path;
    //   SELECT vq_sync_content(NEW.path);
    db.create_function('vq_sync_content', (path: unknown) => {
      if (this.isProcessingTriggers || this.isPreviewMode) return 0;
      if (typeof path !== 'string') {
        logger.warn('vq_sync_content: invalid arguments', { path });
        return 0;
      }
      const result = db.exec('SELECT content FROM notes WHERE path = ?', [path]);
      if (result.length === 0 || !result[0].values || result[0].values.length === 0) {
        logger.warn('vq_sync_content: note not found', { path });
        return 0;
      }
      const content = result[0].values[0][0] as string;
      this.queueAction({ type: 'set_content', params: { path, content } });
      return 1;
    });

    // Use in WHEN clause to debounce trigger execution:
    //   WHEN vq_debounce('my_trigger', 500)
    // Or per-path debouncing:
    //   WHEN vq_debounce('my_trigger:' || NEW.path, 500)
    db.create_function('vq_debounce', (key: unknown, ms: unknown) => {
      if (typeof key !== 'string' || typeof ms !== 'number') {
        logger.warn('vq_debounce: invalid arguments', { key, ms });
        return 0;
      }

      const now = Date.now();
      const lastFire = this.debounceTimestamps.get(key);

      if (lastFire !== undefined && now - lastFire < ms) {
        return 0;
      }

      this.debounceTimestamps.set(key, now);
      return 1;
    });

    // Use at the START of trigger body to defer all subsequent vq_* calls:
    //   BEGIN
    //     SELECT vq_defer('my_trigger:' || NEW.path, 3000);
    //     SELECT vq_set_property(...);  -- This will be deferred
    //   END
    // If the trigger fires again within ms, the timer resets and previous actions are discarded.
    db.create_function('vq_defer', (key: unknown, ms: unknown) => {
      if (typeof key !== 'string' || typeof ms !== 'number') {
        logger.warn('vq_defer: invalid arguments', { key, ms });
        return 0;
      }

      const existingTimer = this.deferTimers.get(key);
      if (existingTimer) {
        existingTimer.win.clearTimeout(existingTimer.id);
      }

      this.deferredActionsByKey.delete(key);
      this.currentDeferKey = key;

      const timerWindow = activeWindow;
      const timer = timerWindow.setTimeout(() => {
        this.deferTimers.delete(key);

        const deferred = this.deferredActionsByKey.get(key);
        if (deferred && deferred.length > 0) {
          this.pendingActions.push(...deferred);
          this.deferredActionsByKey.delete(key);

          if (this.onDeferredReady) {
            this.onDeferredReady();
          }
        }
      }, ms);

      this.deferTimers.set(key, { id: timer, win: timerWindow });

      return 1;
    });

    db.create_function('vq_complete_task', (path: unknown, lineNumber: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_complete_task', [path, lineNumber], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }], values => ({
        type: 'complete_task',
        params: { path: values.path as string, lineNumber: values.lineNumber as number, status: 'DONE' }
      })))
    );

    db.create_function('vq_uncomplete_task', (path: unknown, lineNumber: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_uncomplete_task', [path, lineNumber], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }], values => ({
        type: 'complete_task',
        params: { path: values.path as string, lineNumber: values.lineNumber as number, status: 'TODO' }
      })))
    );

    db.create_function('vq_set_task_status', (path: unknown, lineNumber: unknown, status: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_set_task_status', [path, lineNumber, status], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }, { name: 'status', type: 'string' }], values => ({
        type: 'complete_task',
        params: { path: values.path as string, lineNumber: values.lineNumber as number, status: values.status as string }
      })))
    );

    db.create_function('vq_set_task_text', (path: unknown, lineNumber: unknown, text: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_set_task_text', [path, lineNumber], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }], values => ({
        type: 'update_task',
        params: { path: values.path as string, lineNumber: values.lineNumber as number, status: null, taskText: text == null ? '' : String(text) }
      })))
    );

    db.create_function('vq_add_task', (path: unknown, text: unknown, afterLine: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_add_task', [path], [{ name: 'path', type: 'string' }], values => ({
        type: 'add_task',
        params: { path: values.path as string, text: text == null ? '' : String(text), afterLine: typeof afterLine === 'number' ? afterLine : 0 }
      })))
    );

    db.create_function('vq_delete_task', (path: unknown, lineNumber: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_delete_task', [path, lineNumber], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }], values => ({
        type: 'delete_task',
        params: { path: values.path as string, lineNumber: values.lineNumber as number }
      })))
    );

    db.create_function('vq_set_heading_text', (path: unknown, lineNumber: unknown, text: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_set_heading_text', [path, lineNumber], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }], values => ({
        type: 'update_heading',
        params: { path: values.path as string, lineNumber: values.lineNumber as number, level: null, headingText: text == null ? '' : String(text) }
      })))
    );

    db.create_function('vq_set_heading_level', (path: unknown, lineNumber: unknown, level: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_set_heading_level', [path, lineNumber, level], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }, { name: 'level', type: 'number' }], values => ({
        type: 'update_heading',
        params: { path: values.path as string, lineNumber: values.lineNumber as number, level: Math.max(1, Math.min(6, values.level as number)), headingText: null }
      })))
    );

    db.create_function('vq_add_heading', (path: unknown, level: unknown, text: unknown, afterLine: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_add_heading', [path, level], [{ name: 'path', type: 'string' }, { name: 'level', type: 'number' }], values => ({
        type: 'add_heading',
        params: {
          path: values.path as string,
          level: Math.max(1, Math.min(6, values.level as number)),
          text: text == null ? '' : String(text),
          afterLine: typeof afterLine === 'number' ? afterLine : 0
        }
      })))
    );

    db.create_function('vq_delete_heading', (path: unknown, lineNumber: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_delete_heading', [path, lineNumber], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }], values => ({
        type: 'delete_heading',
        params: { path: values.path as string, lineNumber: values.lineNumber as number }
      })))
    );

    db.create_function('vq_set_list_item_text', (path: unknown, lineNumber: unknown, text: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_set_list_item_text', [path, lineNumber], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }], values => ({
        type: 'update_list_item',
        params: { path: values.path as string, lineNumber: values.lineNumber as number, itemText: text == null ? '' : String(text) }
      })))
    );

    db.create_function('vq_add_list_item', (path: unknown, text: unknown, afterLine: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_add_list_item', [path], [{ name: 'path', type: 'string' }], values => ({
        type: 'add_list_item',
        params: { path: values.path as string, text: text == null ? '' : String(text), afterLine: typeof afterLine === 'number' ? afterLine : 0 }
      })))
    );

    db.create_function('vq_delete_list_item', (path: unknown, lineNumber: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_delete_list_item', [path, lineNumber], [{ name: 'path', type: 'string' }, { name: 'lineNumber', type: 'number' }], values => ({
        type: 'delete_list_item',
        params: { path: values.path as string, lineNumber: values.lineNumber as number }
      })))
    );

    db.create_function('vq_add_table_row', (path: unknown, tableIndex: unknown, valuesJson: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_add_table_row', [path, tableIndex, valuesJson], [{ name: 'path', type: 'string' }, { name: 'tableIndex', type: 'number' }, { name: 'valuesJson', type: 'string' }], values => {
        let parsedValues: Record<string, string>;
        try {
          parsedValues = JSON.parse(values.valuesJson as string);
        } catch (e) {
          logger.warn('vq_add_table_row: invalid JSON', { valuesJson, error: e });
          return null;
        }
        return { type: 'add_table_row', params: { path: values.path as string, tableIndex: values.tableIndex as number, valuesJson: JSON.stringify(parsedValues) } };
      }))
    );

    db.create_function('vq_set_table_cell', (path: unknown, tableIndex: unknown, rowIndex: unknown, columnName: unknown, value: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_set_table_cell', [path, tableIndex, rowIndex, columnName], [{ name: 'path', type: 'string' }, { name: 'tableIndex', type: 'number' }, { name: 'rowIndex', type: 'number' }, { name: 'columnName', type: 'string' }], values => ({
        type: 'set_table_cell',
        params: { path: values.path as string, tableIndex: values.tableIndex as number, rowIndex: values.rowIndex as number, columnName: values.columnName as string, value: value == null ? '' : String(value) }
      })))
    );

    db.create_function('vq_delete_table_row', (path: unknown, tableIndex: unknown, rowIndex: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_delete_table_row', [path, tableIndex, rowIndex], [{ name: 'path', type: 'string' }, { name: 'tableIndex', type: 'number' }, { name: 'rowIndex', type: 'number' }], values => ({
        type: 'delete_table_row',
        params: { path: values.path as string, tableIndex: values.tableIndex as number, rowIndex: values.rowIndex as number }
      })))
    );

    // If the note already exists, this does nothing (use vq_set_content to overwrite)
    db.create_function('vq_create_note', (path: unknown, content: unknown) =>
      this.guarded(() => this.actionFromArgs('vq_create_note', [path], [{ name: 'path', type: 'string' }], values => ({
        type: 'create_note',
        params: { path: values.path as string, content: content == null ? '' : String(content) }
      })))
    );

    this.registerSyncHandlers();
  }

  /**
   * Register sync handlers that allow schema triggers to queue file modifications.
   * Used by INSERT INTO table_rows (etc.) to sync changes to markdown files.
   */
  private registerSyncHandlers(): void {
    CustomSQLFunctions.registerSyncHandler('add_table_row', (path: unknown, tableIndex: unknown, valuesJson: unknown) => {
      // - During previewDML: Block all (EditPlanner handles sync)
      // - During applyDML: Block only DIRECT target (handled by WriteSyncService),
      //   but ALLOW cascade (different table indices) to queue

      if (typeof path !== 'string' || typeof tableIndex !== 'number' || typeof valuesJson !== 'string') {
        return 0;
      }

      if (this.isPreviewMode && !this.directApplyTargets) {
        return 0;
      }

      if (this.directApplyTargets) {
        if (this.isDirectApplyTarget(path, tableIndex)) {
          return 0;
        }
        // This is a CASCADE operation - allow it to queue!
      }

      try {
        JSON.parse(valuesJson);
      } catch {
        return 0;
      }
      this.queueAction({
        type: 'add_table_row',
        params: { path, tableIndex, valuesJson }
      });
      return 1;
    });

    // NOTE: DO NOT check isProcessingTriggers here - allow cascading triggers
    CustomSQLFunctions.registerSyncHandler('update_table_row', (path: unknown, tableIndex: unknown, rowIndex: unknown, valuesJson: unknown) => {
      if (this.isPreviewMode) return 0;
      if (typeof path !== 'string' || typeof tableIndex !== 'number' || typeof rowIndex !== 'number' || typeof valuesJson !== 'string') {
        return 0;
      }
      // The schema trigger already handled the database side
      this.queueAction({
        type: 'add_table_row',
        params: { path, tableIndex, valuesJson }
      });
      return 1;
    });

    // NOTE: DO NOT check isProcessingTriggers here - allow cascading triggers
    CustomSQLFunctions.registerSyncHandler('delete_table_row', (path: unknown, tableIndex: unknown, rowIndex: unknown) => {
      if (this.isPreviewMode) return 0;
      if (typeof path !== 'string' || typeof tableIndex !== 'number' || typeof rowIndex !== 'number') {
        return 0;
      }
      this.queueAction({
        type: 'delete_table_row',
        params: { path, tableIndex, rowIndex }
      });
      return 1;
    });
  }

  private getActionPriority(action: PendingAction): number {
    switch (action.type) {
      case 'update_task':
      case 'complete_task':
      case 'add_task':
      case 'delete_task':
      case 'update_heading':
      case 'add_heading':
      case 'delete_heading':
      case 'update_list_item':
      case 'add_list_item':
      case 'delete_list_item':
      case 'set_table_cell':
      case 'add_table_row':
      case 'delete_table_row':
        return 1;

      case 'set_property':
      case 'remove_property':
        return 2;

      case 'set_content':
      case 'replace_content':
        return 3;

      case 'notify':
      case 'rename_note':
      case 'create_note':
        return 4;

      default:
        return 5;
    }
  }

  public getPendingActions(): PendingAction[] {
    const actions = [...this.pendingActions];
    this.pendingActions = [];

    const pathsWithLineActions = new Set<string>();
    for (const action of actions) {
      if (this.getActionPriority(action) === 1 && 'path' in action.params) {
        const path = action.params.path;
        if (typeof path === 'string') {
          pathsWithLineActions.add(path);
        }
      }
    }

    const filteredActions = actions.filter(action => {
      if (action.type === 'set_content' || action.type === 'replace_content') {
        const { path } = action.params;
        if (pathsWithLineActions.has(path)) {
          return false;
        }
      }
      return true;
    });

    filteredActions.sort((a, b) => this.getActionPriority(a) - this.getActionPriority(b));

    return filteredActions;
  }

  public hasPendingActions(): boolean {
    return this.pendingActions.length > 0;
  }

  public getPendingActionsCount(): number {
    return this.pendingActions.length;
  }

  public limitPendingActions(maxCount: number): void {
    if (this.pendingActions.length > maxCount) {
      this.pendingActions = this.pendingActions.slice(0, maxCount);
    }
  }

  public setProcessingTriggers(value: boolean): void {
    this.isProcessingTriggers = value;
  }

  public getIsProcessingTriggers(): boolean {
    return this.isProcessingTriggers;
  }

  public setPreviewMode(value: boolean): void {
    this.isPreviewMode = value;
  }

  public setDirectApplyTarget(target: { path: string; tableIndex: number } | null): void {
    this.setDirectApplyTargets(target ? [target] : null);
  }

  public setDirectApplyTargets(targets: Array<{ path: string; tableIndex: number }> | null): void {
    this.directApplyTargets = targets
      ? new Set(targets.map(target => this.formatDirectApplyTargetKey(target.path, target.tableIndex)))
      : null;
  }

  public isDirectApplyTarget(path: string, tableIndex: number): boolean {
    return this.directApplyTargets?.has(this.formatDirectApplyTargetKey(path, tableIndex)) ?? false;
  }

  private formatDirectApplyTargetKey(path: string, tableIndex: number): string {
    return `${path}\u0000${tableIndex}`;
  }

  public clearPendingActions(): void {
    this.pendingActions = [];
  }

  public queueSetProperty(path: string, key: string, value: string): void {
    if (this.isProcessingTriggers) return;
    this.pendingActions.push({
      type: 'set_property',
      params: { path, key, value }
    });
  }

  public getPendingPropertyKeys(path: string): Set<string> {
    const keys = new Set<string>();
    for (const action of this.pendingActions) {
      if (action.type === 'set_property' && action.params.path === path) {
        keys.add(action.params.key as string);
      }
    }
    return keys;
  }

  public queueUpdateTask(path: string, lineNumber: number, status: string, taskText: string): void {
    if (this.isProcessingTriggers) return;
    this.pendingActions.push({
      type: 'update_task',
      params: { path, lineNumber, status, taskText }
    });
  }

  public queueUpdateHeading(path: string, lineNumber: number, level: number, headingText: string): void {
    if (this.isProcessingTriggers) return;
    this.pendingActions.push({
      type: 'update_heading',
      params: { path, lineNumber, level, headingText }
    });
  }

  public queueUpdateListItem(path: string, lineNumber: number, itemText: string): void {
    if (this.isProcessingTriggers) return;
    this.pendingActions.push({
      type: 'update_list_item',
      params: { path, lineNumber, itemText }
    });
  }

  public setOnDeferredReady(callback: () => void): void {
    this.onDeferredReady = callback;
  }

  public clearCurrentDeferKey(): void {
    this.currentDeferKey = null;
  }

  public clearDeferTimers(): void {
    for (const timer of this.deferTimers.values()) {
      timer.win.clearTimeout(timer.id);
    }
    this.deferTimers.clear();
    this.deferredActionsByKey.clear();
  }
}
