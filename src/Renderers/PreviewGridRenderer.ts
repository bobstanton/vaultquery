import { BaseRenderer } from './BaseRenderer';
import { QueryRefreshRegistry } from './QueryRefreshRegistry';
import { SlickGridRenderer } from './SlickGridRenderer';
import { ColumnUtils } from '../utils/ColumnUtils';
import { getErrorMessage } from '../utils/ErrorMessages';
import { ConfirmationModal } from '../Modals/ConfirmationModal';
import { generateUniqueId } from '../utils/StringUtils';
import type { RenderContext } from './BaseRenderer';
import type { PreviewResult } from '../Services/PreviewService';

declare const activeWindow: Window;

export interface PreviewRenderContext extends RenderContext {
  onApply?: () => void;
  onCancel?: () => void;
}

export class PreviewGridRenderer {
  private static readonly SHOW_CHANGES_BELOW_LABEL = 'Show changes below';
  private static readonly HIDE_CHANGES_BELOW_LABEL = 'Hide changes below';

  static renderPreview(previewResult: PreviewResult, context: PreviewRenderContext): void {
    const { container } = context;

    SlickGridRenderer.cleanupContainer(container);

    let containerId = container.id;
    if (!containerId) {
      containerId = generateUniqueId('vaultquery-preview');
      container.id = containerId;
    }

    this.createSqlPreviewSection(previewResult, container, context);
    this.createPreviewGrid(previewResult, container, context);
    this.createSummarySection(previewResult, container, context);
    this.createActionButtons(previewResult, container, context);

    const buttonContainer = container.createDiv('vaultquery-floating-buttons');

    const previewData = this.preparePreviewData(previewResult, context);
    if (previewData.length > 0) {
      BaseRenderer.addCopyAsMarkdownButton(buttonContainer, previewData);
    }

    if (context.onRefresh) {
      BaseRenderer.addRefreshButton(buttonContainer, context.onRefresh);
      QueryRefreshRegistry.register(container, { onRefresh: context.onRefresh });
    }
  }

  private static createSummarySection(previewResult: PreviewResult, container: HTMLElement, _context: PreviewRenderContext): void {
    const { op, table, before, after, sqlToApply: _sqlToApply } = previewResult;
    const rowCount = Math.max(before.length, after.length);

    let summaryText = '';
    let summaryClass = '';

    switch (op) {
      case 'insert':
        summaryText = `✅ ${rowCount} new row${rowCount !== 1 ? 's' : ''} will be inserted into table "${table}".`;
        summaryClass = 'vaultquery-summary-insert';
        break;
      case 'update':
        const changedFieldCount = this.countChangedFields(before, after);
        if (rowCount === 0) {
          summaryText = `ℹ️ No changes to apply. No rows matched the UPDATE statement.`;
        }
        else if (changedFieldCount === 0) {
          summaryText = `ℹ️ No changes to apply. The ${rowCount} matching row${rowCount !== 1 ? 's' : ''} already ${rowCount !== 1 ? 'have' : 'has'} the specified values.`;
        }
        else {
          summaryText = `ℹ️ ${rowCount} row${rowCount !== 1 ? 's' : ''} will be updated in table "${table}". ${changedFieldCount} field${changedFieldCount !== 1 ? 's' : ''} changed.`;
        }
        summaryClass = 'vaultquery-summary-update';
        break;
      case 'delete':
        summaryText = rowCount === 0
          ? `ℹ️ No rows matched the DELETE statement.`
          : `⚠️ ${rowCount} row${rowCount !== 1 ? 's' : ''} will be deleted from table "${table}".`;
        summaryClass = 'vaultquery-summary-delete';
        break;
      case 'multi':
        const operations = previewResult.multiResults || [];
        const totalRows = operations.reduce((sum, result) => sum + Math.max(result.before.length, result.after.length), 0);
        summaryText = `🔄 Multi-statement operation affecting ${totalRows} rows across ${operations.length} operations.`;
        summaryClass = 'vaultquery-summary-multi';
        break;
    }

    container.createDiv({
      cls: `vaultquery-preview-summary ${summaryClass}`,
      text: summaryText
    });
  }

