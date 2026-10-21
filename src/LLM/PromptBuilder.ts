import type { SchemaTable } from '../Database/SchemaDocumentation';
import { extractSqlReferencedTables, extractSqlMutationTarget } from '../utils/SQLParsingUtils';
import { sqliteIdentifierKey } from '../utils/SqlIdentifierUtils';
import type { LlmPrompt, LlmReadOutputKind, SqlGenerationAttempt } from './LlmTypes';
import type { SqlFunctionSignature } from '../Constants/SqlCatalog';
import { logger as rootLogger } from '../utils/logger';
import { renderCompactSchema, withPropertyKeys } from './SchemaSelector';
import { outputFenceLanguage } from './LlmTypes';
import { VAULTQUERY_FUNCTION_SIGNATURES } from '../Constants/SqlCatalog';

const logger = rootLogger.scope('LlmPrompt');

export const SQL_PROMPT_VERSION = 0;

const SELECTED_EXAMPLE_COUNT = 3;

export interface FewShotExample {
  question: string;
  sql: string;
  language?: string;
  config?: string[];
  requiredColumns?: Record<string, string[]>;
}

export interface PromptBuilderInput {
  question: string;
  schema: SchemaTable[];
  previousAttempts?: SqlGenerationAttempt[];
  propertyKeys?: string[];
  allowWriteOperations?: boolean;
  requestedOutput?: LlmReadOutputKind;
}

const FEW_SHOT_EXAMPLES: readonly FewShotExample[] = [
  {
    question: 'Show indexed file contents containing the word Obsidian.',
    requiredColumns: { other_files: ['path', 'content'] },
    sql: "SELECT path FROM other_files WHERE typeof(content) = 'text' AND regexp('\\bObsidian\\b', content) ORDER BY path"
  },
  {
    question: 'Sort notes by elevation gain ascending, keeping unknown values last.',
    requiredColumns: { notes_with_properties: ['elevation_gain'] },
    sql: [
      'SELECT path, title, elevation_gain',
      'FROM notes_with_properties',
      'ORDER BY parse_number(elevation_gain) ASC NULLS LAST, title'
    ].join('\n')
  },
  {
    question: 'Which notes have a status property set to active?',
    requiredColumns: { notes_with_properties: ['status'] },
    sql: [
      'SELECT path, title, status',
      'FROM notes_with_properties',
      "WHERE status = 'active'",
      'ORDER BY modified DESC'
    ].join('\n')
  },
  {
    question: 'Which notes have a rating property above 4?',
    requiredColumns: { notes_with_properties: ['rating'] },
    sql: [
      'SELECT path, title, rating',
      'FROM notes_with_properties',
      'WHERE parse_number(rating) > 4',
      'ORDER BY parse_number(rating) DESC NULLS LAST'
    ].join('\n')
  },
  {
    question: 'What tasks are overdue?',
    sql: [
      'SELECT path, task_text, due_date, days_until_due',
      'FROM tasks_view',
      'WHERE is_complete = 0 AND is_overdue = 1',
      'ORDER BY days_until_due'
    ].join('\n')
  },
  {
    question: 'Show notes tagged with #project',
    sql: [
      'SELECT n.path, n.title',
      'FROM notes n',
      "WHERE EXISTS (SELECT 1 FROM tags t WHERE t.path = n.path AND t.tag_name = '#project')",
      "   OR EXISTS (SELECT 1 FROM properties p WHERE p.path = n.path AND p.key = 'tags' AND p.value = 'project')",
      'ORDER BY n.title'
    ].join('\n')
  },
  {
    question: 'Which notes have a frontmatter tag restaurant?',
    sql: [
      'SELECT n.path, n.title',
      'FROM notes n',
      "WHERE EXISTS (SELECT 1 FROM properties p WHERE p.path = n.path AND p.key = 'tags' AND LOWER(p.value) = 'restaurant')",
      'ORDER BY n.title'
    ].join('\n')
  },
  {
    question: 'Which wikilinks in my vault are broken?',
    sql: [
      'SELECT path, link_text, line_number',
      'FROM links',
      'WHERE resolve_link(link_text, path) IS NULL',
      'ORDER BY path, line_number'
    ].join('\n')
  },
  {
    question: 'List the level 2 headings in Projects/Roadmap.md',
    sql: [
      'SELECT heading_text, line_number',
      'FROM headings',
      "WHERE path = 'Projects/Roadmap.md' AND level = 2",
      'ORDER BY line_number'
    ].join('\n')
  },
  {
    question: 'How many notes use each tag?',
    sql: [
      'SELECT tag_name, COUNT(DISTINCT path) AS note_count',
      'FROM tags',
      'GROUP BY tag_name',
      'ORDER BY note_count DESC',
      'LIMIT 20'
    ].join('\n')
  },
  {
    question: 'Show a bar chart of how many tasks have each status.',
    language: 'vaultquery-chart',
    sql: [
      'SELECT status AS label, COUNT(*) AS value',
      'FROM tasks_view',
      'GROUP BY status',
      'ORDER BY value DESC'
    ].join('\n'),
    config: ['type: bar', 'title: Tasks by status']
  },
  {
    question: 'Put my incomplete tasks with due dates on a calendar.',
    language: 'vaultquery-calendar',
    sql: [
      'SELECT due_date AS date, task_text AS title, path, status AS description',
      'FROM tasks_view',
      'WHERE is_complete = 0 AND due_date IS NOT NULL',
      'ORDER BY due_date'
    ].join('\n'),
    config: ['initialDate: first']
  },
  {
    question: 'Mark the task Buy milk in Inbox.md as done.',
    language: 'vaultquery-write',
    sql: [
      "UPDATE tasks SET status = 'DONE'",
      "WHERE path = 'Inbox.md' AND task_text = 'Buy milk'"
    ].join('\n')
  }
];

