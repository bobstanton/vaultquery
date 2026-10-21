export interface OtherFileMetadata {
  path: string;
  name: string;
  basename: string;
  extension: string;
  folder: string;
  size: number | null;
  created: number | null;
  modified: number | null;
  revision: string | null;
  indexed: number;
  source: string;
}

type OtherFileStatus = 'ready' | 'too_large' | 'read_error';

export interface OtherFileState extends OtherFileMetadata {
  content_status: OtherFileStatus;
  content_error: string | null;
  content_bytes: number;
}

export interface IndexedOtherFile extends OtherFileState {
  content: string | Uint8Array | null;
}

export interface OtherFilePublication {
  rows: IndexedOtherFile[];
  removed: string[];
}

export interface IndexableFile {
  path: string;
  stat: { size: number; mtime: number; ctime: number };
}
