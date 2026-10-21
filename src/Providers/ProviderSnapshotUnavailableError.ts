export class ProviderSnapshotUnavailableError extends Error {
  public constructor(message: string, public readonly tableName?: string) {
    super(message);
    this.name = 'ProviderSnapshotUnavailableError';
  }
}
