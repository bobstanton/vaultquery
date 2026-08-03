import { TFile } from 'obsidian';

export type NoteSource = string | TFile;

export interface NoteRecord {
  path: string;
  title: string;
  content: string;
  created: number;
  modified: number;
  size: number;
}

export interface IndexNoteData {
  note: NoteRecord;
  frontmatterData?: Array<{
    key: string;
    value: string;
    valueType: string;
    arrayIndex: number | null;
  }>;
  tables?: Array<{
    table_index: number;
    table_name?: string;
    block_id?: string;
    start_offset: number;
    end_offset: number;
    line_number: number;
  }>;
  tableCells?: TableCellData[];
  tasks?: TaskData[];
  headings?: Array<{
    level: number;
    heading_text: string;
    line_number: number;
    block_id?: string;
    start_offset?: number;
    end_offset?: number;
    anchor_hash?: string;
  }>;
  links?: Array<{
    link_text: string;
    link_target: string;
    link_target_path: string | null;
    link_type: string;
    line_number: number | null;
    original: string | null;
    start_offset: number | null;
    end_offset: number | null;
    frontmatter_key: string | null;
  }>;
  unresolvedLinks?: Array<{
    link_target: string;
    link_count: number;
  }>;
  embeds?: Array<{
    embed_text: string;
    embed_target: string;
    embed_target_path: string | null;
    line_number: number;
  }>;
  tags?: Array<{
    tag_name: string;
    line_number: number;
  }>;
  listItems?: ListItemData[];
  blocks?: Array<{
    block_id: string;
    line_number: number;
    start_offset: number;
    end_offset: number;
    section_type: string | null;
  }>;
  userViews?: UserViewData[];
  userFunctions?: UserFunctionData[];
  userTriggers?: UserTriggerData[];
}

export interface IndexingProgress {
  current: number;
  total: number;
  currentFile: string;
}

export interface IndexingStatus {
  isIndexing: boolean;
  progress?: IndexingProgress;
}

export interface ParsedQuery {
  query: string;
  output?: {
    kind: 'table' | 'markdown' | 'chart' | 'calendar' | 'template';
    options?: Record<string, unknown>;
  };
  template?: string;
}

export interface UserViewData {
  view_name: string;
  sql: string;
}

export interface UserFunctionData {
  function_name: string;
  source: string;
}

export interface UserTriggerData {
  trigger_name: string;
  trigger_sql: string;
}

export interface IndexingStats {
  timestamp: number;
  totalFiles: number;
  totalTime: number;
  avgTimePerFile: number;
  filesPerSecond: number;
  slowFiles: Array<{
    path: string;
    size: number;
    processingTime: number;
    details: string;
  }>;
}

export interface TableCellData {
  tableIndex: number;
  tableName: string | null;
  rowIndex: number;
  columnName: string;
  cellValue: string;
  lineNumber: number;
}

export interface TaskData {
  line_number: number;
  task_text: string;
  status: string;
  completed?: boolean;
  priority?: string;
  due_date?: string;
  scheduled_date?: string;
  start_date?: string;
  created_date?: string;
  done_date?: string;
  cancelled_date?: string;
  recurrence?: string;
  on_completion?: string;
  task_id?: string;
  depends_on?: string;
  tags?: string;
  block_id?: string;
  start_offset?: number;
  end_offset?: number;
  anchor_hash?: string;
  section_heading?: string;
}

export interface TaskMetadataFields {
  priority: string | null;
  due_date: string | null;
  scheduled_date: string | null;
  start_date: string | null;
  created_date: string | null;
  done_date: string | null;
  cancelled_date: string | null;
  recurrence: string | null;
  on_completion: string | null;
  task_id: string | null;
  depends_on: string | null;
  tags: string | null;
  block_id: string | null;
  anchor_hash: string | null;
  start_offset: number | null;
  end_offset: number | null;
  section_heading: string | null;
}

export interface ListItemData {
  list_index: number;
  item_index: number;
  parent_index: number | null;
  content: string;
  list_type: 'bullet' | 'number';
  indent_level: number;
  line_number: number;
  block_id?: string;
  start_offset?: number;
  end_offset?: number;
  anchor_hash?: string;
}

export {};
