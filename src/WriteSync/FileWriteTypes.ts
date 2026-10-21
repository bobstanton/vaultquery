export class FilePreviewStaleError extends Error {
  readonly code = 'FILE_PREVIEW_STALE';
  constructor(message = 'The file preview expired or was invalidated. Generate a fresh preview.') {
    super(message);
    this.name = 'FilePreviewStaleError';
  }
}

export type FileWritePhase = 'preflight' | 'write' | 'verify' | 'index' | 'save';

export class FileWriteApplyError extends Error {
  readonly code = 'FILE_WRITE_APPLY_FAILED';
  constructor(message: string, public readonly phase: FileWritePhase,
    public readonly completedPaths: string[], public readonly unknownPaths: string[],
    public readonly untouchedPaths: string[], public readonly failedPath?: string) {
    super(message);
    this.name = 'FileWriteApplyError';
  }
}
