import { IMAGE_FACT_FIELDS } from './ImageTypes';
import type { SchemaTable } from '../Database/SchemaDocumentation';

export const IMAGE_SCHEMA: SchemaTable[] = [
  { name: 'image_files', description: 'Indexed image metadata; read-only', isView: false, columns: [
      { name: 'path', type: 'TEXT', description: 'Vault-relative or absolute external path; primary key' },
      { name: 'name', type: 'TEXT', description: 'Filename with its final suffix' },
      { name: 'basename', type: 'TEXT', description: 'Filename without its final suffix' },
      { name: 'extension', type: 'TEXT', description: 'Lowercase file type' },
      { name: 'folder', type: 'TEXT', description: 'Parent folder; empty at the root' },
      { name: 'size', type: 'INTEGER', description: 'Source byte count' },
      { name: 'created', type: 'REAL', description: 'Creation time in milliseconds' },
      { name: 'modified', type: 'REAL', description: 'Source modification time in milliseconds' },
      { name: 'revision', type: 'TEXT', description: 'Indexed source stat token' },
      { name: 'indexed', type: 'REAL', description: 'Metadata indexing time in milliseconds' },
      { name: 'source', type: 'TEXT', description: "The external folder a file came from, or 'vault'" },
      { name: 'metadata_status', type: 'TEXT', description: 'ready, no_metadata, unsupported, or read_error' },
      { name: 'metadata_error', type: 'TEXT', description: 'Indexing error, or NULL' },
      { name: 'tag_count', type: 'INTEGER', description: 'Tags stored for this image' },
      { name: 'bytes_read', type: 'INTEGER', description: 'Bytes read to extract the metadata' },
      ...IMAGE_FACT_FIELDS,
      { name: 'metadata', type: 'TEXT', description: 'Every tag as JSON, grouped by section' },
    ],
    notes: [
      "Metadata from vault images and configured external folders. Requires Index image metadata. The table is read-only. Exclude patterns apply; there is no size limit and no extension setting.",
      "Reading stops once the metadata is complete. bytes_read records the bytes read for each image.",
      "location contains latitude and longitude as text. Coordinates use signed decimal degrees; captured is UTC when the camera recorded an offset."
    ] },
  { name: 'image_metadata', description: 'One row per stored metadata tag; read-only', isView: true, columns: [
      { name: 'path', type: 'TEXT', description: 'Image path; joins image_files' },
      { name: 'section', type: 'TEXT', description: 'Tag group, such as exif, gps, xmp, iptc, or icc' },
      { name: 'tag', type: 'TEXT', description: 'Tag name as the format records it' },
      { name: 'value', type: 'TEXT/REAL', description: '' },
      { name: 'value_num', type: 'REAL', description: 'Numeric values repeated for comparison; NULL for text' },
    ],
    notes: [
      "Read-only view of the stored tags in image_files.metadata."
    ] },
];
