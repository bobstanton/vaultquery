import { Menu, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { EXPORT_FORMATS, exportChunks } from '../utils/ResultExport';
import { buildCapped, copyToClipboard, exportCapabilities, exportFileName, saveExport } from '../Export/ExportTargets';
import type { ExportTargetKind } from '../Export/ExportTargets';
import { logger as rootLogger } from '../utils/logger';

const logger = rootLogger.scope('Export');

const OFFERED: Array<'md' | 'csv' | 'json'> = ['md', 'csv', 'json'];

export interface ExportSource {
  app?: App;
  exportFolder: string;
  readRows: () => Record<string, unknown>[];
  readColumns?: () => readonly string[] | undefined;
  dataFileColumns?: readonly string[];
  name: string;
}

const TARGET_LABELS: Record<ExportTargetKind, string> = {
  dialog: 'Save as',
  downloads: 'Save to Downloads as',
  vault: 'Save to the vault as',
};

function chunks(source: ExportSource, rows: Record<string, unknown>[], format: 'md' | 'csv' | 'json'): () => Iterable<string> {
  const columns = source.readColumns?.();

  return () => exportChunks(rows, format, { columns, dataFileColumns: source.dataFileColumns });
}

function describe(rows: number, format: 'md' | 'csv' | 'json'): string {
  return `${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'} as ${EXPORT_FORMATS[format].label}`;
}

export function showExportMenu(event: MouseEvent, source: ExportSource): void {
  const capabilities = exportCapabilities();
  const target = capabilities.target;
  const menu = new Menu();

  for (const format of OFFERED) {
    menu.addItem(item => item.setSection('copy').setTitle(`Copy as ${EXPORT_FORMATS[format].label}`).setIcon('clipboard')
      .onClick(() => { void copy(source, format, capabilities.clipboardLimitBytes); }));
  }

  if (source.app) {
    for (const format of OFFERED) {
      menu.addItem(item => item.setSection('save').setTitle(`${TARGET_LABELS[target]} ${EXPORT_FORMATS[format].label}`).setIcon('download')
        .onClick(() => { void save(source, format, target); }));
    }
  }

  menu.showAtMouseEvent(event);
}

async function copy(source: ExportSource, format: 'md' | 'csv' | 'json', limitBytes: number): Promise<void> {
  try {
    const rows = source.readRows();
    const body = buildCapped(chunks(source, rows, format)(), limitBytes);

    if (body === undefined) {
      new Notice(`Too large to copy (over ${Math.round(limitBytes / 1024).toLocaleString()} KB). Save it to a file instead.`);

      return;
    }

    await copyToClipboard(body);
    new Notice(`Copied ${describe(rows.length, format)}`);
  } catch (error) {
    logger.error('Copy failed', error);
    new Notice(error instanceof Error ? error.message : 'The rows could not be copied.');
  }
}

async function save(source: ExportSource, format: 'md' | 'csv' | 'json', target: ExportTargetKind): Promise<void> {
  const app = source.app;
  if (!app) return;

  try {
    const rows = source.readRows();
    const descriptor = EXPORT_FORMATS[format];
    const file = { name: exportFileName(source.name, descriptor.extension), chunks: chunks(source, rows, format), mime: descriptor.mime };
    const saved = await saveExport(app, file, target, source.exportFolder);
    new Notice(`Saved ${describe(rows.length, format)} to ${saved.label}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    logger.error('Export failed', error);
    new Notice(error instanceof Error ? error.message : 'The rows could not be saved.');
  }
}

export function exportNameFor(context: { sourcePath?: string }): string {
  const path = context.sourcePath ?? '';
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');

  return name || 'vaultquery';
}
