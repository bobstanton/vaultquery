import type { SchemaTable } from '../Database/SchemaDocumentation';

export const OTHER_FILE_SCHEMA: SchemaTable[] = [
  { name: 'other_files', description: 'Indexed file contents; external files are read-only', isView: false, columns: [
      { name: 'path', type: 'TEXT', description: 'Vault-relative or absolute external path' },
      { name: 'name', type: 'TEXT', description: 'Filename with its final suffix' },
      { name: 'basename', type: 'TEXT', description: 'Filename without its final suffix' },
      { name: 'extension', type: 'TEXT', description: 'Lowercase file type' },
      { name: 'folder', type: 'TEXT', description: 'Parent folder; empty at the root' },
      { name: 'size', type: 'INTEGER', description: 'Source byte count' },
      { name: 'created', type: 'REAL', description: 'Creation time in milliseconds' },
      { name: 'modified', type: 'REAL', description: 'Source modification time in milliseconds' },
      { name: 'revision', type: 'TEXT', description: 'Indexed source stat token' },
      { name: 'indexed', type: 'REAL', description: 'File indexing time in milliseconds' },
      { name: 'source', type: 'TEXT', description: "The external folder a file came from, or 'vault'" },
      { name: 'content_status', type: 'TEXT', description: 'ready, too_large, or read_error' },
      { name: 'content_error', type: 'TEXT', description: 'Indexing error, or NULL' },
      { name: 'content_bytes', type: 'INTEGER', description: 'Stored content byte count; zero when unavailable' },
      { name: 'content', type: 'TEXT/BLOB', description: 'Indexed text or binary contents' },
    ],
    notes: [
      "Contents of vault files and configured external files matching Index other file content. The list is the only file-type filter, including md or csv when selected. Existing exclude patterns and size limits apply. Contents preserve original text or binary bytes, including Markdown frontmatter and CSV headers when those types are selected.",
      "Vault paths support INSERT(path, content) to create a file, UPDATE to replace content, and DELETE to trash the file. External paths are read-only. Other columns are read-only. Prepared INSERT, UPDATE, and DELETE share Enable write operations and require real-time indexing and a selected path. Updates replace the complete file, including Markdown frontmatter or CSV headers. Direct execute() writes are blocked.",
      "Use typeof(content) = 'text' for text operations. Empty files contain empty text. Binary SQL results are Uint8Array values; use hex(content) for text exports. Queries read the indexed snapshot without opening vault files."
    ] },
];
