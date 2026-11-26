export interface SqlCompletionRequest {
  sql: string;
  cursor: number;
  explicit?: boolean;
  scope?: 'query' | 'trigger';
}

export interface SqlCompletionItem {
  label: string;
  displayLabel?: string;
  apply: string;
  detail?: string;
  type?: string;
  boost?: number;
  cursorOffset?: number;
}

export interface SqlCompletionResult {
  from: number;
  to: number;
  items: SqlCompletionItem[];
}

export type SqlCompletionProvider = (request: SqlCompletionRequest) => Promise<SqlCompletionResult | null>;