  private static createSqlPreviewSection(previewResult: PreviewResult, container: HTMLElement, context: PreviewRenderContext): void {
    const { op, sqlToApply, multiResults } = previewResult;

    let sqlStatements: string[] = [];

    if (op === 'multi' && multiResults) {
      multiResults.forEach((result, _index) => {
        result.sqlToApply.forEach(sqlAndParams => {
          sqlStatements.push(sqlAndParams.sql);
        });
      });
    }
    else if (sqlToApply && sqlToApply.length > 0) {
      sqlStatements = sqlToApply.map(sp => sp.sql);
    }

    if (sqlStatements.length === 0) return;

    const sqlSection = container.createDiv({ cls: 'vaultquery-sql-preview-section' });

    sqlStatements.forEach((sql, index) => {
      if (sqlStatements.length > 1) {
        sqlSection.createDiv({
          cls: 'vaultquery-sql-statement-label',
          text: `Statement ${index + 1}:`
        });
      }

      const codeContainer = sqlSection.createDiv({ cls: 'vaultquery-sql-code-container' });
      BaseRenderer.renderSqlCodeBlock(context.app, codeContainer, sql);
    });
  }

  private static createPreviewGrid(previewResult: PreviewResult, container: HTMLElement, context: PreviewRenderContext): void {
    const data = this.preparePreviewData(previewResult, context);

    if (data.length === 0) {
      return;
    }

    const gridContainer = container.createDiv({ cls: 'vaultquery-grid' });

    try {
      const renderContext: RenderContext = {
        results: data,
        parsed: { query: '' },
        container: gridContainer,
        app: context.app,
        openFile: context.openFile,
        settings: context.settings
      };

      SlickGridRenderer.render(renderContext);
      
      if (previewResult.op === 'multi') {
        this.setupMultiStatementExpansion(gridContainer, previewResult, context);
      }
    }
    catch (error: unknown) {
      BaseRenderer.renderError(gridContainer, {
        title: 'Preview Error',
        message: `Preview rendering failed: ${getErrorMessage(error)}`
      });
    }
  }

  private static setupMultiStatementExpansion(gridContainer: HTMLElement, previewResult: PreviewResult, context: PreviewRenderContext): void {
    const self = PreviewGridRenderer;

    const handleExpandClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const cell = target.closest('.slick-cell') as HTMLElement;

      if (!cell || !self.isChangeDetailsCell(cell)) {
        return;
      }

      e.stopPropagation();
      e.preventDefault();

      // SlickGrid uses different attribute names - try both 'row' and data attributes
      const row = cell.closest('.slick-row') as HTMLElement;
      if (!row) return;

      // Try multiple ways to get the row index
      let rowIndex = -1;

      const rowAttr = row.getAttribute('row');
      if (rowAttr !== null) {
        rowIndex = parseInt(rowAttr);
      }

      if (rowIndex < 0) {
        const style = row.style.top;
        if (style) {
          const topPx = parseInt(style);
          if (!isNaN(topPx)) {
            rowIndex = Math.round(topPx / 32);
          }
        }
      }

      if (rowIndex >= 0 && rowIndex < (previewResult.multiResults?.length || 0)) {
        self.toggleOperationDetails(gridContainer, rowIndex, previewResult, context);
      }
    };

    gridContainer.addEventListener('click', handleExpandClick, true);
    gridContainer.addEventListener('touchend', handleExpandClick, true);

