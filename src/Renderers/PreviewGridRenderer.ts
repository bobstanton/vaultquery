import { BaseRenderer } from './BaseRenderer';
import { previewPresentation, type PreviewPresentation } from './PreviewPresentation';
import { QueryRefreshRegistry, resolveAutoRefreshSetting } from './QueryRefreshRegistry';
import { quoteIdentifier } from '../utils/SqlIdentifierUtils';
import { SlickGridRenderer } from './SlickGridRenderer';
import { getErrorMessage } from '../utils/ErrorMessages';
import { ConfirmationModal } from '../Modals/ConfirmationModal';
import { addFloatingButtons } from './OutputChrome';
import { exportNameFor } from './ExportMenu';
import type { RenderContext } from './BaseRenderer';
import { previewRowCount, previewTotalRowCount } from '../Services/PreviewService';
import type { PreviewResult } from '../Services/PreviewService';

declare const activeWindow: Window;

export interface PreviewRenderContext extends RenderContext {
  onApply?: () => void | Promise<void>;
  onApplyPendingChange?: (pending: boolean) => void;
  onCancel?: () => void;
}

export class PreviewGridRenderer {
  private static readonly SHOW_CHANGES_BELOW_LABEL = 'Show changes below';
  private static readonly HIDE_CHANGES_BELOW_LABEL = 'Hide changes below';
  private static readonly DETAILS_COLUMN_ID = 'Details';

  static renderPreview(previewResult: PreviewResult, context: PreviewRenderContext): void {
    const { container } = context;
    const presentation = this.preparePresentation(previewResult);
    const data = presentation.rows;

    SlickGridRenderer.cleanupContainer(container);

    this.createSqlPreviewSection(previewResult, container, context);
    this.createPreviewGrid(previewResult, container, context, data, presentation);
    this.createSummarySection(previewResult, container, presentation);
    this.createActionButtons(previewResult, container, context, presentation);

    addFloatingButtons(container, {
      results: data,
      columns: presentation.columns,
      dataFileColumns: previewResult.dataFileColumns,
      app: context.app,
      exportFolder: context.settings.exportFolder,
      exportName: exportNameFor(context),
      onRefresh: context.onRefresh,
    });

    if (context.onRefresh) {
      const operations = previewResult.multiResults ?? [previewResult];
      const targets = new Set(operations.map(operation => operation.table));
      QueryRefreshRegistry.register(container, {
        onRefresh: context.onRefresh,
        autoRefresh: resolveAutoRefreshSetting(context.settings, context.parsed),
        sql: [context.parsed?.query ?? '', ...[...targets].map(table => `SELECT * FROM ${quoteIdentifier(table)}`)].join(';\n'),
      });
    }
  }

  private static createSummarySection(previewResult: PreviewResult, container: HTMLElement, presentation: PreviewPresentation): void {
    const { op, table } = previewResult;
    const rowCount = previewRowCount(previewResult);

    let summaryText = '';
    let summaryClass = '';

    switch (op) {
      case 'insert':
        summaryText = `✅ ${rowCount} new row${rowCount !== 1 ? 's' : ''} will be inserted into table "${table}".`;
        summaryClass = 'vaultquery-summary-insert';
        break;
      case 'update': {
        const changedFieldCount = presentation.changedFields;

        if (rowCount === 0) {
          summaryText = 'ℹ️ No changes to apply. No rows matched the UPDATE statement.';
        }
        else if (changedFieldCount === 0) {
          summaryText = `ℹ️ No changes to apply. The ${rowCount} matching row${rowCount !== 1 ? 's' : ''} already ${rowCount !== 1 ? 'have' : 'has'} the specified values.`;
        }
        else {
          summaryText = `ℹ️ ${rowCount} row${rowCount !== 1 ? 's' : ''} will be updated in table "${table}". ${changedFieldCount} field${changedFieldCount !== 1 ? 's' : ''} changed.`;
        }

        summaryClass = 'vaultquery-summary-update';
        break;
      }
      case 'delete':
        summaryText = rowCount === 0
          ? 'ℹ️ No rows matched the DELETE statement.'
          : `⚠️ ${rowCount} row${rowCount !== 1 ? 's' : ''} will be deleted from table "${table}".`;

        summaryClass = 'vaultquery-summary-delete';
        break;
      case 'multi': {
        const operations = previewResult.multiResults || [];
        const totalRows = previewTotalRowCount(operations);
        summaryText = `🔄 Multi-statement operation affecting ${totalRows} rows across ${operations.length} operations.`;
        summaryClass = 'vaultquery-summary-multi';
        break;
      }
    }

    container.createDiv({
      cls: `vaultquery-preview-summary ${summaryClass}`,
      text: summaryText
    });
  }

