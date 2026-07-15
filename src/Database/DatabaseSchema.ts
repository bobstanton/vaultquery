import { escapeSqlString, quoteIdentifier } from '../utils/SqlIdentifierUtils';

const TABLE_DEFINITIONS = `
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  created INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  modified INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  size INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS properties (
  path TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL,
  array_index INTEGER,
  PRIMARY KEY (path, key, array_index),
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS table_cells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  table_index INTEGER NOT NULL DEFAULT 0,
  table_name TEXT,
  row_index INTEGER NOT NULL,
  column_name TEXT NOT NULL,
  cell_value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'text',
  line_number INTEGER,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  task_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'TODO',
  priority TEXT,
  due_date TEXT,
  scheduled_date TEXT,
  start_date TEXT,
  created_date TEXT,
  done_date TEXT,
  cancelled_date TEXT,
  recurrence TEXT,
  on_completion TEXT,
  task_id TEXT,
  depends_on TEXT,
  tags TEXT,
  line_number INTEGER,
  block_id TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  anchor_hash TEXT,
  section_heading TEXT,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS headings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  level INTEGER NOT NULL,
  line_number INTEGER,
  heading_text TEXT NOT NULL,
  block_id TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  anchor_hash TEXT,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  link_text TEXT NOT NULL DEFAULT '',
  link_target TEXT NOT NULL,
  link_target_path TEXT,
  link_type TEXT NOT NULL DEFAULT '',
  line_number INTEGER,
  insert_position TEXT,
  original TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  frontmatter_key TEXT,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS unresolved_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  link_target TEXT NOT NULL,
  link_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS embeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  embed_text TEXT NOT NULL DEFAULT '',
  embed_target TEXT NOT NULL,
  embed_target_path TEXT,
  line_number INTEGER,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  line_number INTEGER,
  insert_position TEXT,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  list_index INTEGER DEFAULT 0,
  item_index INTEGER DEFAULT 0,
  parent_index INTEGER,
  content TEXT NOT NULL,
  list_type TEXT NOT NULL DEFAULT 'bullet',
  indent_level INTEGER NOT NULL DEFAULT 0,
  line_number INTEGER,
  block_id TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  anchor_hash TEXT,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  block_id TEXT NOT NULL,
  line_number INTEGER,
  start_offset INTEGER,
  end_offset INTEGER,
  section_type TEXT,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tables (
  path TEXT NOT NULL,
  table_index INTEGER NOT NULL DEFAULT 0,
  table_name TEXT,
  block_id TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  line_number INTEGER,
  PRIMARY KEY (path, table_index),
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _constraint_checks (
  table_name TEXT PRIMARY KEY,
  constraints_validated INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS _user_views (
  view_name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  sql TEXT NOT NULL,
  sql_hash TEXT
);

CREATE TABLE IF NOT EXISTS _user_functions (
  function_name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  source_hash TEXT
);

CREATE TABLE IF NOT EXISTS _user_triggers (
  trigger_name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  trigger_sql TEXT NOT NULL,
  sql_hash TEXT,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
`;

const CORE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_properties_key ON properties(key);
CREATE INDEX IF NOT EXISTS idx_user_views_path ON _user_views(path);
CREATE INDEX IF NOT EXISTS idx_user_functions_path ON _user_functions(path);
CREATE INDEX IF NOT EXISTS idx_user_triggers_path ON _user_triggers(path);
`;

// Deduplication: remove duplicate rows before creating unique index (keeps row with lowest rowid)
// Handles stale data from anchor_hash computation changes.
const TASK_DEDUP = `
DELETE FROM tasks WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM tasks WHERE COALESCE(block_id, anchor_hash) IS NOT NULL
  GROUP BY path, COALESCE(block_id, anchor_hash)
) AND COALESCE(block_id, anchor_hash) IS NOT NULL;
`;

const TASK_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tasks_path ON tasks(path);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_natural ON tasks(path, COALESCE(block_id, anchor_hash)) WHERE COALESCE(block_id, anchor_hash) IS NOT NULL;
`;

const HEADING_DEDUP = `
DELETE FROM headings WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM headings WHERE COALESCE(block_id, anchor_hash) IS NOT NULL
  GROUP BY path, COALESCE(block_id, anchor_hash)
) AND COALESCE(block_id, anchor_hash) IS NOT NULL;
`;

