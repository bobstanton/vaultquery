import type { TableStructure } from './DatabaseSchema';

export interface VaultFileAdapter {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

/** Schema operations may be sync on the main thread or async across the worker boundary. */
export interface ISchemaManager {
  getAllPropertyKeys(): string[] | Promise<string[]>;
  getViewNames(): string[] | Promise<string[]>;
  getViewColumns(viewName: string): string[] | Promise<string[]>;
  rebuildPropertiesView(): void | Promise<void>;
  rebuildTableViews(enableDynamicTableViews: boolean): void | Promise<void>;
  discoverTableStructures(): TableStructure[] | Promise<TableStructure[]>;
}