const ROLE_INSTRUCTION = [
  'You translate a natural-language request about an Obsidian vault into SQLite for the VaultQuery schema.',
  'You also choose the native VaultQuery output that best matches the request.'
].join(' ');

const SQL_RULES = [
  '- Use SQLite and the listed VaultQuery functions. Use only the actual tables, views and columns in the schema.',
  '- Prefer the simplest query that answers every part of the request. Prefer notes_with_properties for note metadata, computed views for tasks/headings/lists, and named table views for markdown tables.',
  '- notes_with_properties has one row per note, including notes without frontmatter. Its property columns are TEXT and missing properties are NULL. note_properties contains only notes that have properties and has no title/content columns.',
  '- Property view columns are sanitized names listed in the schema; use those exact names. Frontmatter is not columns on notes. Use properties for exact original key names, individual array elements, or keys that collide in the pivot view. Use EXISTS for membership filters to avoid duplicate notes.',
  '- Property views combine multiple distinct values into comma-separated text. Use properties.array_index for array membership, not substring matching or numeric parsing of a combined list.',
  '- For writes to frontmatter prefer properties with the exact stored key. Pivot view writes preserve original keys, reject ambiguous columns, and split comma-separated values into arrays in both the index and frontmatter.',
  '- Preserve original measurement text in displayed columns. Sort/compare numbers with parse_number(value); it handles "1,046 ft" and bare decimals and returns NULL for invalid values. Use NULLS LAST when sorting nullable measurements. CAST reads only a numeric prefix: commas truncate numbers and nonnumeric text becomes zero.',
  '- parse_number does not convert units. For mixed distance units use convert_distance(value, target_unit). Its optional third argument specifies the source unit of bare numbers; do not infer that unit from a few samples. Without a known unit, bare numbers cannot be reliably compared with unit-bearing distances.',
  '- Match the requested subject as well as location: hikes must exclude bike trails. Geography and categories may be represented by folders, titles, tags, or properties. Do not assume a Location property contains a place name; it may hold coordinates or be absent. Use available evidence to choose filters.',
  '- Paths are vault-relative with .md extensions. Match folder boundaries with = or LIKE, using parentheses around alternative folders. Avoid INNER JOINs on optional display properties.',
  '- tags.tag_name contains body tags with #; frontmatter tags are individual properties rows with key = \'tags\' and values without #. Unless a source is explicitly requested, consider both available sources.',
  '- Double-quote identifiers when needed, single-quote string literals. created/modified on notes are Unix milliseconds; divide by 1000 for SQLite unixepoch date functions.',
  '- Do not use {this.*} placeholders; the question has no current-note context. Add a LIMIT only when the request implies a short list; "all" means no arbitrary limit.',
  '- Examples demonstrate patterns, not facts about this vault. Preserve the user\'s constraints even when no rows match.'
].join('\n');

function renderOutputRules(allowWriteOperations: boolean, requestedOutput?: LlmReadOutputKind): string {
  const rules = [
    'Response format:',
    '- Return exactly one fenced block and no prose, commentary, or second fence.',
    '- For a normal interactive table, use a ```vaultquery fence.',
    '- For a Markdown table, use a ```vaultquery-markdown fence.',
    '- For a chart, use a ```vaultquery-chart fence. Return label and numeric value columns (or x and y for scatter), then add config: with type: bar, line, pie, doughnut, or scatter. Optional chart config: title, datasetLabel, xLabel, yLabel.',
    '- For a calendar, use a ```vaultquery-calendar fence. Return date and title columns; path and description are useful optional columns. Optional calendar config includes initialView (month, week, or day) and initialDate (first or last).',
    '- Put any config: section after the SQL inside the same fence. Do not add an output: option.',
    '- Choose a chart or calendar when the request asks for one. Otherwise use a table unless Markdown output is explicitly requested.'
  ];

  if (requestedOutput) {
    rules.push(`- The caller explicitly requires ${requestedOutput} output. Use the \`\`\`${outputFenceLanguage(requestedOutput)} fence and shape the result columns for it.`);
  }

  if (allowWriteOperations) {
    rules.push(
      '- If and only if the user explicitly asks to change vault data, use a ```vaultquery-write fence containing INSERT, UPDATE, or DELETE statements.',
      '- A generated write is shown as a before/after preview and is never applied automatically. Use a narrow WHERE clause and change only what the request identifies.',
      '- Read requests must still contain exactly one SELECT or WITH ... SELECT statement. Write requests may contain one or more INSERT, UPDATE, or DELETE statements.',
      '- Never emit DROP, CREATE, ALTER, ATTACH, PRAGMA, or other DDL/administrative statements.'
    );
  }
  else {
    rules.push(
      '- Emit exactly one SELECT or WITH ... SELECT statement.',
      '- Never emit INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, ATTACH, PRAGMA, or any other DDL/DML. Natural-language write access is disabled.'
    );
  }

  return rules.join('\n');
}

