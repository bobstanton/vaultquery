import * as apiGuide from '../generated-help/api-guide.generated';
import { App } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseHelpCodeBlockProcessor } from './BaseHelpCodeBlockProcessor';
import { VAULTQUERY_DATABASE_PREPARING_MESSAGE } from '../utils/IndexingUtils';

export class ApiGuideCodeBlockProcessor extends BaseHelpCodeBlockProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin, 'vaultquery-help vaultquery-api-guide', apiGuide, VAULTQUERY_DATABASE_PREPARING_MESSAGE);
  }
}