const HEADING_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_headings_path ON headings(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_headings_natural ON headings(path, COALESCE(block_id, anchor_hash)) WHERE COALESCE(block_id, anchor_hash) IS NOT NULL;
`;

const LINK_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_links_path ON links(path);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(link_target);
CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(link_target_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_links_path ON unresolved_links(path);
CREATE INDEX IF NOT EXISTS idx_unresolved_links_target ON unresolved_links(link_target);
`;

const EMBED_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_embeds_path ON embeds(path);
CREATE INDEX IF NOT EXISTS idx_embeds_target ON embeds(embed_target);
CREATE INDEX IF NOT EXISTS idx_embeds_target_path ON embeds(embed_target_path);
`;

const TAG_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tags_path ON tags(path);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(tag_name);
`;

// Deduplication: remove duplicate rows before creating unique index
const LIST_ITEM_DEDUP = `
DELETE FROM list_items WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM list_items WHERE COALESCE(block_id, anchor_hash) IS NOT NULL
  GROUP BY path, COALESCE(block_id, anchor_hash)
) AND COALESCE(block_id, anchor_hash) IS NOT NULL;
`;

const LIST_ITEM_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_list_items_path ON list_items(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_list_items_natural ON list_items(path, COALESCE(block_id, anchor_hash)) WHERE COALESCE(block_id, anchor_hash) IS NOT NULL;
`;

const BLOCK_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_blocks_path ON blocks(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_blocks_path_block_id ON blocks(path, block_id);
`;

const TABLE_CELL_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_table_cells_path ON table_cells(path);
CREATE INDEX IF NOT EXISTS idx_table_cells_composite ON table_cells(path, table_index, row_index, column_name);
`;

export interface EnabledFeatures {
  indexContent: boolean;
  indexFrontmatter: boolean;
  indexTables: boolean;
  indexTasks: boolean;
  indexHeadings: boolean;
  indexLinks: boolean;
  indexUnresolvedLinks: boolean;
  indexEmbeds: boolean;
  indexTags: boolean;
  indexListItems: boolean;
  indexBlocks: boolean;
}

export function getIndexesForFeatures(features: EnabledFeatures): string {
  let sql = CORE_INDEXES;

  if (features.indexTasks) sql += TASK_DEDUP + TASK_INDEXES;
  if (features.indexHeadings) sql += HEADING_DEDUP + HEADING_INDEXES;
  if (features.indexLinks) sql += LINK_INDEXES;
  if (features.indexUnresolvedLinks) sql += LINK_INDEXES;
  if (features.indexEmbeds) sql += EMBED_INDEXES;
  if (features.indexTags) sql += TAG_INDEXES;
  if (features.indexListItems) sql += LIST_ITEM_DEDUP + LIST_ITEM_INDEXES;
  if (features.indexBlocks) sql += BLOCK_INDEXES;
  if (features.indexTables) sql += TABLE_CELL_INDEXES;

  return sql;
}

const VIEWS_AND_TRIGGERS = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tables (
  path TEXT NOT NULL,
  table_index INTEGER NOT NULL DEFAULT 0,
  table_name TEXT,
  block_id TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  line_number INTEGER,
  PRIMARY KEY (path, table_index)
);
CREATE INDEX IF NOT EXISTS ix_tables_path ON tables(path);

INSERT OR IGNORE INTO tables(path, table_index, table_name, line_number)
SELECT
  path,
  table_index,
  MIN(table_name),
  MIN(CASE
    WHEN line_number IS NOT NULL THEN line_number - row_index - 2
    ELSE NULL
  END)
FROM table_cells
GROUP BY path, table_index;

UPDATE tables
SET line_number = (
  SELECT MIN(c.line_number - c.row_index - 2)
  FROM table_cells c
  WHERE c.path = tables.path
    AND c.table_index = tables.table_index
    AND c.line_number IS NOT NULL
)
WHERE line_number IS NULL;

-- Shadow table for table_rows user triggers (views don't support AFTER triggers)
-- User triggers targeting table_rows are rewritten to target this table
CREATE TABLE IF NOT EXISTS _table_row_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  table_index INTEGER NOT NULL DEFAULT 0,
  row_index INTEGER,
  row_json TEXT
);
-- Auto-cleanup: delete events after they're processed (triggers have fired)
DROP TRIGGER IF EXISTS trg_table_row_events_cleanup;
CREATE TRIGGER trg_table_row_events_cleanup
AFTER INSERT ON _table_row_events
BEGIN
  DELETE FROM _table_row_events WHERE id = NEW.id;
END;

CREATE VIEW IF NOT EXISTS table_rows AS
SELECT
  c.path,
  c.table_index,
  c.row_index,
  json_group_object(c.column_name, c.cell_value) AS row_json,
  t.line_number AS table_line_number
FROM table_cells c
LEFT JOIN tables t
  ON t.path = c.path AND t.table_index = c.table_index
GROUP BY c.path, c.table_index, c.row_index;

CREATE VIEW IF NOT EXISTS table_columns AS
SELECT c.path, c.table_index, json_group_array(DISTINCT c.column_name) AS columns
FROM table_cells c
GROUP BY c.path, c.table_index;

DROP TRIGGER IF EXISTS trg_table_rows_insert;
CREATE TRIGGER trg_table_rows_insert
INSTEAD OF INSERT ON table_rows
BEGIN
  -- Insert or update the tables entry, storing line_number if provided
  INSERT INTO tables(path, table_index, line_number)
  VALUES (NEW.path, COALESCE(NEW.table_index, 0), NEW.table_line_number)
  ON CONFLICT(path, table_index) DO UPDATE SET
    line_number = COALESCE(NEW.table_line_number, tables.line_number);

  -- Shift existing rows down when inserting at a specific row_index
  UPDATE table_cells
  SET row_index = row_index + 1
  WHERE path = NEW.path
    AND table_index = COALESCE(NEW.table_index, 0)
    AND row_index >= NEW.row_index
    AND NEW.row_index IS NOT NULL;

  INSERT INTO table_cells (path, table_index, row_index, column_name, cell_value, value_type)
  WITH next_row_idx AS (
    SELECT CASE
             WHEN NEW.row_index IS NOT NULL THEN NEW.row_index
             ELSE COALESCE(
               (SELECT MAX(tc.row_index) FROM table_cells tc
                WHERE tc.path = NEW.path AND tc.table_index = COALESCE(NEW.table_index, 0)), -1) + 1
           END AS row_idx
  )
  SELECT NEW.path,
         COALESCE(NEW.table_index, 0),
         next_row_idx.row_idx,
         key,
         value,
         'text'
  FROM json_each(NEW.row_json), next_row_idx;

  -- Sync to file if triggers are enabled (handler registered)
  -- Pass NULL for unused arg4 to match fixed arity
  SELECT _vq_sync('add_table_row', NEW.path, COALESCE(NEW.table_index, 0), NEW.row_json, NULL);

  -- Fire user triggers on _table_row_events (views don't support AFTER triggers)
  -- The cleanup trigger auto-deletes after user triggers fire
  INSERT INTO _table_row_events (path, table_index, row_index, row_json)
  SELECT NEW.path,
         COALESCE(NEW.table_index, 0),
         COALESCE(NEW.row_index,
           (SELECT MAX(tc.row_index) FROM table_cells tc
            WHERE tc.path = NEW.path AND tc.table_index = COALESCE(NEW.table_index, 0))),
         NEW.row_json;
END;

DROP TRIGGER IF EXISTS trg_table_rows_update;
CREATE TRIGGER trg_table_rows_update
INSTEAD OF UPDATE ON table_rows
BEGIN
  INSERT OR IGNORE INTO tables(path, table_index)
  VALUES (NEW.path, COALESCE(NEW.table_index, 0));

  DELETE FROM table_cells
  WHERE path = OLD.path AND table_index = COALESCE(OLD.table_index, 0) AND row_index = OLD.row_index;

  INSERT INTO table_cells (path, table_index, row_index, column_name, cell_value, value_type)
  SELECT NEW.path, COALESCE(NEW.table_index, 0), NEW.row_index, key, value, 'text'
  FROM json_each(NEW.row_json);

  -- Sync to file if triggers are enabled (handler registered)
  SELECT _vq_sync('update_table_row', NEW.path, COALESCE(NEW.table_index, 0), NEW.row_index, NEW.row_json);
END;

DROP TRIGGER IF EXISTS trg_table_rows_delete;
CREATE TRIGGER trg_table_rows_delete
INSTEAD OF DELETE ON table_rows
BEGIN
  DELETE FROM table_cells
  WHERE path = OLD.path AND table_index = COALESCE(OLD.table_index, 0) AND row_index = OLD.row_index;

  -- Sync to file if triggers are enabled (handler registered)
  -- Pass NULL for unused arg4 to match fixed arity
  SELECT _vq_sync('delete_table_row', OLD.path, COALESCE(OLD.table_index, 0), OLD.row_index, NULL);
END;

CREATE VIEW IF NOT EXISTS headings_view AS
SELECT path, level, line_number, heading_text, block_id, start_offset, end_offset, anchor_hash
FROM headings;

CREATE TRIGGER IF NOT EXISTS trg_headings_view_update
INSTEAD OF UPDATE ON headings_view
BEGIN
  UPDATE headings
  SET heading_text = COALESCE(NEW.heading_text, heading_text)
  WHERE path = OLD.path
    AND line_number = OLD.line_number
    AND level = OLD.level;
END;

CREATE VIEW IF NOT EXISTS list_items_view AS
SELECT
  item.id,
  item.path,
  item.list_index,
  item.item_index,
  item.parent_index,
  item.content,
  item.list_type,
  item.indent_level,
  item.line_number,
  item.block_id,
  item.start_offset,
  item.end_offset,
  item.anchor_hash,
  parent.content AS parent_content
FROM list_items item
LEFT JOIN list_items parent
  ON item.path = parent.path
  AND item.list_index = parent.list_index
  AND item.parent_index = parent.item_index;

DROP TRIGGER IF EXISTS trg_list_items_view_update;
CREATE TRIGGER trg_list_items_view_update
INSTEAD OF UPDATE ON list_items_view
BEGIN
  UPDATE list_items
  SET content = COALESCE(NEW.content, content)
  WHERE path = OLD.path
    AND list_index = OLD.list_index
    AND item_index = OLD.item_index;
END;

DROP TRIGGER IF EXISTS trg_list_items_view_delete;
CREATE TRIGGER trg_list_items_view_delete
INSTEAD OF DELETE ON list_items_view
BEGIN
  DELETE FROM list_items
  WHERE path = OLD.path
    AND list_index = OLD.list_index
    AND item_index IN (
      WITH RECURSIVE descendants(item_index) AS (
        SELECT OLD.item_index
        UNION ALL
        SELECT child.item_index
        FROM list_items child
        JOIN descendants parent
          ON child.parent_index = parent.item_index
        WHERE child.path = OLD.path
          AND child.list_index = OLD.list_index
      )
      SELECT item_index FROM descendants
    );
END;

CREATE VIEW IF NOT EXISTS note_properties AS
SELECT
  n.path,
  n.title,
  p.key,
  p.value,
  p.value_type
FROM notes n
LEFT JOIN properties p ON n.path = p.path AND p.array_index IS NULL;

-- tasks_view with computed columns for easier querying
CREATE VIEW IF NOT EXISTS tasks_view AS
SELECT
  t.*,
  CASE t.status
    WHEN 'IN_PROGRESS' THEN 1
    WHEN 'TODO' THEN 2
    WHEN 'DONE' THEN 3
    WHEN 'CANCELLED' THEN 4
    ELSE 5
  END AS status_order,
  CASE t.priority
    WHEN 'highest' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
    WHEN 'lowest' THEN 5
    ELSE 6
  END AS priority_order,
  CASE WHEN t.status IN ('DONE', 'CANCELLED') THEN 1 ELSE 0 END AS is_complete,
  CASE WHEN t.status NOT IN ('DONE', 'CANCELLED') AND t.due_date IS NOT NULL AND t.due_date < date('now') THEN 1 ELSE 0 END AS is_overdue,
  CASE WHEN t.due_date IS NOT NULL THEN CAST(julianday(t.due_date) - julianday('now') AS INTEGER) ELSE NULL END AS days_until_due
FROM tasks t;

CREATE TRIGGER IF NOT EXISTS trg_tasks_view_insert
INSTEAD OF INSERT ON tasks_view
BEGIN
  INSERT INTO tasks (
    path, task_text, status, priority, due_date, scheduled_date, start_date,
    created_date, done_date, cancelled_date, recurrence, on_completion,
    task_id, depends_on, tags, line_number, block_id, section_heading
  )
  VALUES (
    NEW.path,
    NEW.task_text,
    COALESCE(NEW.status, 'TODO'),
    NEW.priority,
    NEW.due_date,
    NEW.scheduled_date,
    NEW.start_date,
    COALESCE(NEW.created_date, date('now')),
    NEW.done_date,
    NEW.cancelled_date,
    NEW.recurrence,
    NEW.on_completion,
    NEW.task_id,
    NEW.depends_on,
    NEW.tags,
    COALESCE(NEW.line_number, (SELECT COALESCE(MAX(line_number), 0) + 1 FROM tasks WHERE path = NEW.path)),
    NEW.block_id,
    NEW.section_heading
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_view_update
INSTEAD OF UPDATE ON tasks_view
BEGIN
  UPDATE tasks SET
    task_text = COALESCE(NEW.task_text, task_text),
    status = COALESCE(NEW.status, status),
    priority = NEW.priority,
    due_date = NEW.due_date,
    scheduled_date = NEW.scheduled_date,
    start_date = NEW.start_date,
    created_date = NEW.created_date,
    done_date = NEW.done_date,
    cancelled_date = NEW.cancelled_date,
    recurrence = NEW.recurrence,
    on_completion = NEW.on_completion,
    task_id = NEW.task_id,
    depends_on = NEW.depends_on,
    tags = NEW.tags,
    section_heading = NEW.section_heading
  WHERE path = OLD.path AND id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_view_delete
INSTEAD OF DELETE ON tasks_view
BEGIN
  DELETE FROM tasks WHERE path = OLD.path AND id = OLD.id;
END;

-- INSERT trigger for headings_view
CREATE TRIGGER IF NOT EXISTS trg_headings_view_insert
INSTEAD OF INSERT ON headings_view
BEGIN
  INSERT INTO headings (path, level, heading_text, line_number, block_id)
  VALUES (
    NEW.path,
    COALESCE(NEW.level, 1),
    NEW.heading_text,
    NEW.line_number,
    NEW.block_id
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_headings_view_delete
INSTEAD OF DELETE ON headings_view
BEGIN
  DELETE FROM headings WHERE path = OLD.path AND line_number = OLD.line_number AND level = OLD.level;
END;

-- INSERT trigger for list_items_view
CREATE TRIGGER IF NOT EXISTS trg_list_items_view_insert
INSTEAD OF INSERT ON list_items_view
BEGIN
  INSERT INTO list_items (path, list_index, item_index, parent_index, content, list_type, indent_level, line_number, block_id)
  VALUES (
    NEW.path,
    COALESCE(NEW.list_index, 0),
    COALESCE(NEW.item_index, (SELECT COALESCE(MAX(item_index), -1) + 1 FROM list_items WHERE path = NEW.path)),
    NEW.parent_index,
    NEW.content,
    COALESCE(NEW.list_type, 'bullet'),
    COALESCE(NEW.indent_level, 0),
    COALESCE(NEW.line_number, (SELECT COALESCE(MAX(line_number), 0) + 1 FROM list_items WHERE path = NEW.path)),
    NEW.block_id
  );
END;

-- Tags are stored with # prefix (e.g., '#project' not 'project')
-- This matches how tags appear in markdown and Obsidian's metadata cache

-- Auto-derive notes metadata on INSERT
-- title: derived from path (filename without extension)
-- size: uses file.stat.size during indexing; falls back to LENGTH(content) for user INSERTs
-- created/modified: default to current timestamp if not provided
CREATE TRIGGER IF NOT EXISTS trg_notes_auto_derive
AFTER INSERT ON notes
WHEN NEW.title = '' OR NEW.title IS NULL
   OR NEW.size = 0 OR NEW.size IS NULL
   OR NEW.created = 0 OR NEW.created IS NULL
   OR NEW.modified = 0 OR NEW.modified IS NULL
BEGIN
  UPDATE notes
  SET
    title = CASE
      WHEN NEW.title = '' OR NEW.title IS NULL
      THEN path_basename(NEW.path)
      ELSE NEW.title
    END,
    size = CASE
      WHEN NEW.size = 0 OR NEW.size IS NULL
      THEN LENGTH(NEW.content)
      ELSE NEW.size
    END,
    created = CASE
      WHEN NEW.created = 0 OR NEW.created IS NULL
      THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ELSE NEW.created
    END,
    modified = CASE
      WHEN NEW.modified = 0 OR NEW.modified IS NULL
      THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ELSE NEW.modified
    END
  WHERE path = NEW.path;
END;

-- Auto-derive properties.value_type from value if not provided
CREATE TRIGGER IF NOT EXISTS trg_properties_auto_type
AFTER INSERT ON properties
WHEN NEW.value_type IS NULL OR NEW.value_type = ''
BEGIN
  UPDATE properties
  SET value_type = CASE
    WHEN NEW.value IN ('true', 'false') THEN 'boolean'
    WHEN NEW.value GLOB '[0-9]*' AND NEW.value NOT GLOB '*[^0-9.]*' THEN 'number'
    ELSE 'string'
  END
  WHERE path = NEW.path AND key = NEW.key AND COALESCE(array_index, -1) = COALESCE(NEW.array_index, -1);
END;

-- Auto-derive links.link_type and link_text on INSERT
CREATE TRIGGER IF NOT EXISTS trg_links_auto_derive
AFTER INSERT ON links
WHEN NEW.link_type IS NULL OR NEW.link_type = ''
   OR NEW.link_text IS NULL OR NEW.link_text = ''
BEGIN
  UPDATE links
  SET
    link_type = CASE
      WHEN NEW.link_type IS NULL OR NEW.link_type = '' THEN
        CASE
          WHEN NEW.link_target LIKE 'http://%' OR NEW.link_target LIKE 'https://%' THEN 'external'
          ELSE 'internal'
        END
      ELSE NEW.link_type
    END,
    link_text = CASE
      WHEN NEW.link_text IS NULL OR NEW.link_text = '' THEN NEW.link_target
      ELSE NEW.link_text
    END
  WHERE id = NEW.id;
END;

-- Auto-derive table_cells.value_type from cell_value if not provided
CREATE TRIGGER IF NOT EXISTS trg_table_cells_auto_type
AFTER INSERT ON table_cells
WHEN NEW.value_type IS NULL OR NEW.value_type = ''
BEGIN
  UPDATE table_cells
  SET value_type = CASE
    WHEN NEW.cell_value GLOB '[0-9]*' AND NEW.cell_value NOT GLOB '*[^0-9.]*' THEN 'number'
    ELSE 'text'
  END
  WHERE id = NEW.id;
END;
`;

export function getTablesOnlySQL(): string {
  const initialPropertiesView = `
CREATE VIEW IF NOT EXISTS notes_with_properties AS
SELECT path, title, content, created, modified, size
FROM notes;
`;
  return TABLE_DEFINITIONS + '\n' + VIEWS_AND_TRIGGERS + '\n' + initialPropertiesView;
}

interface MigratableDatabase {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  run(sql: string): unknown;
}

const LINKS_COLUMN_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['original', 'ALTER TABLE links ADD COLUMN original TEXT'],
  ['start_offset', 'ALTER TABLE links ADD COLUMN start_offset INTEGER'],
  ['end_offset', 'ALTER TABLE links ADD COLUMN end_offset INTEGER'],
  ['frontmatter_key', 'ALTER TABLE links ADD COLUMN frontmatter_key TEXT'],
];

export function migrateLinksColumns(db: MigratableDatabase): boolean {
  const existing = new Set(
    db.exec("PRAGMA table_info('links')")[0]?.values.map(row => row[1] as string) ?? []
  );
  if (existing.size === 0) return false;

  const missing = LINKS_COLUMN_MIGRATIONS.filter(([column]) => !existing.has(column));
  if (missing.length === 0) return false;

  for (const [, alterSql] of missing) {
    db.run(alterSql);
  }
  db.run('UPDATE notes SET modified = 0');
  return true;
}

interface PropertyColumn {
  columnName: string;
  keys: string[];
}

function getPropertyColumns(propertyKeys: string[]): PropertyColumn[] {
  const columns = new Map<string, PropertyColumn>();

  for (const key of propertyKeys) {
    const sanitized = key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() || 'property';
    const existing = columns.get(sanitized);

    if (existing) {
      existing.keys.push(key);
    }
    else {
      columns.set(sanitized, {
        columnName: sanitized,
        keys: [key]
      });
    }
  }

  return Array.from(columns.values());
}

export const PROPERTIES_MAT_TABLE = '_vq_props_mat';

function buildPivotSelect(propertyColumnsConfig: PropertyColumn[], pathFilter: string): string {
  const pivotColumns = propertyColumnsConfig.map(({columnName, keys}) => {
    const keyList = keys.map(key => `'${escapeSqlString(key)}'`).join(', ');
    const distinctValues = `DISTINCT CASE WHEN p.key IN (${keyList}) THEN p.value END`;
    return `  CASE
    WHEN COUNT(${distinctValues}) > 1 THEN GROUP_CONCAT(${distinctValues})
    ELSE MAX(CASE WHEN p.key IN (${keyList}) THEN p.value END)
  END AS ${quoteIdentifier(columnName)}`;
  }).join(',\n');

  return `SELECT
  p.path,
${pivotColumns}
FROM properties p
WHERE ${pathFilter}p.array_index IS NULL
GROUP BY p.path`;
}

function matColumnList(propertyColumnsConfig: PropertyColumn[]): string {
  return ['path', ...propertyColumnsConfig.map(({columnName}) => quoteIdentifier(columnName))].join(', ');
}

function matRowRefreshStatements(propertyColumnsConfig: PropertyColumn[], pathRef: string): string {
  return `  DELETE FROM ${PROPERTIES_MAT_TABLE} WHERE path = ${pathRef};
  INSERT INTO ${PROPERTIES_MAT_TABLE} (${matColumnList(propertyColumnsConfig)})
  ${buildPivotSelect(propertyColumnsConfig, `p.path = ${pathRef} AND `)};`;
}

export function generatePropertiesMatRefreshSql(propertyKeys: string[], existingMatColumns: string[]): { deleteSql: string; insertSql: string } | null {
  const existing = new Set(existingMatColumns);
  const config = getPropertyColumns(propertyKeys).filter(({columnName}) => existing.has(columnName));
  if (config.length === 0) {
    return null;
  }
  return {
    deleteSql: `DELETE FROM ${PROPERTIES_MAT_TABLE} WHERE path = ?`,
    insertSql: `INSERT INTO ${PROPERTIES_MAT_TABLE} (${matColumnList(config)})
${buildPivotSelect(config, 'p.path = ? AND ')}`,
  };
}

export function generateDynamicPropertiesView(propertyKeys: string[]): string {
  if (propertyKeys.length === 0) {
    return `
DROP VIEW IF EXISTS notes_with_properties;
DROP TABLE IF EXISTS ${PROPERTIES_MAT_TABLE};
CREATE VIEW notes_with_properties AS
SELECT path, title, content, created, modified, size
FROM notes;
`;
  }

  const propertyColumnsConfig = getPropertyColumns(propertyKeys);
  const columnDefs = propertyColumnsConfig.map(({columnName}) => `${quoteIdentifier(columnName)} TEXT`).join(', ');
  const flatColumns = propertyColumnsConfig.map(({columnName}) => `  m.${quoteIdentifier(columnName)}`).join(',\n');

  const updateStatements = propertyColumnsConfig.map(({columnName, keys}) => {
    const keyList = keys.map(key => `'${escapeSqlString(key)}'`).join(', ');
    const columnIdentifier = quoteIdentifier(columnName);
    return `  DELETE FROM properties WHERE path = OLD.path AND key IN (${keyList}) AND array_index IS NULL AND NEW.${columnIdentifier} IS NULL;
  UPDATE properties
  SET value = NEW.${columnIdentifier}, value_type = 'string'
  WHERE path = OLD.path AND key IN (${keyList}) AND array_index IS NULL AND NEW.${columnIdentifier} IS NOT NULL;
  INSERT INTO properties (path, key, value, value_type, array_index)
  SELECT OLD.path, '${escapeSqlString(columnName)}', NEW.${columnIdentifier}, 'string', NULL
  WHERE NEW.${columnIdentifier} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM properties WHERE path = OLD.path AND key IN (${keyList}) AND array_index IS NULL
    );`;
  }).join('\n');

  const insertStatements = propertyColumnsConfig.map(({columnName}) => {
    const columnIdentifier = quoteIdentifier(columnName);
    return `  INSERT INTO properties (path, key, value, value_type, array_index)
  SELECT NEW.path, '${escapeSqlString(columnName)}', NEW.${columnIdentifier}, 'string', NULL
  WHERE NEW.${columnIdentifier} IS NOT NULL;`;
  }).join('\n');

  return `
DROP VIEW IF EXISTS notes_with_properties;
DROP TABLE IF EXISTS ${PROPERTIES_MAT_TABLE};
CREATE TABLE ${PROPERTIES_MAT_TABLE} (path TEXT PRIMARY KEY, ${columnDefs});
INSERT INTO ${PROPERTIES_MAT_TABLE} (${matColumnList(propertyColumnsConfig)})
${buildPivotSelect(propertyColumnsConfig, '')};

DROP TRIGGER IF EXISTS trg_props_mat_note_delete;
CREATE TRIGGER trg_props_mat_note_delete
AFTER DELETE ON notes
FOR EACH ROW
BEGIN
  DELETE FROM ${PROPERTIES_MAT_TABLE} WHERE path = OLD.path;
END;

CREATE VIEW notes_with_properties AS
SELECT
  n.path,
  n.title,
  n.content,
  n.created,
  n.modified,
  n.size,
${flatColumns}
FROM notes n
LEFT JOIN ${PROPERTIES_MAT_TABLE} m ON n.path = m.path;

DROP TRIGGER IF EXISTS trg_notes_with_properties_update;
CREATE TRIGGER trg_notes_with_properties_update
INSTEAD OF UPDATE ON notes_with_properties
FOR EACH ROW
BEGIN
  UPDATE notes SET
    title = COALESCE(NEW.title, OLD.title),
    content = COALESCE(NEW.content, OLD.content)
  WHERE path = OLD.path;
${updateStatements}
${matRowRefreshStatements(propertyColumnsConfig, 'OLD.path')}
END;

DROP TRIGGER IF EXISTS trg_notes_with_properties_insert;
CREATE TRIGGER trg_notes_with_properties_insert
INSTEAD OF INSERT ON notes_with_properties
FOR EACH ROW
BEGIN
  INSERT INTO notes (path, title, content, created, modified, size)
  VALUES (NEW.path, COALESCE(NEW.title, ''), COALESCE(NEW.content, ''),
          COALESCE(NEW.created, strftime('%s', 'now') * 1000),
          COALESCE(NEW.modified, strftime('%s', 'now') * 1000),
          COALESCE(NEW.size, 0));
${insertStatements}
${matRowRefreshStatements(propertyColumnsConfig, 'NEW.path')}
END;

DROP TRIGGER IF EXISTS trg_notes_with_properties_delete;
CREATE TRIGGER trg_notes_with_properties_delete
INSTEAD OF DELETE ON notes_with_properties
FOR EACH ROW
BEGIN
  -- Delete the note (properties cascade via FK; mat row via trg_props_mat_note_delete)
  DELETE FROM notes WHERE path = OLD.path;
END;
`;
}

export function generateNotePropertiesView(propertyKeys: string[]): string {
  if (propertyKeys.length === 0) {
    return `
DROP VIEW IF EXISTS note_properties;
CREATE VIEW note_properties AS
SELECT DISTINCT path FROM properties;
`;
  }

  const propertyColumnsConfig = getPropertyColumns(propertyKeys);
  const flatColumns = propertyColumnsConfig.map(({columnName}) => `  ${quoteIdentifier(columnName)}`).join(',\n');

  const updateStatements = propertyColumnsConfig.map(({columnName, keys}) => {
    const keyList = keys.map(key => `'${escapeSqlString(key)}'`).join(', ');
    const columnIdentifier = quoteIdentifier(columnName);
    return `  DELETE FROM properties WHERE path = OLD.path AND key IN (${keyList}) AND array_index IS NULL AND NEW.${columnIdentifier} IS NULL;
  UPDATE properties
  SET value = NEW.${columnIdentifier}, value_type = 'string'
  WHERE path = OLD.path AND key IN (${keyList}) AND array_index IS NULL AND NEW.${columnIdentifier} IS NOT NULL;
  INSERT INTO properties (path, key, value, value_type, array_index)
  SELECT OLD.path, '${escapeSqlString(columnName)}', NEW.${columnIdentifier}, 'string', NULL
  WHERE NEW.${columnIdentifier} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM properties WHERE path = OLD.path AND key IN (${keyList}) AND array_index IS NULL
    );`;
  }).join('\n');

  const insertStatements = propertyColumnsConfig.map(({columnName}) => {
    const columnIdentifier = quoteIdentifier(columnName);
    return `  INSERT INTO properties (path, key, value, value_type, array_index)
  SELECT NEW.path, '${escapeSqlString(columnName)}', NEW.${columnIdentifier}, 'string', NULL
  WHERE NEW.${columnIdentifier} IS NOT NULL;`;
  }).join('\n');

  return `
DROP VIEW IF EXISTS note_properties;
CREATE VIEW note_properties AS
SELECT
  path,
${flatColumns}
FROM ${PROPERTIES_MAT_TABLE};

DROP TRIGGER IF EXISTS trg_note_properties_update;
CREATE TRIGGER trg_note_properties_update
INSTEAD OF UPDATE ON note_properties
FOR EACH ROW
BEGIN
${updateStatements}
${matRowRefreshStatements(propertyColumnsConfig, 'OLD.path')}
END;

DROP TRIGGER IF EXISTS trg_note_properties_insert;
CREATE TRIGGER trg_note_properties_insert
INSTEAD OF INSERT ON note_properties
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Note does not exist')
  WHERE NOT EXISTS (SELECT 1 FROM notes WHERE path = NEW.path);
${insertStatements}
${matRowRefreshStatements(propertyColumnsConfig, 'NEW.path')}
END;

DROP TRIGGER IF EXISTS trg_note_properties_delete;
CREATE TRIGGER trg_note_properties_delete
INSTEAD OF DELETE ON note_properties
FOR EACH ROW
BEGIN
  DELETE FROM properties WHERE path = OLD.path;
  DELETE FROM ${PROPERTIES_MAT_TABLE} WHERE path = OLD.path;
END;
`;
}

export interface TableStructure {
  viewName: string;
  columns: string[];
  tableNames?: string[];
}

export function generateDynamicTableViews(tableStructures: TableStructure[]): string {
  if (tableStructures.length === 0) {
    return '';
  }

  const viewDefinitions = tableStructures.map(structure => {
    const { viewName, columns, tableNames } = structure;

    const sanitizedColumns = columns.map((col, index) => {
      // Deliberately diverges from other sanitizers (no lowercasing): generated schema names must stay stable.
      const sanitized = col.replace(/[^a-zA-Z0-9_]/g, '_');
      return {
        original: col,
        sanitized: sanitized,
        alias: `tc${index}_${sanitized}`
      };
    });

    const primaryCol = sanitizedColumns[0];

    const columnSelections = sanitizedColumns.map(({ original, alias }) => {
      const quotedColumnName = quoteIdentifier(original);
      return `  ${alias}.cell_value AS ${quotedColumnName}`;
    }).join(',\n');

    const columnJoins = sanitizedColumns.slice(1).map(({ original, alias }) =>
      `LEFT JOIN table_cells ${alias} ON ${primaryCol.alias}.path = ${alias}.path AND ${primaryCol.alias}.table_index = ${alias}.table_index AND ${primaryCol.alias}.row_index = ${alias}.row_index AND ${alias}.column_name = '${escapeSqlString(original)}'`
    ).join('\n');

    let whereClause = `${primaryCol.alias}.column_name = '${escapeSqlString(primaryCol.original)}'`;

    if (tableNames && tableNames.length > 0) {
      const tableNameConditions = tableNames
        .map(name => `'${escapeSqlString(name)}'`)
        .join(', ');
      whereClause += ` AND ${primaryCol.alias}.table_name IN (${tableNameConditions})`;
    }

    const quotedViewName = quoteIdentifier(viewName);
    const joinsClause = columnJoins ? `\n${columnJoins}` : '';

    const insertTriggerName = quoteIdentifier(`${viewName}_insert_trigger`);
    const updateTriggerName = quoteIdentifier(`${viewName}_update_trigger`);
    const deleteTriggerName = quoteIdentifier(`${viewName}_delete_trigger`);
    const defaultTableName = tableNames && tableNames.length > 0
      ? `'${escapeSqlString(tableNames[0])}'`
      : 'NULL';
    const tableNameValue = `COALESCE(NEW.table_name, ${defaultTableName})`;
    const rowJsonArgs = sanitizedColumns.map(({ original }) => {
      const escapedColName = escapeSqlString(original);
      const quotedColName = quoteIdentifier(original);
      return `      '${escapedColName}', NEW.${quotedColName}`;
    }).join(',\n');
    const updateStatements = sanitizedColumns.map(({ original }) => {
      const escapedColName = escapeSqlString(original);
      const quotedColName = quoteIdentifier(original);
      return `    UPDATE table_cells SET cell_value = NEW.${quotedColName}
    WHERE path = OLD.path AND table_index = OLD.table_index AND row_index = OLD.row_index AND column_name = '${escapedColName}';`;
    }).join('\n');

    return `
DROP VIEW IF EXISTS ${quotedViewName};
CREATE VIEW ${quotedViewName} AS
SELECT
  ${primaryCol.alias}.path,
  ${primaryCol.alias}.table_index,
  ${primaryCol.alias}.row_index,
  ${primaryCol.alias}.table_name,
${columnSelections}
FROM table_cells ${primaryCol.alias}${joinsClause}
WHERE ${whereClause};

DROP TRIGGER IF EXISTS ${insertTriggerName};
CREATE TRIGGER ${insertTriggerName}
INSTEAD OF INSERT ON ${quotedViewName}
FOR EACH ROW
BEGIN
  INSERT INTO table_rows (path, table_index, row_index, row_json)
  VALUES (
    NEW.path,
    COALESCE(NEW.table_index, 0),
    NEW.row_index,
    json_object(
${rowJsonArgs}
    )
  );

  UPDATE table_cells
  SET table_name = ${tableNameValue}
  WHERE path = NEW.path
    AND table_index = COALESCE(NEW.table_index, 0)
    AND row_index = COALESCE(
      NEW.row_index,
      (SELECT MAX(tc.row_index)
       FROM table_cells tc
       WHERE tc.path = NEW.path AND tc.table_index = COALESCE(NEW.table_index, 0))
    );
END;

DROP TRIGGER IF EXISTS ${updateTriggerName};
CREATE TRIGGER ${updateTriggerName}
INSTEAD OF UPDATE ON ${quotedViewName}
FOR EACH ROW
BEGIN
${updateStatements}
END;

DROP TRIGGER IF EXISTS ${deleteTriggerName};
CREATE TRIGGER ${deleteTriggerName}
INSTEAD OF DELETE ON ${quotedViewName}
FOR EACH ROW
BEGIN
  DELETE FROM table_rows
  WHERE path = OLD.path
    AND table_index = COALESCE(OLD.table_index, 0)
    AND row_index = OLD.row_index;
END;`;
  }).join('\n');

  return viewDefinitions;
}