    const win = gridContainer.ownerDocument.defaultView ?? activeWindow;
    win.setTimeout(() => {
      const cells = gridContainer.querySelectorAll('.slick-cell');
      cells.forEach(cell => {
        if (self.isChangeDetailsCell(cell)) {
          (cell as HTMLElement).addClass('vaultquery-clickable-cell');
        }
      });
    }, 100);
  }

  private static toggleOperationDetails(gridContainer: HTMLElement, rowIndex: number, previewResult: PreviewResult, context: PreviewRenderContext): void {
    const operationData = previewResult.multiResults?.[rowIndex];
    if (!operationData) return;

    const existingDetails = gridContainer.querySelector(`[data-details-for="${rowIndex}"]`);
    if (existingDetails) {
      this.removeOperationDetails(existingDetails);
      this.updateOperationDetailsLabel(gridContainer, rowIndex, false);
      return;
    }

    const allDetails = gridContainer.querySelectorAll('[data-details-for]');
    allDetails.forEach(el => {
      const detailsFor = Number(el.getAttribute('data-details-for'));
      this.removeOperationDetails(el);
      if (!Number.isNaN(detailsFor)) {
        this.updateOperationDetailsLabel(gridContainer, detailsFor, false);
      }
    });

    const rowElement = gridContainer.querySelector(`.slick-row[row="${rowIndex}"]`);

    const detailsContainer = gridContainer.ownerDocument.createElement('div');
    detailsContainer.className = 'vaultquery-operation-details';
    detailsContainer.setAttribute('data-details-for', rowIndex.toString());

    const title = detailsContainer.createDiv({ cls: 'vaultquery-subgrid-title' });
    const icon = this.getOperationIcon(operationData.op);
    title.appendText(icon + ' ');
    const strong = title.createEl('strong');
    strong.appendText(`${operationData.op.toUpperCase()} Details - ${operationData.table} table`);

    const detailedData = this.prepareOperationDetailData(operationData, context);

    if (detailedData.length > 0) {
      const subgridContainer = detailsContainer.createDiv({ cls: 'vaultquery-subgrid' });

      const subRenderContext: RenderContext = {
        results: detailedData,
        parsed: { query: '' },
        container: subgridContainer,
        app: context.app,
        openFile: context.openFile,
        settings: context.settings
      };

      SlickGridRenderer.render(subRenderContext);
    }
    else {
      detailsContainer.createDiv({
        cls: 'vaultquery-empty',
        text: 'No detailed changes to show'
      });
    }

    if (rowElement && rowElement.parentElement) {
      rowElement.parentElement.insertBefore(detailsContainer, rowElement.nextSibling);
    }
    else {
      gridContainer.appendChild(detailsContainer);
    }

    this.updateOperationDetailsLabel(gridContainer, rowIndex, true);
  }

  private static removeOperationDetails(element: Element): void {
    if (element instanceof HTMLElement) {
      SlickGridRenderer.cleanupContainer(element);
    }
    element.remove();
  }

  private static isChangeDetailsCell(cell: Element): boolean {
    const text = cell.textContent?.trim();
    return text === this.SHOW_CHANGES_BELOW_LABEL || text === this.HIDE_CHANGES_BELOW_LABEL;
  }

  private static updateOperationDetailsLabel(gridContainer: HTMLElement, rowIndex: number, expanded: boolean): void {
    const row = gridContainer.querySelector(`.slick-row[row="${rowIndex}"], .slick-row[data-row="${rowIndex}"]`);
    if (!row) {
      return;
    }

    const label = expanded ? this.HIDE_CHANGES_BELOW_LABEL : this.SHOW_CHANGES_BELOW_LABEL;
    row.querySelectorAll('.slick-cell').forEach(cell => {
      if (!this.isChangeDetailsCell(cell)) {
        return;
      }

      cell.textContent = label;
      if (cell instanceof HTMLElement) {
        cell.addClass('vaultquery-clickable-cell');
      }
    });
  }

  private static prepareOperationDetailData(operation: PreviewResult, _context: PreviewRenderContext): Record<string, unknown>[] {
    switch (operation.op) {
      case 'insert':
        return this.prepareInsertData(operation.after);
      case 'delete':
        return this.prepareDeleteData(operation.before);
      case 'update':
        return this.prepareUpdateData(operation.before, operation.after, operation.pkCols || []);
      default:
        return [];
    }
  }

  private static preparePreviewData(previewResult: PreviewResult, _context: PreviewRenderContext): Record<string, unknown>[] {
    const { op, pkCols, before, after } = previewResult;

    switch (op) {
      case 'insert':
        return this.prepareInsertData(after);
      case 'delete':
        return this.prepareDeleteData(before);
      case 'update':
        return this.prepareUpdateData(before, after, pkCols);
      case 'multi':
        return this.prepareMultiStatementData(previewResult);
      default:
        return [];
    }
  }

  private static prepareInsertData(after: Array<Record<string, unknown>>): Record<string, unknown>[] {
    if (after.length === 0) return [];

    return this.pickRelevantColumns(after, Object.keys(after[0]));
  }

  private static prepareDeleteData(before: Array<Record<string, unknown>>): Record<string, unknown>[] {
    if (before.length === 0) return [];

    return this.pickRelevantColumns(before, Object.keys(before[0]));
  }

  private static pickRelevantColumns(rows: Array<Record<string, unknown>>, columns: string[]): Record<string, unknown>[] {
    const relevantKeys = ColumnUtils.filterRelevantColumns(columns);

    return rows.map(row => {
      const filteredRow: Record<string, unknown> = {};
      relevantKeys.forEach(key => {
        filteredRow[key] = row[key] ?? '';
      });
      return filteredRow;
    });
  }

  private static prepareUpdateData(before: Record<string, unknown>[], after: Record<string, unknown>[], pkCols: string[]): Record<string, unknown>[] {
    if (before.length === 0 || after.length === 0) return [];

    const relevantColumns = this.getRelevantComparisonColumns(before, after);
    const relevantPkCols = ColumnUtils.filterRelevantColumns(pkCols);

    // Use index-based matching since PK columns might have changed
    const changedFields = this.findChangedFieldsByIndex(before, after, relevantColumns);

    if (changedFields.length === 0) {
      return [];
    }

    const changingPkCols = relevantPkCols.filter(pk => changedFields.includes(pk));
    const stablePkCols = relevantPkCols.filter(pk => !changedFields.includes(pk));

    return before.map((beforeRow, index) => {
      const afterRow = after[index] || {};
      const resultRow: Record<string, unknown> = {};

      stablePkCols.forEach(pk => {
        const value = beforeRow[pk];
        // Skip array_index if null/empty
        if (pk === 'array_index' && (value == null || value === '')) {
          return;
        }
        resultRow[pk] = value ?? '';
      });

      if (beforeRow.path !== undefined && !stablePkCols.includes('path') && !changingPkCols.includes('path')) {
        resultRow['path'] = beforeRow.path;
      }

      if (beforeRow.task_text !== undefined && !relevantPkCols.includes('task_text') && !changedFields.includes('task_text')) {
        resultRow['task_text'] = beforeRow.task_text;
      }

      if (beforeRow.value !== undefined && !changedFields.includes('value')) {
        resultRow['value'] = beforeRow.value;
      }

      changedFields.forEach(col => {
        if (col !== 'path') {
          const beforeValue = beforeRow[col] ?? '';
          const afterValue = afterRow[col] ?? '';

          // Skip array_index if both values are null/empty
          if (col === 'array_index' &&
            (beforeValue == null || beforeValue === '') &&
            (afterValue == null || afterValue === '')) {
            return;
          }

          const isActuallyChanged = beforeValue !== afterValue;

          resultRow[`${col} (current)`] = beforeValue;
          resultRow[`${col} (proposed)`] = afterValue;
          resultRow[`_${col}_changed`] = isActuallyChanged;
        }
      });

      return resultRow;
    });
  }

  private static findChangedFieldsByIndex(before: Record<string, unknown>[], after: Record<string, unknown>[], allColumns: string[]): string[] {
    const changedFields = new Set<string>();
    this.collectChangedFields(before, after, allColumns, changedFields, false);
    return Array.from(changedFields);
  }

  private static getRelevantComparisonColumns(before: Record<string, unknown>[], after: Record<string, unknown>[]): string[] {
    const allColumns = new Set([
      ...Object.keys(before[0] || {}),
      ...Object.keys(after[0] || {})
    ]);

    return ColumnUtils.filterRelevantColumns(Array.from(allColumns));
  }

  private static collectChangedFields(before: Record<string, unknown>[], after: Record<string, unknown>[], columns: string[], changedFields: Set<string>, compareMissingRows: boolean): void {
    const maxLength = Math.max(before.length, after.length);

    for (let i = 0; i < maxLength; i++) {
      const beforeRow = before[i];
      const afterRow = after[i];
      if (compareMissingRows ? (!beforeRow && !afterRow) : (!beforeRow || !afterRow)) continue;

      columns.forEach(col => {
        const beforeValue = beforeRow?.[col];
        const afterValue = afterRow?.[col];
        if (beforeValue !== afterValue) {
          changedFields.add(col);
        }
      });
    }
  }

  private static prepareMultiStatementData(previewResult: PreviewResult): Record<string, unknown>[] {
    if (!previewResult.multiResults || previewResult.multiResults.length === 0) {
      return [];
    }

    return previewResult.multiResults.map((result, index) => ({
      '#': index + 1,
      '📋 Action': `${this.getOperationIcon(result.op)} ${result.op.toUpperCase()}`,
      '🗂️ Table': result.table,
      '📊 Rows': Math.max(result.before.length, result.after.length),
      '🔍 Details': this.SHOW_CHANGES_BELOW_LABEL,
      '_operationIndex': index,
      '_operationData': result
    }));
  }

  private static getOperationIcon(operation: string): string {
    switch (operation.toLowerCase()) {
      case 'insert': return '➕';
      case 'update': return '✏️';
      case 'delete': return '🗑️';
      default: return '⚙️';
    }
  }

  private static createActionButtons(previewResult: PreviewResult, container: HTMLElement, context: PreviewRenderContext): void {
    const { op, before, after, multiResults } = previewResult;

    let rowCount: number;
    if (op === 'multi' && multiResults) {
      rowCount = multiResults.reduce((sum, result) => sum + Math.max(result.before.length, result.after.length), 0);
    }
    else {
      rowCount = Math.max(before.length, after.length);
    }

    if (rowCount === 0) {
      return;
    }

    if (op === 'update') {
      const changedFieldCount = this.countChangedFields(before, after);
      if (changedFieldCount === 0) {
        return;
      }
    }

    const buttonsDiv = container.createDiv({ cls: 'vaultquery-preview-buttons' });

    const applyButton = buttonsDiv.createEl('button', {
      cls: 'mod-cta vaultquery-apply-btn',
      text: 'Apply changes'
    });

    applyButton.addEventListener('click', () => {
      void (async () => {
        if (await this.confirmApply(previewResult, context)) {
          container.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          context.onApply?.();
        }
      })();
    });

    const cancelButton = buttonsDiv.createEl('button', {
      cls: 'vaultquery-cancel-btn',
      text: 'Cancel'
    });

    cancelButton.addEventListener('click', () => {
      context.onCancel?.();
    });
  }

  private static async confirmApply(previewResult: PreviewResult, context: PreviewRenderContext): Promise<boolean> {
    const { op, table, before, after } = previewResult;
    const rowCount = Math.max(before.length, after.length);

    let message = '';
    switch (op) {
      case 'insert':
        message = `Insert ${rowCount} row${rowCount !== 1 ? 's' : ''} into "${table}"?`;
        break;
      case 'update':
        message = `Update ${rowCount} row${rowCount !== 1 ? 's' : ''} in "${table}"?`;
        break;
      case 'delete':
        message = `Delete ${rowCount} row${rowCount !== 1 ? 's' : ''} from "${table}"?\n\nThis action cannot be undone.`;
        break;
      case 'multi':
        const operations = previewResult.multiResults?.length || 0;
        message = `Execute ${operations} operations affecting multiple tables?`;
        break;
    }

    const modal = new ConfirmationModal(context.app, message);
    return modal.waitForConfirmation();
  }

  private static countChangedFields(before: Record<string, unknown>[], after: Record<string, unknown>[]): number {
    if (before.length === 0 || after.length === 0) return 0;

    const changedFields = new Set<string>();
    this.collectChangedFields(before, after, this.getRelevantComparisonColumns(before, after), changedFields, true);

    return changedFields.size;
  }
}
