import { App, TFile, normalizePath, getFrontMatterInfo, parseYaml } from 'obsidian';
import { ContentLocationService } from '../Services/ContentLocationService';
import { HeadingEditPlanner, ListItemEditPlanner, TableEditPlanner, TaskEditPlanner } from '../EditPlanner';
import { parseFrontmatterValue } from '../utils/FrontmatterValueParser';
import { createFileWithFolders, resolveVaultFile } from '../utils/VaultUtils';
import { pathParent } from '../utils/PathUtils';
import { assertTextFileSource, processFileContents, readTextFileSource } from './FileWriteOperations';
import type { TextFileSource } from './FileWriteOperations';
import { FilePreviewStaleError, FileWriteApplyError } from './FileWriteTypes';
import { getErrorMessage } from '../utils/ErrorMessages';
import { logger as rootLogger } from '../utils/logger';

import type { ObsidianEditIntent } from './ObsidianEditIntent';
import type { ReplaceRangeEdit, TableCellRow } from '../EditPlanner';

const logger = rootLogger.scope('WriteSync');
type QueryListItemsByListIndex = (path: string, listIndex: number) => Promise<Array<{ line_number: number | null; item_index: number }>>;
type TaskIntent = Extract<ObsidianEditIntent, { type: 'replaceTask' | 'deleteTask' | 'insertTask' }>;
type HeadingIntent = Extract<ObsidianEditIntent, { type: 'replaceHeading' | 'deleteHeading' | 'insertHeading' }>;
type ListItemIntent = Extract<ObsidianEditIntent, { type: 'replaceListItem' | 'deleteListItem' | 'insertListItem' }>;
type TableIntent = Extract<ObsidianEditIntent, { type: 'rewriteTable' }>;
type PathIntent = Exclude<ObsidianEditIntent, { type: 'createNote' | 'deleteNote' }>;

interface PathIntentGroup {
  ordered: PathIntent[];
  tasks: TaskIntent[];
  headings: HeadingIntent[];
  listItems: ListItemIntent[];
  tables: TableIntent[];
  properties: Array<Extract<ObsidianEditIntent, { type: 'setProperty' | 'deleteProperty' }>>;
}

interface PreparedPathEdits {
  content: string;
  properties: PathIntentGroup['properties'];
  frontmatter: unknown;
}

interface ApplyContext {
  sources: Map<string, TextFileSource>;
  assertAccess: () => void;
  completed: Set<string>;
  changed: Set<string>;
  currentPath?: string;
  writing: boolean;
}

export interface ApplyIntentsResult {
  affectedPaths: string[];
  warnings: string[];
}

export class ObsidianEditApplier {
  private readonly taskPlanner: TaskEditPlanner;
  private readonly headingPlanner: HeadingEditPlanner;
  private readonly listItemPlanner: ListItemEditPlanner;
  private readonly tablePlanner: TableEditPlanner;

  public constructor(private readonly app: App, private readonly queryListItemsByListIndex?: QueryListItemsByListIndex) {
    const contentLocationService = new ContentLocationService(this.app, this.app.metadataCache);
    this.taskPlanner = new TaskEditPlanner(contentLocationService);
    this.headingPlanner = new HeadingEditPlanner(contentLocationService);
    this.listItemPlanner = new ListItemEditPlanner(contentLocationService);
    this.tablePlanner = new TableEditPlanner();
  }

  public async applyIntents(intents: ObsidianEditIntent[], sources: ReadonlyMap<string, TextFileSource>, assertAccess: () => void): Promise<ApplyIntentsResult> {
    const warnings: string[] = [];
    const context: ApplyContext = { sources: new Map(sources), assertAccess, completed: new Set(), changed: new Set(), writing: false };

    try {
      for (const path of sources.keys()) {
        await this.checkSource(path, context);
      }

      const prepared = await this.preparePathGroups(intents, warnings, context);

      for (const intent of intents) {
        if (intent.type === 'createNote' || intent.type === 'deleteNote') {
          const path = normalizePath(intent.path);
          await this.checkSource(path, context);
          context.writing = true;

          if (intent.type === 'createNote') {
            await createFileWithFolders(this.app.vault, path, intent.content);
            context.sources.set(path, { file: this.getFile(path), content: intent.content });
          } else {
            await this.app.fileManager.trashFile(this.getFile(path));
            context.sources.set(path, { file: null, content: null });
          }

          context.changed.add(path);
          context.completed.add(path);
          context.writing = false;
        }
      }

      await this.applyPathGroups(prepared, context);

      return { affectedPaths: [...context.changed], warnings };
    } catch (error) {
      if (!context.changed.size && error instanceof FilePreviewStaleError) throw error;
      const path = context.currentPath;
      const unknown = path && (context.changed.has(path) || context.writing && !(error instanceof FilePreviewStaleError)) ? [path] : [];
      const completed = [...context.completed].filter(item => !unknown.includes(item));
      const untouched = [...sources.keys()].filter(item => !completed.includes(item) && !unknown.includes(item));
      throw new FileWriteApplyError(getErrorMessage(error), context.writing ? 'write' : 'preflight', completed, unknown, untouched, path);
    }
  }

