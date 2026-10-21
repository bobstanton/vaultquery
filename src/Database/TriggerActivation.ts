import { escapeSqlString, quoteIdentifier } from '../utils/SqlIdentifierUtils';
import { rewriteTriggerWithPrefix, rewriteTriggerTarget } from '../utils/SQLParsingUtils';

export const USER_TRIGGER_PREFIX = '_vq_user_';

interface TriggerActivationDb {
  run(sql: string): unknown;
}

export function activateUserTrigger(db: TriggerActivationDb, triggerName: string, triggerSql: string, sourcePath?: string): void {
  const prefixedName = `${USER_TRIGGER_PREFIX}${triggerName}`;
  db.run(`DROP TRIGGER IF EXISTS ${quoteIdentifier(prefixedName)}`);

  const sqlWithPath = sourcePath
    ? triggerSql.replace(/\{this\.path\}/g, escapeSqlString(sourcePath))
    : triggerSql;

  const sqlWithTableRowsRewrite = rewriteTriggerTarget(sqlWithPath, 'table_rows', '_table_row_events');

  db.run(rewriteTriggerWithPrefix(sqlWithTableRowsRewrite, USER_TRIGGER_PREFIX));
}
