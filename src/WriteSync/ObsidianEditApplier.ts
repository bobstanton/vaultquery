import { App, TFile, normalizePath } from 'obsidian';
import { ContentLocationService } from '../Services/ContentLocationService';
import { HeadingEditPlanner, ListItemEditPlanner, TableEditPlanner, TaskEditPlanner } from '../EditPlanner';
import { MarkdownTableUtils } from '../utils/MarkdownTableUtils';
import { parseFrontmatterValue } from '../utils/FrontmatterValueParser';
import { createNoteWithFolders } from '../utils/VaultUtils';
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

/** Re-plan attempts when a concurrent edit lands between planning and applying. */
const MAX_CONTENT_APPLY_ATTEMPTS = 3;

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
    this.tablePlanner = new TableEditPlanner(contentLocationService, (content, tableIndex) => MarkdownTableUtils.findTableByIndex(content, tableIndex));
  }

  public async applyIntents(intents: ObsidianEditIntent[]): Promise<string[]> {
    const affectedPaths = new Set<string>();
    const pathGroups = new Map<string, PathIntentGroup>();

    for (const intent of intents) {
      if (intent.type === 'createNote') {
        await createNoteWithFolders(this.app.vault, intent.path, intent.content);
        affectedPaths.add(intent.path);
        continue;
      }

      if (intent.type === 'deleteNote') {
        await this.deleteNote(intent.path);
        affectedPaths.add(intent.path);
        continue;
      }

      this.addPathIntent(pathGroups, intent);
    }

    for (const path of await this.applyPathGroups(pathGroups)) {
      affectedPaths.add(path);
    }

    return Array.from(affectedPaths);
  }

  private intentPath(intent: PathIntent): string {
    switch (intent.type) {
      case 'replaceTask':
      case 'deleteTask':
      case 'replaceHeading':
      case 'deleteHeading':
      case 'replaceListItem':
      case 'deleteListItem':
        return intent.location.path;
      default:
        return intent.path;
    }
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

  private async deleteNote(path: string): Promise<void> {
    const file = this.getFile(path);
    await this.app.fileManager.trashFile(file);
  }

  private async updateProperty(path: string, mutate: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const file = this.getFile(path);
    await this.app.fileManager.processFrontMatter(file, mutate);
  }

  private async applyPathGroups(groups: Map<string, PathIntentGroup>): Promise<string[]> {
    const affectedPaths: string[] = [];

    for (const [path, group] of groups) {
      const file = this.getFile(path);
      const contentChanged = await this.applyContentIntentsAtomically(file, path, group);

      if (group.properties.length > 0) {
        await this.updateProperty(path, fm => {
          this.applyPropertyMutations(fm, group.properties);
        });
      }

      if (contentChanged || group.properties.length > 0) {
        affectedPaths.push(path);
      }
    }

    return affectedPaths;
  }

  /**
   * Planning is async (list item planning queries the index), so it cannot
   * run inside vault.process's synchronous transform; instead the edits are
   * planned against a snapshot and applied atomically only while the file
   * still matches that snapshot. A concurrent edit - the user typing in the
   * same note - triggers a re-plan against the new content instead of being
   * silently overwritten by a write based on a stale read.
   */
  private async applyContentIntentsAtomically(file: TFile, path: string, group: PathIntentGroup): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CONTENT_APPLY_ATTEMPTS; attempt++) {
      const snapshot = await this.app.vault.read(file);
      let planned = this.applyWholeNoteIntents(file, snapshot, group.ordered);
      const rangeEdits = await this.planRangeEdits(path, planned, group);

      if (rangeEdits.length > 0) {
        planned = this.applyRangeEdits(planned, rangeEdits);
      }

      if (planned === snapshot) {
        return false;
      }

      let conflicted = false;
      await this.app.vault.process(file, (current) => {
        if (current !== snapshot) {
          conflicted = true;
          return current;
        }
        return planned;
      });

      if (!conflicted) {
        return true;
      }

      logger.debug('Concurrent edit landed while applying write intents; re-planning', { path, attempt: attempt + 1 });
    }

    logger.warn('Gave up applying write intents after repeated concurrent edits', { path });
    return false;
  }

  private applyWholeNoteIntents(file: TFile, originalContent: string, intents: PathIntent[]): string {
    let content = originalContent;

    for (const intent of intents) {
      if (intent.type === 'replaceNoteBody') {
        content = content.slice(0, this.getBodyStartOffset(file, content)) + intent.content;
      }
      else if (intent.type === 'replaceNoteContent') {
        content = intent.mode === 'patch' && intent.baselineContent != null
          ? this.applyContentPatch(content, intent.baselineContent, intent.content)
          : intent.content;
      }
    }

    return content;
  }

  private async planRangeEdits(path: string, content: string, group: PathIntentGroup): Promise<ReplaceRangeEdit[]> {
    const warnings: string[] = [];
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

    return this.sortAndValidateEdits(edits);
  }

  private partitionIntentRows<TIntent, TRow>(intents: TIntent[], isDelete: (intent: TIntent) => boolean,
    getRow: (intent: TIntent) => TRow): { after: TRow[]; toDelete: TRow[] } {
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

  private sortAndValidateEdits(edits: ReplaceRangeEdit[]): ReplaceRangeEdit[] {
    const sorted = edits.slice().sort((a, b) => b.range.start - a.range.start);
    const ok: ReplaceRangeEdit[] = [];
    let previousStart = Number.POSITIVE_INFINITY;

    for (const edit of sorted) {
      if (edit.range.start > edit.range.end || edit.range.start < 0) {
        logger.warn(`Invalid edit range [${edit.range.start}, ${edit.range.end}) for ${edit.path}`);
        continue;
      }

      if (edit.range.end > previousStart) {
        logger.warn(`Overlapping edit range [${edit.range.start}, ${edit.range.end}) for ${edit.path}`);
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
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }
    return file;
  }

  private getBodyStartOffset(file: TFile, content: string): number {
    const frontmatterEnd = this.app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.offset;
    if (frontmatterEnd != null) {
      return frontmatterEnd;
    }

    const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/);
    return frontmatterMatch ? frontmatterMatch[0].length : 0;
  }
}
