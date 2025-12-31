import type { EntityHandler, EntityHandlerContext, PreviewResult, EditPlannerPreviewResult } from './types';
import { escapeRegex, processEscapeSequences } from '../utils/StringUtils';
import { extractSql, createEmptyResult } from './types';

/**
 * Handler for content-based operations: notes, tags, links
 * These operations modify file content directly rather than structured data
 */
export class ContentHandler implements EntityHandler {
  readonly supportedTables = ['notes', 'notes_with_properties', 'tags', 'links'];

  canHandle(table: string): boolean {
    return this.supportedTables.includes(table);
  }

  async convertPreviewResult(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const effectiveTable = this.getEffectiveTable(previewResult.table);

    switch (effectiveTable) {
      case 'notes':
        return this.handleNotesOperation(previewResult, context);
      case 'tags':
        return this.handleTagsOperation(previewResult, context);
      case 'links':
        return this.handleLinksOperation(previewResult, context);
      default:
        return createEmptyResult(extractSql(previewResult));
    }
  }

  async handleInsertOperation(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const effectiveTable = this.getEffectiveTable(previewResult.table);

    switch (effectiveTable) {
      case 'notes':
        return this.handleNotesInsert(previewResult);
      case 'tags':
        return this.handleTagsInsert(previewResult, context);
      case 'links':
        return this.handleLinksInsert(previewResult, context);
      default:
        return createEmptyResult(extractSql(previewResult));
    }
  }

  private getEffectiveTable(table: string): string {
    const viewToTable: Record<string, string> = {
      'notes_with_properties': 'notes'
    };
    return viewToTable[table] || table;
  }

  // ============= Notes Operations =============

  private handleNotesOperation(
    previewResult: PreviewResult,
    _context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'delete') {
      if (!_context.settings.allowDeleteNotes) {
        throw new Error('DELETE FROM notes is disabled. Enable "Allow file deletion" in VaultQuery settings to delete files.');
      }
      const pathsToDelete = previewResult.before.map(row => row.path as string);
      return Promise.resolve({
        sqlToApply: extractSql(previewResult),
        tasksAfter: [],
        headingsAfter: [],
        tableCellsAfter: [],
        filesToDelete: pathsToDelete
      });
    }

    if (previewResult.op === 'update') {
      if (previewResult.table === 'notes_with_properties') {
        return Promise.resolve(this.handleNotesWithPropertiesUpdate(previewResult));
      }

      // Regular notes table update (content only)
      const contentUpdates = previewResult.after
        .filter(row => row.content !== undefined)
        .map(row => ({
          path: row.path as string,
          content: processEscapeSequences(row.content as string)
        }));

      return Promise.resolve({
        sqlToApply: extractSql(previewResult),
        tasksAfter: [],
        headingsAfter: [],
        tableCellsAfter: [],
        notesContentUpdates: contentUpdates
      });
    }

