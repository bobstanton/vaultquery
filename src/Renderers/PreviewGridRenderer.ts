import { BaseRenderer } from './BaseRenderer';
import { SlickGridRenderer } from './SlickGridRenderer';
import { ColumnUtils } from '../utils/ColumnUtils';
import { getErrorMessage } from '../utils/ErrorMessages';
import { ConfirmationModal } from '../Modals/ConfirmationModal';
import { generateUniqueId } from '../utils/StringUtils';
import type { RenderContext } from './BaseRenderer';
import type { PreviewResult } from '../Services/PreviewService';

declare const activeWindow: Window;
declare const activeDocument: Document;

export interface PreviewRenderContext extends RenderContext {
  onApply?: () => void;
  onCancel?: () => void;
}

export class PreviewGridRenderer {
  static renderPreview(previewResult: PreviewResult, context: PreviewRenderContext): void {
    const { container } = context;

    container.empty();

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
      SlickGridRenderer.registerRefreshCallback(containerId, context.onRefresh);
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
        if (changedFieldCount === 0) {
          summaryText = `ℹ️ No changes to apply. The ${rowCount} matching row${rowCount !== 1 ? 's' : ''} already ${rowCount !== 1 ? 'have' : 'has'} the specified values.`;
        }
        else {
          summaryText = `ℹ️ ${rowCount} row${rowCount !== 1 ? 's' : ''} will be updated in table "${table}". ${changedFieldCount} field${changedFieldCount !== 1 ? 's' : ''} changed.`;
        }
        summaryClass = 'vaultquery-summary-update';
        break;
      case 'delete':
        summaryText = `⚠️ ${rowCount} row${rowCount !== 1 ? 's' : ''} will be deleted from table "${table}".`;
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
        settings: context.settings,
        onRefresh: context.onRefresh
      };

      SlickGridRenderer.render(renderContext);
      
