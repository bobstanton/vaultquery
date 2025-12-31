export const TABLE_DEFINITIONS = `
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
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _user_functions (
  function_name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  FOREIGN KEY (path) REFERENCES notes(path) ON DELETE CASCADE
);
`;

const CORE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_properties_key ON properties(key);
`;

const TASK_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tasks_path ON tasks(path);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_natural ON tasks(path, COALESCE(block_id, anchor_hash)) WHERE COALESCE(block_id, anchor_hash) IS NOT NULL;
`;

const HEADING_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_headings_path ON headings(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_headings_natural ON headings(path, COALESCE(block_id, anchor_hash)) WHERE COALESCE(block_id, anchor_hash) IS NOT NULL;
`;

const LINK_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_links_path ON links(path);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(link_target);
`;

const TAG_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tags_path ON tags(path);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(tag_name);
`;

const LIST_ITEM_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_list_items_path ON list_items(path);
CREATE UNIQUE INDEX IF NOT EXISTS ux_list_items_natural ON list_items(path, COALESCE(block_id, anchor_hash)) WHERE COALESCE(block_id, anchor_hash) IS NOT NULL;
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
  indexTags: boolean;
  indexListItems: boolean;
}

export function getIndexesForFeatures(features: EnabledFeatures): string {
  let sql = CORE_INDEXES;

  if (features.indexTasks) sql += TASK_INDEXES;
  if (features.indexHeadings) sql += HEADING_INDEXES;
  if (features.indexLinks) sql += LINK_INDEXES;
  if (features.indexTags) sql += TAG_INDEXES;
  if (features.indexListItems) sql += LIST_ITEM_INDEXES;
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

INSERT OR IGNORE INTO tables(path, table_index, table_name)
SELECT path, table_index, MIN(table_name) FROM table_cells GROUP BY path, table_index;

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

CREATE TRIGGER IF NOT EXISTS trg_table_rows_insert
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
END;

CREATE TRIGGER IF NOT EXISTS trg_table_rows_update
INSTEAD OF UPDATE ON table_rows
BEGIN
  INSERT OR IGNORE INTO tables(path, table_index)
  VALUES (NEW.path, COALESCE(NEW.table_index, 0));

  DELETE FROM table_cells
  WHERE path = OLD.path AND table_index = COALESCE(OLD.table_index, 0) AND row_index = OLD.row_index;

  INSERT INTO table_cells (path, table_index, row_index, column_name, cell_value, value_type)
  SELECT NEW.path, COALESCE(NEW.table_index, 0), NEW.row_index, key, value, 'text'
  FROM json_each(NEW.row_json);
END;

CREATE TRIGGER IF NOT EXISTS trg_table_rows_delete
INSTEAD OF DELETE ON table_rows
BEGIN
  DELETE FROM table_cells
  WHERE path = OLD.path AND table_index = COALESCE(OLD.table_index, 0) AND row_index = OLD.row_index;
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
  AND item.parent_index = parent.item_index;

CREATE TRIGGER IF NOT EXISTS trg_list_items_view_update
INSTEAD OF UPDATE ON list_items_view
BEGIN
  UPDATE list_items
  SET content = COALESCE(NEW.content, content)
  WHERE path = OLD.path
    AND item_index = OLD.item_index;
END;

CREATE TRIGGER IF NOT EXISTS trg_list_items_view_delete
INSTEAD OF DELETE ON list_items_view
BEGIN
  DELETE FROM list_items
  WHERE path = OLD.path
    AND item_index = OLD.item_index;
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
    COALESCE(NEW.line_number, (SELECT COALESCE(MAX(line_number), 0) + 1 FROM headings WHERE path = NEW.path)),
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

-- Normalize tag_name on INSERT: strip leading # if present
-- This allows users to INSERT with '#project' or 'project' and get consistent results
CREATE TRIGGER IF NOT EXISTS trg_tags_normalize_insert
AFTER INSERT ON tags
WHEN NEW.tag_name LIKE '#%'
BEGIN
  UPDATE tags
  SET tag_name = SUBSTR(NEW.tag_name, 2)
  WHERE id = NEW.id;
END;

-- Normalize tag_name on UPDATE: strip leading # if present
CREATE TRIGGER IF NOT EXISTS trg_tags_normalize_update
AFTER UPDATE OF tag_name ON tags
WHEN NEW.tag_name LIKE '#%'
BEGIN
  UPDATE tags
  SET tag_name = SUBSTR(NEW.tag_name, 2)
  WHERE id = NEW.id;
END;

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

export function generateDynamicPropertiesView(propertyKeys: string[]): string {
  if (propertyKeys.length === 0) {
    return `
DROP VIEW IF EXISTS notes_with_properties;
CREATE VIEW notes_with_properties AS
SELECT path, title, content, created, modified, size
FROM notes;
`;
  }

  const sanitizedKeys = propertyKeys.map((key, index) => {
    const sanitized = key.replace(/[^a-zA-Z0-9_]/g, '_');
    const uniqueAlias = `p${index}_${sanitized}`;
    return {
      original: key,
      sanitized: sanitized,
      alias: uniqueAlias
    };
  });

  const propertyColumns = sanitizedKeys.map(({sanitized, alias}) =>
    `  ${alias}.value AS ${sanitized}`
  ).join(',\n');

  const propertyJoins = sanitizedKeys.map(({original, alias}) =>
    `LEFT JOIN properties ${alias} ON n.path = ${alias}.path AND ${alias}.key = '${original.replace(/'/g, "''")}' AND ${alias}.array_index IS NULL`
  ).join('\n');

  const updateStatements = sanitizedKeys.map(({original, sanitized}) => {
    const escapedKey = original.replace(/'/g, "''");
    return `  -- Update ${sanitized}
  DELETE FROM properties WHERE path = OLD.path AND key = '${escapedKey}' AND array_index IS NULL AND NEW.${sanitized} IS NULL;
  INSERT OR REPLACE INTO properties (path, key, value, value_type, array_index)
  SELECT OLD.path, '${escapedKey}', NEW.${sanitized}, 'string', NULL
  WHERE NEW.${sanitized} IS NOT NULL;`;
  }).join('\n');

  const insertStatements = sanitizedKeys.map(({original, sanitized}) => {
    const escapedKey = original.replace(/'/g, "''");
    return `  INSERT INTO properties (path, key, value, value_type, array_index)
  SELECT NEW.path, '${escapedKey}', NEW.${sanitized}, 'string', NULL
  WHERE NEW.${sanitized} IS NOT NULL;`;
  }).join('\n');

  return `
DROP VIEW IF EXISTS notes_with_properties;
CREATE VIEW notes_with_properties AS
SELECT
  n.path,
  n.title,
  n.content,
  n.created,
  n.modified,
  n.size,
${propertyColumns}
FROM notes n
${propertyJoins};

DROP TRIGGER IF EXISTS trg_notes_with_properties_update;
CREATE TRIGGER trg_notes_with_properties_update
INSTEAD OF UPDATE ON notes_with_properties
FOR EACH ROW
BEGIN
  -- Update note metadata if changed
  UPDATE notes SET
    title = COALESCE(NEW.title, OLD.title),
    content = COALESCE(NEW.content, OLD.content)
  WHERE path = OLD.path;
  -- Update each property column
${updateStatements}
END;

DROP TRIGGER IF EXISTS trg_notes_with_properties_insert;
CREATE TRIGGER trg_notes_with_properties_insert
INSTEAD OF INSERT ON notes_with_properties
FOR EACH ROW
BEGIN
  -- Insert the note first
  INSERT INTO notes (path, title, content, created, modified, size)
  VALUES (NEW.path, COALESCE(NEW.title, ''), COALESCE(NEW.content, ''),
          COALESCE(NEW.created, strftime('%s', 'now') * 1000),
          COALESCE(NEW.modified, strftime('%s', 'now') * 1000),
          COALESCE(NEW.size, 0));
  -- Insert each property
${insertStatements}
END;

DROP TRIGGER IF EXISTS trg_notes_with_properties_delete;
CREATE TRIGGER trg_notes_with_properties_delete
INSTEAD OF DELETE ON notes_with_properties
FOR EACH ROW
BEGIN
  -- Delete the note (properties cascade via FK)
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

  const sanitizedKeys = propertyKeys.map((key, index) => {
    const sanitized = key.replace(/[^a-zA-Z0-9_]/g, '_');
    const uniqueAlias = `p${index}_${sanitized}`;
    return {
      original: key,
      sanitized: sanitized,
      alias: uniqueAlias
    };
  });

  const propertyColumns = sanitizedKeys.map(({sanitized, alias}) =>
    `  ${alias}.value AS ${sanitized}`
  ).join(',\n');

  const propertyJoins = sanitizedKeys.map(({original, alias}) =>
    `LEFT JOIN properties ${alias} ON base.path = ${alias}.path AND ${alias}.key = '${original.replace(/'/g, "''")}' AND ${alias}.array_index IS NULL`
  ).join('\n');

  const updateStatements = sanitizedKeys.map(({original, sanitized}) => {
    const escapedKey = original.replace(/'/g, "''");
    return `  -- Update ${sanitized}
  DELETE FROM properties WHERE path = OLD.path AND key = '${escapedKey}' AND array_index IS NULL AND NEW.${sanitized} IS NULL;
  INSERT OR REPLACE INTO properties (path, key, value, value_type, array_index)
  SELECT OLD.path, '${escapedKey}', NEW.${sanitized}, 'string', NULL
  WHERE NEW.${sanitized} IS NOT NULL;`;
  }).join('\n');

  const insertStatements = sanitizedKeys.map(({original, sanitized}) => {
    const escapedKey = original.replace(/'/g, "''");
    return `  INSERT INTO properties (path, key, value, value_type, array_index)
  SELECT NEW.path, '${escapedKey}', NEW.${sanitized}, 'string', NULL
  WHERE NEW.${sanitized} IS NOT NULL;`;
  }).join('\n');

  return `
DROP VIEW IF EXISTS note_properties;
CREATE VIEW note_properties AS
SELECT
  base.path,
${propertyColumns}
FROM (SELECT DISTINCT path FROM properties) base
${propertyJoins};

DROP TRIGGER IF EXISTS trg_note_properties_update;
CREATE TRIGGER trg_note_properties_update
INSTEAD OF UPDATE ON note_properties
FOR EACH ROW
BEGIN
${updateStatements}
END;

DROP TRIGGER IF EXISTS trg_note_properties_insert;
CREATE TRIGGER trg_note_properties_insert
INSTEAD OF INSERT ON note_properties
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Note does not exist')
  WHERE NOT EXISTS (SELECT 1 FROM notes WHERE path = NEW.path);
${insertStatements}
END;

DROP TRIGGER IF EXISTS trg_note_properties_delete;
CREATE TRIGGER trg_note_properties_delete
INSTEAD OF DELETE ON note_properties
FOR EACH ROW
BEGIN
  DELETE FROM properties WHERE path = OLD.path;
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
      const sanitized = col.replace(/[^a-zA-Z0-9_]/g, '_');
      return {
        original: col,
        sanitized: sanitized,
        alias: `tc${index}_${sanitized}`
      };
    });

    const primaryCol = sanitizedColumns[0];

    const columnSelections = sanitizedColumns.map(({ original, alias }) => {
      const quotedColumnName = `"${original.replace(/"/g, '""')}"`;
      return `  ${alias}.cell_value AS ${quotedColumnName}`;
    }).join(',\n');

    const columnJoins = sanitizedColumns.slice(1).map(({ original, alias }) =>
      `LEFT JOIN table_cells ${alias} ON ${primaryCol.alias}.path = ${alias}.path AND ${primaryCol.alias}.table_index = ${alias}.table_index AND ${primaryCol.alias}.row_index = ${alias}.row_index AND ${alias}.column_name = '${original.replace(/'/g, "''")}'`
    ).join('\n');

    let whereClause = `${primaryCol.alias}.column_name = '${primaryCol.original.replace(/'/g, "''")}'`;

    if (tableNames && tableNames.length > 0) {
      const tableNameConditions = tableNames
        .map(name => `'${name.replace(/'/g, "''")}'`)
        .join(', ');
      whereClause += ` AND ${primaryCol.alias}.table_name IN (${tableNameConditions})`;
    }

    const quotedViewName = `"${viewName.replace(/"/g, '""')}"`;
    const joinsClause = columnJoins ? `\n${columnJoins}` : '';

    const triggerName = `"${viewName.replace(/"/g, '""')}_update_trigger"`;
    const updateStatements = sanitizedColumns.map(({ original }) => {
      const escapedColName = original.replace(/'/g, "''");
      const quotedColName = `"${original.replace(/"/g, '""')}"`;
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

DROP TRIGGER IF EXISTS ${triggerName};
CREATE TRIGGER ${triggerName}
INSTEAD OF UPDATE ON ${quotedViewName}
FOR EACH ROW
BEGIN
${updateStatements}
END;`;
  }).join('\n');

  return viewDefinitions;
}