  private async checkSource(path: string, context: ApplyContext): Promise<void> {
    context.currentPath = path;
    context.writing = false;
    context.assertAccess();
    const expected = context.sources.get(path);
    if (!expected) throw new FilePreviewStaleError(`File is missing from the prepared preview: ${path}`);
    assertTextFileSource(path, expected, await readTextFileSource(this.app.vault, path, expected.frontmatterOnly));
    context.assertAccess();
  }

  private intentPath(intent: ObsidianEditIntent): string {
    return normalizePath('location' in intent ? intent.location.path : intent.path);
  }

  private addPathIntent(groups: Map<string, PathIntentGroup>, intent: PathIntent): void {
    const path = this.intentPath(intent);
    let group = groups.get(path);

    if (!group) {
      group = { ordered: [], tasks: [], headings: [], listItems: [], tables: [], properties: [] };
      groups.set(path, group);
    }

    group.ordered.push(intent);

    if (this.isTaskIntent(intent)) {
      group.tasks.push(intent);
    }
    else if (this.isHeadingIntent(intent)) {
      group.headings.push(intent);
    }
    else if (this.isListItemIntent(intent)) {
      group.listItems.push(intent);
    }
    else if (this.isTableIntent(intent)) {
      group.tables.push(intent);
    }
    else if (intent.type === 'setProperty' || intent.type === 'deleteProperty') {
      group.properties.push(intent);
    }
  }

  private async preparePathGroups(intents: ObsidianEditIntent[], warnings: string[], context: ApplyContext): Promise<Map<string, PreparedPathEdits>> {
    const groups = new Map<string, PathIntentGroup>();
    const sources = new Map(context.sources);
    const requiredFolders = new Set<string>();

    for (const intent of intents) {
      const path = this.intentPath(intent);
      context.currentPath = path;
      if (!sources.has(path)) throw new FilePreviewStaleError(`File is missing from the prepared preview: ${path}`);

      if (intent.type === 'createNote' || intent.type === 'deleteNote') {
        if (intent.type === 'createNote' ? sources.get(path)!.content !== null : sources.get(path)!.content === null) {
          throw new FilePreviewStaleError(`File creation or deletion conflicts with the preview: ${path}`);
        }

        if (intent.type === 'createNote') {
          if (requiredFolders.has(path)) throw new Error(`File path is occupied by a planned folder: ${path}`);

          for (let parent = pathParent(path); parent; parent = pathParent(parent)) {
            const parentSource = sources.get(parent);

            if (parentSource ? parentSource.content !== null : this.app.vault.getAbstractFileByPath(parent) instanceof TFile) {
              throw new Error(`Parent path is not a folder: ${parent}`);
            }

            requiredFolders.add(parent);
          }
        }

        sources.set(path, { file: null, content: intent.type === 'createNote' ? intent.content : null });
      } else {
        if (intent.type === 'replaceTask' || intent.type === 'insertTask') {
          TaskEditPlanner.getTaskCheckbox(intent.task.status, !!intent.task.completed);
        }

        this.addPathIntent(groups, intent);
      }
    }

    const prepared = new Map<string, PreparedPathEdits>();

    for (const [path, group] of groups) {
      context.currentPath = path;
      context.assertAccess();
      const source = sources.get(path)!;
      if (source.content === null) throw new FilePreviewStaleError(`File is unavailable for the prepared edits: ${path}`);
      const snapshot = source.frontmatterOnly ? '' : source.content;
      let planned = this.applyWholeNoteIntents(snapshot, group.ordered);
      const rangeEdits = await this.planRangeEdits(path, planned, group, warnings);
      if (rangeEdits.length) planned = this.applyRangeEdits(planned, rangeEdits);

      const frontmatter: unknown = group.properties.length
        ? parseYaml(source.frontmatterOnly ? source.content : getFrontMatterInfo(planned).frontmatter) ?? {}
        : undefined;

      if (group.properties.length && Object.prototype.toString.call(frontmatter) !== '[object Object]') {
        throw new Error(`Frontmatter must be a mapping to edit its properties: ${path}`);
      }

      prepared.set(path, { content: planned, properties: group.properties, frontmatter });
    }

    return prepared;
  }