    return Promise.resolve(createEmptyResult(extractSql(previewResult)));
  }

  private handleNotesWithPropertiesUpdate(previewResult: PreviewResult): EditPlannerPreviewResult {
    const notesCoreColumns = ['path', 'title', 'content', 'created', 'modified', 'size'];
    const propertiesAfter: Array<{ path: string; key: string; value: string | null; type: string | null }> = [];
    const propertiesToDelete: Array<{ path: string; key: string; value: string | null; type: string | null }> = [];
    const contentUpdates: Array<{ path: string; content: string }> = [];

    for (let i = 0; i < previewResult.after.length; i++) {
      const afterRow = previewResult.after[i];
      const beforeRow = previewResult.before[i];
      const path = afterRow.path as string;

      // Handle content updates
      if (afterRow.content !== undefined && afterRow.content !== beforeRow?.content) {
        contentUpdates.push({ path, content: processEscapeSequences(afterRow.content as string) });
      }

      // Handle property column changes
      for (const [key, afterValue] of Object.entries(afterRow)) {
        if (notesCoreColumns.includes(key)) continue;

        const beforeValue = beforeRow?.[key];

        if (afterValue !== beforeValue) {
          if (afterValue === null || afterValue === undefined) {
            propertiesToDelete.push({ path, key, value: null, type: null });
          }

          else {
            propertiesAfter.push({ path, key, value: String(afterValue), type: null });
          }
        }
      }
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      propertiesAfter: propertiesAfter.length > 0 ? propertiesAfter : undefined,
      propertiesToDelete: propertiesToDelete.length > 0 ? propertiesToDelete : undefined,
      notesContentUpdates: contentUpdates.length > 0 ? contentUpdates : undefined
    };
  }

  private handleNotesInsert(previewResult: PreviewResult): EditPlannerPreviewResult {
    const isFromPropertiesView = previewResult.table === 'notes_with_properties';
    const notesCoreColumns = ['path', 'title', 'content', 'created', 'modified', 'size'];

    const filesToCreate = previewResult.after.map(row => {
      const path = row.path as string;
      let content = processEscapeSequences((row.content as string) || '');

      const title = row.title as string | undefined;
      if (!content && title) {
        content = `# ${title}\n\n`;
      }

      if (isFromPropertiesView) {
        const properties: Record<string, string> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!notesCoreColumns.includes(key) && value !== null && value !== undefined) {
            properties[key] = String(value);
          }
        }

        if (Object.keys(properties).length > 0) {
          const yamlLines = Object.entries(properties).map(([k, v]) => {
            if (v.includes(':') || v.includes('#') || v.includes('\n') || v.startsWith('"') || v.startsWith("'")) {
              return `${k}: "${v.replace(/"/g, '\\"')}"`;
            }
            return `${k}: ${v}`;
          });
          // eslint-disable-next-line obsidianmd/prefer-stringify-yaml -- intentional: building file content from scratch during file creation
          const frontmatter = `---\n${yamlLines.join('\n')}\n---\n\n`;
          content = frontmatter + content;
        }
      }

      return { path, content };
    });

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      filesToCreate
    };
  }

  // ============= Tags Operations =============

  private async handleTagsOperation(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'update') {
      return this.handleTagsUpdate(previewResult, context);
    }

    if (previewResult.op === 'delete') {
      return this.handleTagsDelete(previewResult, context);
    }

    return createEmptyResult(extractSql(previewResult));
  }

  private async handleTagsUpdate(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const tagChangesByPath = new Map<string, Array<{ oldTag: string; newTag: string }>>();

    for (let i = 0; i < previewResult.before.length; i++) {
      const before = previewResult.before[i];
      const after = previewResult.after[i];
      if (before && after && before.tag_name !== after.tag_name) {
        const path = after.path as string;
        const changes = tagChangesByPath.get(path) || [];
        changes.push({
          oldTag: before.tag_name as string,
          newTag: after.tag_name as string
        });
        tagChangesByPath.set(path, changes);
      }
    }

    const contentUpdates: Array<{ path: string; content: string }> = [];

    for (const [path, changes] of tagChangesByPath) {
      let content = await context.readFileContent(path);
      if (!content) continue;

      for (const change of changes) {
        const regex = new RegExp(escapeRegex(change.oldTag) + '(?=\\s|$|[^\\w-])', 'g');
        content = content.replace(regex, change.newTag);
      }

      contentUpdates.push({ path, content });
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      notesContentUpdates: contentUpdates
    };
  }

  private async handleTagsDelete(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const tagDeletesByPath = new Map<string, string[]>();

    for (const row of previewResult.before) {
      const path = row.path as string;
      const tagName = row.tag_name as string;
      const tags = tagDeletesByPath.get(path) || [];
      tags.push(tagName);
      tagDeletesByPath.set(path, tags);
    }

    const contentUpdates: Array<{ path: string; content: string }> = [];

    for (const [path, tagsToDelete] of tagDeletesByPath) {
      let content = await context.readFileContent(path);
      if (!content) continue;

      for (const tag of tagsToDelete) {
        const regex = new RegExp(escapeRegex(tag) + '\\s?', 'g');
        content = content.replace(regex, '');
      }

      contentUpdates.push({ path, content });
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      notesContentUpdates: contentUpdates
    };
  }

  private async handleTagsInsert(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const inlineTagsByPath = new Map<string, Array<{
      tagName: string;
      lineNumber: number;
      insertPosition: string;
    }>>();
    const frontmatterTagsByPath = new Map<string, string[]>();

    for (const row of previewResult.after) {
      const path = row.path as string;
      let tagName = row.tag_name as string;
      if (!tagName.startsWith('#')) {
        tagName = '#' + tagName;
      }
      const lineNumber = row.line_number as number | null;
      const insertPosition = (row.insert_position as string | null) || 'new_line';

      if (lineNumber !== null && lineNumber !== undefined) {
        const tags = inlineTagsByPath.get(path) || [];
        tags.push({ tagName, lineNumber, insertPosition });
        inlineTagsByPath.set(path, tags);
      }

      else {
        const tags = frontmatterTagsByPath.get(path) || [];
        tags.push(tagName.startsWith('#') ? tagName.slice(1) : tagName);
        frontmatterTagsByPath.set(path, tags);
      }
    }

    const contentUpdates: Array<{ path: string; content: string }> = [];

    for (const [path, newTags] of inlineTagsByPath) {
      let content: string;
      try {
        content = await context.readFileContent(path);
      }

      catch (e) {
        console.warn('[VaultQuery] ContentHandler: Failed to read file for tag insert', path, e);
        continue;
      }

      const lines = content.split('\n');
      newTags.sort((a, b) => b.lineNumber - a.lineNumber);

      for (const tag of newTags) {
        const lineIdx = tag.lineNumber - 1;

        if (lineIdx >= 0 && lineIdx < lines.length) {
          switch (tag.insertPosition) {
            case 'line_start':
              lines[lineIdx] = tag.tagName + ' ' + lines[lineIdx];
              break;
            case 'line_end':
              lines[lineIdx] = lines[lineIdx] + ' ' + tag.tagName;
              break;
            case 'new_line':
            default:
              lines.splice(lineIdx, 0, tag.tagName);
              break;
          }
        }

        else if (lineIdx >= lines.length) {
          while (lines.length < lineIdx) {
            lines.push('');
          }
          lines.push(tag.tagName);
        }
      }

      content = lines.join('\n');
      if (!content.endsWith('\n')) {
        content += '\n';
      }

      contentUpdates.push({ path, content });
    }

    // Handle frontmatter tags
    const propertiesAfter: Array<{ path: string; key: string; value: string | null; type: string | null }> = [];

    for (const [path, newTags] of frontmatterTagsByPath) {
      const existingTagsResult = await context.queryDatabase<{ tag_name: string }>(
        'SELECT DISTINCT tag_name FROM tags WHERE path = ?',
        [path]
      );
      const existingTags = existingTagsResult.map(r => {
        let tag = r.tag_name;
        if (tag.startsWith('#')) tag = tag.slice(1);
        return tag;
      });

      const allTags = [...new Set([...existingTags, ...newTags])];

      propertiesAfter.push({
        path,
        key: 'tags',
        value: JSON.stringify(allTags),
        type: 'tags'
      });
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      propertiesAfter: propertiesAfter.length > 0 ? propertiesAfter : undefined,
      notesContentUpdates: contentUpdates.length > 0 ? contentUpdates : undefined
    };
  }

  // ============= Links Operations =============

  private async handleLinksOperation(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    if (previewResult.op === 'update') {
      return this.handleLinksUpdate(previewResult, context);
    }

    if (previewResult.op === 'delete') {
      return this.handleLinksDelete(previewResult, context);
    }

    return createEmptyResult(extractSql(previewResult));
  }

  private async handleLinksUpdate(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const linkChangesByPath = new Map<string, Array<{ oldTarget: string; oldText: string; newTarget: string; newText: string }>>();

    for (let i = 0; i < previewResult.before.length; i++) {
      const before = previewResult.before[i];
      const after = previewResult.after[i];
      if (before && after) {
        const targetChanged = before.link_target !== after.link_target;
        const textChanged = before.link_text !== after.link_text;
        if (targetChanged || textChanged) {
          const path = after.path as string;
          const changes = linkChangesByPath.get(path) || [];
          changes.push({
            oldTarget: before.link_target as string,
            oldText: before.link_text as string,
            newTarget: after.link_target as string,
            newText: after.link_text as string
          });
          linkChangesByPath.set(path, changes);
        }
      }
    }

    const contentUpdates: Array<{ path: string; content: string }> = [];

    for (const [path, changes] of linkChangesByPath) {
      let content = await context.readFileContent(path);
      if (!content) continue;

      for (const change of changes) {
        let oldLink: string;
        let newLink: string;

        if (change.oldText && change.oldText !== change.oldTarget) {
          oldLink = `[[${change.oldTarget}|${change.oldText}]]`;
          newLink = change.newText && change.newText !== change.newTarget
            ? `[[${change.newTarget}|${change.newText}]]`
            : `[[${change.newTarget}]]`;
        }

        else {
          oldLink = `[[${change.oldTarget}]]`;
          newLink = change.newText && change.newText !== change.newTarget
            ? `[[${change.newTarget}|${change.newText}]]`
            : `[[${change.newTarget}]]`;
        }

        content = content.replace(oldLink, newLink);
      }

      contentUpdates.push({ path, content });
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      notesContentUpdates: contentUpdates
    };
  }

  private async handleLinksDelete(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const linkDeletesByPath = new Map<string, Array<{ target: string; text: string }>>();

    for (const row of previewResult.before) {
      const path = row.path as string;
      const links = linkDeletesByPath.get(path) || [];
      links.push({
        target: row.link_target as string,
        text: row.link_text as string
      });
      linkDeletesByPath.set(path, links);
    }

    const contentUpdates: Array<{ path: string; content: string }> = [];

    for (const [path, linksToDelete] of linkDeletesByPath) {
      let content = await context.readFileContent(path);
      if (!content) continue;

      for (const link of linksToDelete) {
        const linkWithText = `[[${link.target}|${link.text}]]`;
        const linkSimple = `[[${link.target}]]`;

        if (content.includes(linkWithText)) {
          content = content.replace(linkWithText, '');
        }

        else {
          content = content.replace(linkSimple, '');
        }
      }

      contentUpdates.push({ path, content });
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      notesContentUpdates: contentUpdates
    };
  }

  private async handleLinksInsert(
    previewResult: PreviewResult,
    context: EntityHandlerContext
  ): Promise<EditPlannerPreviewResult> {
    const linksByPath = new Map<string, Array<{
      target: string;
      text: string;
      lineNumber: number | null;
      insertPosition: string | null;
    }>>();

    for (const row of previewResult.after) {
      const path = row.path as string;
      const links = linksByPath.get(path) || [];
      links.push({
        target: row.link_target as string,
        text: (row.link_text as string) || '',
        lineNumber: row.line_number as number | null,
        insertPosition: (row.insert_position as string | null) || 'new_line'
      });
      linksByPath.set(path, links);
    }

    const contentUpdates: Array<{ path: string; content: string }> = [];

    for (const [path, newLinks] of linksByPath) {
      let content: string;
      try {
        content = await context.readFileContent(path);
      }

      catch (e) {
        console.warn('[VaultQuery] ContentHandler: Failed to read file for link insert', path, e);
        continue;
      }

      const lines = content.split('\n');

      const linksWithPosition = newLinks.filter(l => l.lineNumber !== null && l.lineNumber !== undefined);
      const linksToAppend = newLinks.filter(l => l.lineNumber === null || l.lineNumber === undefined);

      linksWithPosition.sort((a, b) => (b.lineNumber as number) - (a.lineNumber as number));

      for (const link of linksWithPosition) {
        const linkStr = link.text && link.text !== link.target
          ? `[[${link.target}|${link.text}]]`
          : `[[${link.target}]]`;

        const lineIdx = (link.lineNumber as number) - 1;

        if (lineIdx >= 0 && lineIdx < lines.length) {
          switch (link.insertPosition) {
            case 'line_start':
              lines[lineIdx] = linkStr + ' ' + lines[lineIdx];
              break;
            case 'line_end':
              lines[lineIdx] = lines[lineIdx] + ' ' + linkStr;
              break;
            case 'new_line':
            default:
              lines.splice(lineIdx, 0, linkStr);
              break;
          }
        }

        else if (lineIdx >= lines.length) {
          while (lines.length < lineIdx) {
            lines.push('');
          }
          lines.push(linkStr);
        }
      }

      if (linksToAppend.length > 0) {
        const linkStrings = linksToAppend.map(link => {
          if (link.text && link.text !== link.target) {
            return `[[${link.target}|${link.text}]]`;
          }
          return `[[${link.target}]]`;
        });

        if (lines.length > 0 && lines[lines.length - 1] !== '') {
          lines.push(linkStrings.join(' '));
        }

        else {
          lines[lines.length - 1] = linkStrings.join(' ');
        }
      }

      content = lines.join('\n');
      if (!content.endsWith('\n')) {
        content += '\n';
      }

      contentUpdates.push({ path, content });
    }

    return {
      sqlToApply: extractSql(previewResult),
      tasksAfter: [],
      headingsAfter: [],
      tableCellsAfter: [],
      notesContentUpdates: contentUpdates
    };
  }
}