      if (previewResult.op === 'multi') {
        this.setupMultiStatementExpansion(gridContainer, previewResult, context);
      }
    }
    catch (error: unknown) {
      gridContainer.createDiv({
        cls: 'vaultquery-error',
        text: `Preview rendering failed: ${getErrorMessage(error)}`
      });
    }
  }

  private static setupMultiStatementExpansion(gridContainer: HTMLElement, previewResult: PreviewResult, context: PreviewRenderContext): void {
    const self = PreviewGridRenderer;

    const handleExpandClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const cell = target.closest('.slick-cell') as HTMLElement;

      if (!cell || !cell.textContent?.includes('Click to expand')) {
        return;
      }

      e.stopPropagation();
      e.preventDefault();

      // Find the row element and get its index
      // SlickGrid uses different attribute names - try both 'row' and data attributes
      const row = cell.closest('.slick-row') as HTMLElement;
      if (!row) return;

      // Try multiple ways to get the row index
      let rowIndex = -1;

      // Method 1: 'row' attribute (some SlickGrid versions)
      const rowAttr = row.getAttribute('row');
      if (rowAttr !== null) {
        rowIndex = parseInt(rowAttr);
      }

      // Method 2: Parse from style.top (SlickGrid uses absolute positioning)
      if (rowIndex < 0) {
        const style = row.style.top;
        if (style) {
          // Row height is 32px (from options.rowHeight)
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

    activeWindow.setTimeout(() => {
      const cells = gridContainer.querySelectorAll('.slick-cell');
      cells.forEach(cell => {
        if (cell.textContent?.includes('Click to expand')) {
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
      existingDetails.remove();
      return;
    }

    const allDetails = gridContainer.querySelectorAll('[data-details-for]');
    allDetails.forEach(el => el.remove());

    const rowElement = gridContainer.querySelector(`.slick-row[row="${rowIndex}"]`);

    const detailsContainer = activeDocument.createElement('div');
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
        settings: context.settings,
        onRefresh: context.onRefresh
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

    const relevantKeys = ColumnUtils.filterRelevantColumns(Object.keys(after[0]));
    
    return after.map(row => {
      const filteredRow: Record<string, unknown> = {};
      relevantKeys.forEach(key => {
        filteredRow[key] = row[key] ?? '';
      });
      return filteredRow;
    });
  }

  private static prepareDeleteData(before: Array<Record<string, unknown>>): Record<string, unknown>[] {
    if (before.length === 0) return [];

    const relevantKeys = ColumnUtils.filterRelevantColumns(Object.keys(before[0]));
    
    return before.map(row => {
      const filteredRow: Record<string, unknown> = {};
      relevantKeys.forEach(key => {
        filteredRow[key] = row[key] ?? '';
      });
      return filteredRow;
    });
  }

  private static prepareUpdateData(before: Record<string, unknown>[], after: Record<string, unknown>[], pkCols: string[]): Record<string, unknown>[] {
    if (before.length === 0 || after.length === 0) return [];

    const allColumns = new Set([
      ...Object.keys(before[0] || {}),
      ...Object.keys(after[0] || {})
    ]);

    const relevantColumns = ColumnUtils.filterRelevantColumns(Array.from(allColumns));
    const relevantPkCols = ColumnUtils.filterRelevantColumns(pkCols);

    // Use index-based matching since PK columns might have changed
    const changedFields = this.findChangedFieldsByIndex(before, after, relevantColumns);

    if (changedFields.length === 0) {
      return [];
    }

    // Determine which PK columns are changing
    const changingPkCols = relevantPkCols.filter(pk => changedFields.includes(pk));
    const stablePkCols = relevantPkCols.filter(pk => !changedFields.includes(pk));

    return before.map((beforeRow, index) => {
      const afterRow = after[index] || {};
      const resultRow: Record<string, unknown> = {};

      // Add stable PK columns (not changing) as simple values
      stablePkCols.forEach(pk => {
        const value = beforeRow[pk];
        // Skip array_index if null/empty
        if (pk === 'array_index' && (value === null || value === undefined || value === '')) {
          return;
        }
        resultRow[pk] = value ?? '';
      });

      // Add path if not already included
      if (beforeRow.path !== undefined && !stablePkCols.includes('path') && !changingPkCols.includes('path')) {
        resultRow['path'] = beforeRow.path;
      }

      // Add task_text if present, not a PK, and not being changed
      if (beforeRow.task_text !== undefined && !relevantPkCols.includes('task_text') && !changedFields.includes('task_text')) {
        resultRow['task_text'] = beforeRow.task_text;
      }

      // For properties table, always show value if present
      if (beforeRow.value !== undefined && !changedFields.includes('value')) {
        resultRow['value'] = beforeRow.value;
      }

      // Show ALL changed fields (including PK columns and task_text) with current/proposed
      changedFields.forEach(col => {
        if (col !== 'path') {
          const beforeValue = beforeRow[col] ?? '';
          const afterValue = afterRow[col] ?? '';

          // Skip array_index if both values are null/empty
          if (col === 'array_index' &&
            (beforeValue === null || beforeValue === undefined || beforeValue === '') &&
            (afterValue === null || afterValue === undefined || afterValue === '')) {
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
    const maxLength = Math.max(before.length, after.length);

    for (let i = 0; i < maxLength; i++) {
      const beforeRow = before[i];
      const afterRow = after[i];
      if (!beforeRow || !afterRow) continue;

      allColumns.forEach(col => {
        if (beforeRow[col] !== afterRow[col]) {
          changedFields.add(col);
        }
      });
    }

    return Array.from(changedFields);
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
      '🔍 Details': 'Click to expand',
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

    applyButton.addEventListener('click', async () => {
      if (await this.confirmApply(previewResult, context)) {
        container.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        context.onApply?.();
      }
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
        message = `Are you sure you want to insert ${rowCount} row${rowCount !== 1 ? 's' : ''} into "${table}"?`;
        break;
      case 'update':
        message = `Are you sure you want to update ${rowCount} row${rowCount !== 1 ? 's' : ''} in "${table}"?`;
        break;
      case 'delete':
        message = `Are you sure you want to delete ${rowCount} row${rowCount !== 1 ? 's' : ''} from "${table}"?\n\nThis action cannot be undone.`;
        break;
      case 'multi':
        const operations = previewResult.multiResults?.length || 0;
        message = `Are you sure you want to execute ${operations} operations affecting multiple tables?`;
        break;
    }

    const modal = new ConfirmationModal(context.app, message);
    return modal.waitForConfirmation();
  }

  private static countChangedFields(before: Record<string, unknown>[], after: Record<string, unknown>[]): number {
    if (before.length === 0 || after.length === 0) return 0;

    const allColumns = new Set([
      ...Object.keys(before[0] || {}),
      ...Object.keys(after[0] || {})
    ]);
    const relevantColumns = ColumnUtils.filterRelevantColumns(Array.from(allColumns));

    const changedFields = new Set<string>();
    const maxLength = Math.max(before.length, after.length);

    for (let i = 0; i < maxLength; i++) {
      const beforeRow = before[i];
      const afterRow = after[i];

      if (!beforeRow && !afterRow) continue;

      relevantColumns.forEach(col => {
        const beforeValue = beforeRow?.[col];
        const afterValue = afterRow?.[col];
        if (beforeValue !== afterValue) {
          changedFields.add(col);
        }
      });
    }

    return changedFields.size;
  }
}