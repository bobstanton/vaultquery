/**
 * Shared utilities for parsing SQL and extracting user-defined objects
 * (views, functions, triggers) from markdown content.
 */

/**
 * Parse the name of a SQL object (VIEW or TRIGGER) from a CREATE statement.
 * Handles optional IF NOT EXISTS and various quote styles including:
 * - Unquoted identifiers: CREATE VIEW myview
 * - Double-quoted: CREATE VIEW "my view"
 * - Single-quoted: CREATE VIEW 'my view'
 * - Backtick-quoted: CREATE VIEW `my view`
 * - Square-bracketed: CREATE VIEW [my view]
 */
export function parseSQLObjectName(sql: string, type: 'VIEW' | 'TRIGGER'): string | null {
  const suffix = type === 'VIEW' ? '\\s+AS' : '';
  const pattern = new RegExp(
    `CREATE\\s+${type}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"([^"]+)"|'([^']+)'|\`([^\`]+)\`|\\[([^\\]]+)\\]|(\\w+))${suffix}`,
    'i'
  );
  const match = sql.match(pattern);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? null;
}

/**
 * Rewrite a CREATE TRIGGER statement to use a prefixed name.
 * Handles all quote styles and preserves the rest of the SQL.
 */
export function rewriteTriggerWithPrefix(triggerSql: string, prefix: string): string {
  return triggerSql.replace(
    /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|'[^']+'|`[^`]+`|\[[^\]]+\]|\w+)/i,
    (match) => {
      // Extract just the CREATE TRIGGER part and replace with prefixed version
      const createPart = match.match(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?/i)?.[0] ?? 'CREATE TRIGGER ';
      const name = parseSQLObjectName(triggerSql, 'TRIGGER');
      return `${createPart.replace(/IF\s+NOT\s+EXISTS\s+/i, '')}"${prefix}${name}"`;
    }
  );
}

/**
 * Parse a function name from JavaScript source code.
 * Expects format: function functionName(...)
 */
export function parseFunctionName(source: string): string | null {
  const match = source.match(/^\s*function\s+(\w+)\s*\(/);
  return match?.[1] ?? null;
}

/**
 * Result of extracting all VaultQuery code blocks in a single pass.
 */
interface ExtractedCodeBlocks {
  views: string[];
  functions: string[];
  triggers: string[];
}

/**
 * Extract all VaultQuery code blocks (views, functions, triggers) in a single pass.
 * Only matches backtick fences (```), not tilde fences (~~~).
 * Tilde fences are for display-only documentation examples.
 */
export function extractAllCodeBlocks(content: string): ExtractedCodeBlocks {
  const result: ExtractedCodeBlocks = {
    views: [],
    functions: [],
    triggers: []
  };

  const regex = /```vaultquery-(view|function|trigger)\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const blockType = match[1];
    const blockContent = match[2].trim();

    switch (blockType) {
      case 'view':
        result.views.push(blockContent);
        break;
      case 'function':
        result.functions.push(blockContent);
        break;
      case 'trigger':
        result.triggers.push(blockContent);
        break;
    }
  }

  return result;
}

/**
 * Validate that SQL starts with the expected CREATE statement.
 */
export function validateSQLObjectStart(sql: string, type: 'VIEW' | 'TRIGGER'): boolean {
  const pattern = new RegExp(`^\\s*CREATE\\s+${type}`, 'i');
  return pattern.test(sql);
}

/**
 * Validate basic JavaScript function syntax.
 * Checks for function keyword and matching braces.
 */
export function validateFunctionSyntax(source: string): { valid: boolean; error?: string } {
  const trimmed = source.trim();

  if (!trimmed.startsWith('function')) {
    return { valid: false, error: 'Function must start with "function" keyword' };
  }

  let braceCount = 0;
  for (const char of trimmed) {
    if (char === '{') braceCount++;
    if (char === '}') braceCount--;
  }

  if (braceCount !== 0) {
    return { valid: false, error: 'Mismatched braces in function definition' };
  }

  return { valid: true };
}