function formatSignature(signature: SqlFunctionSignature): string {
  return `- ${signature.name}(${signature.args.join(', ')}) - ${signature.detail}`;
}

function renderCatalog(signatures: readonly SqlFunctionSignature[]): string {
  const lines = signatures.map(formatSignature);

  return `VaultQuery custom SQL functions (available in addition to SQLite built-ins):\n${lines.join('\n')}`;
}

function renderFunctionCatalog(): string {
  return renderCatalog(VAULTQUERY_FUNCTION_SIGNATURES.filter((signature) => signature.scope === 'query'));
}

function renderExamples(examples: readonly FewShotExample[]): string {
  const blocks = examples.map((example) => {
    const body = example.config?.length
      ? `${example.sql}\n\nconfig:\n${example.config.join('\n')}`
      : example.sql;

    return `Question: ${example.question}\n\`\`\`${example.language ?? 'vaultquery'}\n${body}\n\`\`\``;
  });

  return `Examples:\n\n${blocks.join('\n\n')}`;
}

function selectExamples(input: PromptBuilderInput): FewShotExample[] {
  const tables = input.schema;
  const names = new Set(tables.map(table => sqliteIdentifierKey(table.name)));
  const words = new Set(input.question.toLowerCase().match(/[a-z]+/g) ?? []);
  const genericWords = new Set(['show', 'which', 'notes', 'have', 'with', 'what', 'list', 'many', 'each', 'their']);
  const output = input.requestedOutput;

  return FEW_SHOT_EXAMPLES.filter(example => {
    if (example.language === 'vaultquery-write' && !input.allowWriteOperations) return false;
    const relations = extractSqlReferencedTables(example.sql);
    const target = extractSqlMutationTarget(example.sql);
    if (target) relations.add(target);
    if ([...relations].some(name => !names.has(sqliteIdentifierKey(name)))) return false;

    return Object.entries(example.requiredColumns ?? {}).every(([name, columns]) =>
      columns.every(column => tables.find(table => table.name === name)?.columns.some(candidate => candidate.name === column)));
  }).map(example => ({
    example,
    score: (example.question.toLowerCase().match(/[a-z]+/g) ?? []).filter(word => word.length > 3 && !genericWords.has(word) && words.has(word)).length
      + (output && example.language === `vaultquery-${output}` ? 10 : 0)
  })).filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, SELECTED_EXAMPLE_COUNT)
    .map(entry => entry.example);
}

function renderSchemaSection(input: PromptBuilderInput): string {
  const tables = input.schema;
  if (!tables.length) return '(no schema information available)';
  const compact = renderCompactSchema(withPropertyKeys(tables, input.propertyKeys));
  logger.debug('Schema context', { tables: tables.length, characters: compact.length });

  return compact;
}

function renderPreviousAttempts(attempts: SqlGenerationAttempt[]): string {
  const blocks = attempts.map((attempt, index) => [
    `Attempt ${index + 1} failed:`,
    '```sql',
    attempt.sql,
    '```',
    `Error: ${attempt.error}`
  ].join('\n'));

  return [
    '',
    'Your previous answers to this question did not run.',
    '',
    blocks.join('\n\n'),
    '',
    'Fix the problem and return a corrected VaultQuery fenced block. Do not repeat a statement that already failed.'
  ].join('\n');
}

export function buildSqlPrompt(input: PromptBuilderInput): LlmPrompt {
  const schema = renderSchemaSection(input);

  const system = [
    ROLE_INSTRUCTION,
    '',
    'Rules:',
    SQL_RULES,
    renderOutputRules(input.allowWriteOperations === true, input.requestedOutput),
    '',
    renderExamples(selectExamples(input)),
    '',
    renderFunctionCatalog(),
    '',
    'Database schema:',
    '',
    schema
  ].join('\n');

  const attempts = input.previousAttempts ?? [];

  const user = attempts.length > 0
    ? `Question: ${input.question.trim()}\n${renderPreviousAttempts(attempts)}`
    : `Question: ${input.question.trim()}`;

  return { system, user };
}