  private static createSqlPreviewSection(previewResult: PreviewResult, container: HTMLElement, context: PreviewRenderContext): void {
    const sqlStatements = previewResult.sqlToApply.map(statement => statement.sql);

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

  private static createPreviewGrid(previewResult: PreviewResult, container: HTMLElement, context: PreviewRenderContext, data: Record<string, unknown>[], presentation: PreviewPresentation): void {
    if (data.length === 0) {
      return;
    }

    const gridContainer = container.createDiv({ cls: 'vaultquery-grid' });

    try {
      const renderContext: RenderContext = {
        results: data,
        dataFileColumns: presentation.columns,
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

    const detailsColumnIndex = self.detailsColumnIndex(previewResult);

    if (detailsColumnIndex < 0) {
      return;
    }

    const handleExpandClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const cell = target.closest('.slick-cell') as HTMLElement;

      if (!cell || !self.isChangeDetailsCell(cell, detailsColumnIndex)) {
        return;
      }

      e.stopPropagation();
      e.preventDefault();

      const row = cell.closest('.slick-row') as HTMLElement;
      if (!row) return;

      const rowIndex = self.rowIndexOfRowElement(row);

      if (rowIndex >= 0 && rowIndex < (previewResult.multiResults?.length || 0)) {
        self.toggleOperationDetails(gridContainer, rowIndex, previewResult, context, detailsColumnIndex);
      }
    };

    gridContainer.addEventListener('click', handleExpandClick, true);
    gridContainer.addEventListener('touchend', handleExpandClick, true);

    // SlickGridRenderer defers grid mounting (scheduleGridEnsure), so the
    // cells to style do not exist yet when this runs.
    const win = gridContainer.ownerDocument.defaultView ?? activeWindow;

    win.setTimeout(() => {
      const cells = gridContainer.querySelectorAll('.slick-cell');

      cells.forEach(cell => {
        if (self.isChangeDetailsCell(cell, detailsColumnIndex)) {
          (cell as HTMLElement).addClass('vaultquery-clickable-cell');
        }
      });
    }, 100);
  }

  private static toggleOperationDetails(gridContainer: HTMLElement, rowIndex: number, previewResult: PreviewResult, context: PreviewRenderContext, detailsColumnIndex: number): void {
    const operationData = previewResult.multiResults?.[rowIndex];
    if (!operationData) return;

    const existingDetails = gridContainer.querySelector(`[data-details-for="${rowIndex}"]`);

    if (existingDetails) {
      this.removeOperationDetails(existingDetails);
      this.updateOperationDetailsLabel(gridContainer, rowIndex, false, detailsColumnIndex);

      return;
    }

    const allDetails = gridContainer.querySelectorAll('[data-details-for]');

    allDetails.forEach(el => {
      const detailsFor = Number(el.getAttribute('data-details-for'));
      this.removeOperationDetails(el);

      if (!Number.isNaN(detailsFor)) {
        this.updateOperationDetailsLabel(gridContainer, detailsFor, false, detailsColumnIndex);
      }
    });

    const rowElement = this.findRowElement(gridContainer, rowIndex);

    const detailsContainer = gridContainer.createDiv();
    detailsContainer.detach();
    detailsContainer.className = 'vaultquery-operation-details';
    detailsContainer.setAttribute('data-details-for', rowIndex.toString());

    const title = detailsContainer.createDiv({ cls: 'vaultquery-subgrid-title' });
    const strong = title.createEl('strong');
    strong.appendText(`${this.getOperationIcon(operationData.op)} `);
    strong.appendText(`${operationData.op.toUpperCase()} Details - ${operationData.table} table`);

    const presentation = this.preparePresentation(operationData);
    const detailedData = presentation.rows;

    if (detailedData.length > 0) {
      const subgridContainer = detailsContainer.createDiv({ cls: 'vaultquery-subgrid' });

      const subRenderContext: RenderContext = {
        results: detailedData,
        dataFileColumns: presentation.columns,
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

    this.updateOperationDetailsLabel(gridContainer, rowIndex, true, detailsColumnIndex);
  }

  private static removeOperationDetails(element: Element): void {
    if (element.instanceOf(HTMLElement)) {
      SlickGridRenderer.cleanupContainer(element);
    }

    element.remove();
  }

  private static detailsColumnIndex(previewResult: PreviewResult): number {
    const rows = this.prepareMultiStatementData(previewResult);

    if (rows.length === 0) {
      return -1;
    }

    return Object.keys(rows[0])
      .filter(key => !key.startsWith('_'))
      .indexOf(this.DETAILS_COLUMN_ID);
  }

  private static isChangeDetailsCell(cell: Element, detailsColumnIndex: number): boolean {
    // SlickGrid stamps positional classes (l{index} r{index}) on every cell.
    return detailsColumnIndex >= 0 && cell.classList.contains(`l${detailsColumnIndex}`);
  }

  /**
   * SlickGrid exposes no row-index attribute on .slick-row elements; rows are
   * absolutely positioned at index x rowHeight.
   */
  private static rowIndexOfRowElement(row: HTMLElement): number {
    const topPx = parseInt(row.style.top);
    const height = row.offsetHeight;

    if (isNaN(topPx) || height <= 0) {
      return -1;
    }

    return Math.round(topPx / height);
  }

  private static findRowElement(gridContainer: HTMLElement, rowIndex: number): HTMLElement | null {
    for (const row of Array.from(gridContainer.querySelectorAll<HTMLElement>('.slick-row'))) {
      if (this.rowIndexOfRowElement(row) === rowIndex) {
        return row;
      }
    }

    return null;
  }

  private static updateOperationDetailsLabel(gridContainer: HTMLElement, rowIndex: number, expanded: boolean, detailsColumnIndex: number): void {
    const row = this.findRowElement(gridContainer, rowIndex);

    if (!row) {
      return;
    }

    const label = expanded ? this.HIDE_CHANGES_BELOW_LABEL : this.SHOW_CHANGES_BELOW_LABEL;

    row.querySelectorAll('.slick-cell').forEach(cell => {
      if (!this.isChangeDetailsCell(cell, detailsColumnIndex)) {
        return;
      }

      cell.textContent = label;

      if (cell.instanceOf(HTMLElement)) {
        cell.addClass('vaultquery-clickable-cell');
      }
    });
  }

  private static preparePresentation(result: PreviewResult): PreviewPresentation {
    if (result.op === 'multi') return { rows: this.prepareMultiStatementData(result), changedFields: 0 };

    return previewPresentation(result, { columns: result.dataFileColumns, preserveText: Boolean(result.dataFileColumns),
      rowKey: result.dataFileColumns ? '_vq_row_id' : undefined });
  }

  private static prepareMultiStatementData(previewResult: PreviewResult): Record<string, unknown>[] {
    if (!previewResult.multiResults || previewResult.multiResults.length === 0) {
      return [];
    }

    return previewResult.multiResults.map((result, index) => ({
      '#': index + 1,
      'Action': `${this.getOperationIcon(result.op)} ${result.op.toUpperCase()}`,
      'Table': result.table,
      'Rows': previewRowCount(result),
      [this.DETAILS_COLUMN_ID]: this.SHOW_CHANGES_BELOW_LABEL,
      '_operationIndex': index,
      '_operationData': result
    }));
  }

  private static getOperationIcon(operation: string): string {
    switch (operation) {
      case 'insert': return '➕';
      case 'update': return '✏️';
      case 'delete': return '🗑️';
      default: return '⚙️';
    }
  }

  private static createActionButtons(previewResult: PreviewResult, container: HTMLElement, context: PreviewRenderContext, presentation: PreviewPresentation): void {
    const { op, multiResults } = previewResult;

    let rowCount: number;

    if (op === 'multi' && multiResults) {
      rowCount = previewTotalRowCount(multiResults);
    }
    else {
      rowCount = previewRowCount(previewResult);
    }

    if (rowCount === 0) {
      return;
    }

    if (op === 'update') {
      const changedFieldCount = presentation.changedFields;

      if (changedFieldCount === 0) {
        return;
      }
    }

    const buttonsDiv = container.createDiv({ cls: 'vaultquery-preview-buttons' });

    const applyButton = buttonsDiv.createEl('button', {
      cls: 'mod-cta vaultquery-apply-btn',
      text: 'Apply changes'
    });

    let applyPending = false;
    applyButton.addEventListener('click', () => {
      if (applyPending) return;
      applyPending = true;
      context.onApplyPendingChange?.(true);
      void (async () => {
        try {
          if (await this.confirmApply(previewResult, context)) {
            container.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            await context.onApply?.();
          }
        }
        finally {
          applyPending = false;
          context.onApplyPendingChange?.(false);
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
    const { op, table } = previewResult;
    const rowCount = previewRowCount(previewResult);

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
      case 'multi': {
        const operations = previewResult.multiResults?.length || 0;
        const tables = new Set(previewResult.multiResults?.map(result => result.table));

        message = tables.size === 1
          ? `Execute ${operations} operations in "${[...tables][0]}"?`
          : `Execute ${operations} operations affecting multiple tables?`;

        break;
      }
    }

    const modal = new ConfirmationModal(context.app, message);

    return modal.waitForConfirmation();
  }
}
