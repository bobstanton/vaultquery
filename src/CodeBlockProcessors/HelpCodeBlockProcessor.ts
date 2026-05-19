import * as vaultqueryHelp from '../generated-help/vaultquery-help.generated';
import { App } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseHelpCodeBlockProcessor } from './BaseHelpCodeBlockProcessor';
import { VAULTQUERY_DATABASE_PREPARING_MESSAGE } from '../utils/IndexingUtils';

export class HelpCodeBlockProcessor extends BaseHelpCodeBlockProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin, 'vaultquery-help', vaultqueryHelp, VAULTQUERY_DATABASE_PREPARING_MESSAGE);
  }
}