  private async applyPathGroups(prepared: Map<string, PreparedPathEdits>, context: ApplyContext): Promise<void> {
    for (const [path, edits] of prepared) {
      context.currentPath = path;
      context.writing = false;
      context.assertAccess();
      const file = this.getFile(path);
      const source = context.sources.get(path)!;
      if (source.file !== file) throw new FilePreviewStaleError(`File changed since preview: ${path}`);
      const snapshot = source.frontmatterOnly ? '' : source.content!;
      const planned = edits.content;

      if (planned !== snapshot) {
        context.writing = true;
        await processFileContents(this.app.vault, file, path, snapshot, planned, context.assertAccess);
        context.changed.add(path);
        context.sources.set(path, { file, content: planned });
        context.writing = false;
      }

      if (edits.properties.length) {
        context.writing = true;

        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          context.assertAccess();

          if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file || !sameProperties(edits.frontmatter, frontmatter)) {
            throw new FilePreviewStaleError(`Frontmatter changed before writing: ${path}`);
          }

          this.applyPropertyMutations(frontmatter, edits.properties);
        });

        context.changed.add(path);
        context.writing = false;
      }

      if (context.changed.has(path)) context.completed.add(path);
      prepared.delete(path);
    }
  }

  private applyWholeNoteIntents(originalContent: string, intents: PathIntent[]): string {
    let content = originalContent;

    for (const intent of intents) {
      if (intent.type === 'replaceNoteBody') {
        content = content.slice(0, getFrontMatterInfo(content).contentStart) + intent.content;
      }
      else if (intent.type === 'replaceNoteContent') {
        content = this.applyContentPatch(content, intent.baselineContent, intent.content);
      }
    }

    return content;
  }

  private async planRangeEdits(path: string, content: string, group: PathIntentGroup, warnings: string[]): Promise<ReplaceRangeEdit[]> {
    const ctx = { content, path, warnings };
    const edits: ReplaceRangeEdit[] = [];

    const { after: tasksAfter, toDelete: tasksToDelete } =
      this.partitionIntentRows(group.tasks, intent => intent.type === 'deleteTask', intent => intent.task);

    const { after: headingsAfter, toDelete: headingsToDelete } =
      this.partitionIntentRows(group.headings, intent => intent.type === 'deleteHeading', intent => intent.heading);

    const { after: listItemsAfter, toDelete: listItemsToDelete } =
      this.partitionIntentRows(group.listItems, intent => intent.type === 'deleteListItem', intent => intent.listItem);

    const tableCells: TableCellRow[] = [];

    for (const intent of group.tables) {
      tableCells.push(...intent.tableCells);
    }

    const tablePlan = this.tablePlanner.planTableEdits(ctx, tableCells);
    const headingPlan = this.headingPlanner.planHeadingEdits(ctx, headingsAfter, headingsToDelete);
    const taskPlan = this.taskPlanner.planTaskEdits(ctx, tasksAfter, tasksToDelete);
    const listItemPlan = await this.listItemPlanner.planListItemEdits(ctx, listItemsAfter, listItemsToDelete, this.queryListItemsByListIndex);

    for (const plan of [tablePlan, headingPlan, taskPlan, listItemPlan]) {
      warnings.push(...plan.warnings);
      edits.push(...plan.edits);
    }

    if (warnings.length > 0) {
      logger.warn('Write intent warnings', warnings);
    }

    return this.sortAndValidateEdits(edits, warnings);
  }

  private partitionIntentRows<TIntent, TRow>(intents: TIntent[], isDelete: (intent: TIntent) => boolean, getRow: (intent: TIntent) => TRow): { after: TRow[]; toDelete: TRow[] } {
    const after: TRow[] = [];
    const toDelete: TRow[] = [];

    for (const intent of intents) {
      (isDelete(intent) ? toDelete : after).push(getRow(intent));
    }

    return { after, toDelete };
  }

  private applyPropertyMutations(frontmatter: Record<string, unknown>, intents: PathIntentGroup['properties']): void {
    for (const intent of intents) {
      if (intent.type === 'setProperty') {
        frontmatter[intent.key] = parseFrontmatterValue(intent.value, intent.valueType);
      }
      else {
        delete frontmatter[intent.key];
      }
    }
  }

  private sortAndValidateEdits(edits: ReplaceRangeEdit[], warnings: string[]): ReplaceRangeEdit[] {
    const sorted = edits.slice().sort((a, b) => b.range.start - a.range.start);
    const ok: ReplaceRangeEdit[] = [];
    let previousStart = Number.POSITIVE_INFINITY;

    for (const edit of sorted) {
      if (edit.range.start > edit.range.end || edit.range.start < 0) {
        const warning = `${edit.path}: skipped edit with invalid range [${edit.range.start}, ${edit.range.end})${edit.reason ? ` (${edit.reason})` : ''}`;
        logger.warn(warning);
        warnings.push(warning);
        continue;
      }

      if (edit.range.end > previousStart) {
        const warning = `${edit.path}: skipped edit with overlapping range [${edit.range.start}, ${edit.range.end})${edit.reason ? ` (${edit.reason})` : ''}`;
        logger.warn(warning);
        warnings.push(warning);
        continue;
      }

      ok.push(edit);
      previousStart = edit.range.start;
    }

    return ok;
  }

  private applyContentPatch(content: string, baselineContent: string, nextContent: string): string {
    if (baselineContent === nextContent) {
      return content;
    }

    let prefixLength = 0;
    const minLength = Math.min(baselineContent.length, nextContent.length);

    while (prefixLength < minLength && baselineContent[prefixLength] === nextContent[prefixLength]) {
      prefixLength++;
    }

    let baselineSuffix = baselineContent.length;
    let nextSuffix = nextContent.length;

    while (
      baselineSuffix > prefixLength &&
      nextSuffix > prefixLength &&
      baselineContent[baselineSuffix - 1] === nextContent[nextSuffix - 1]
    ) {
      baselineSuffix--;
      nextSuffix--;
    }

    const removed = baselineContent.slice(prefixLength, baselineSuffix);
    const inserted = nextContent.slice(prefixLength, nextSuffix);
    const unchangedSuffix = baselineContent.slice(baselineSuffix);

    if (!removed) {
      const suffixAt = unchangedSuffix ? content.indexOf(unchangedSuffix, prefixLength) : content.length;

      if (suffixAt >= 0) {
        return content.slice(0, suffixAt) + inserted + content.slice(suffixAt);
      }
    }

    if (content.slice(prefixLength, prefixLength + removed.length) === removed) {
      return content.slice(0, prefixLength) + inserted + content.slice(prefixLength + removed.length);
    }

    const foundAt = removed ? this.findUniqueOccurrence(content, removed) : prefixLength;

    if (foundAt !== null) {
      return content.slice(0, foundAt) + inserted + content.slice(foundAt + removed.length);
    }

    throw new Error('Could not apply note content patch because the original text no longer matches.');
  }

  private findUniqueOccurrence(content: string, needle: string): number | null {
    const first = content.indexOf(needle);

    if (first < 0) {
      return null;
    }

    return content.indexOf(needle, first + needle.length) < 0 ? first : null;
  }

  private applyRangeEdits(content: string, edits: ReplaceRangeEdit[]): string {
    let modifiedContent = content;

    for (const edit of edits) {
      const { start, end } = edit.range;

      if (end > modifiedContent.length) {
        throw new Error(`Edit range ${start}-${end} exceeds content length for ${edit.path}`);
      }

      modifiedContent = modifiedContent.slice(0, start) + edit.text + modifiedContent.slice(end);
    }

    return modifiedContent;
  }

  private isTaskIntent(intent: ObsidianEditIntent): intent is TaskIntent {
    return intent.type === 'replaceTask' || intent.type === 'deleteTask' || intent.type === 'insertTask';
  }

  private isHeadingIntent(intent: ObsidianEditIntent): intent is HeadingIntent {
    return intent.type === 'replaceHeading' || intent.type === 'deleteHeading' || intent.type === 'insertHeading';
  }

  private isListItemIntent(intent: ObsidianEditIntent): intent is ListItemIntent {
    return intent.type === 'replaceListItem' || intent.type === 'deleteListItem' || intent.type === 'insertListItem';
  }

  private isTableIntent(intent: ObsidianEditIntent): intent is TableIntent {
    return intent.type === 'rewriteTable';
  }

  private getFile(path: string): TFile {
    const file = resolveVaultFile(this.app.vault, path);

    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    return file;
  }
}

function sameProperties(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);

  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key)
    && sameProperties((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
