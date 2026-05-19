import * as chartHelp from '../generated-help/vaultquery-chart-help.generated';
import { App } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseHelpCodeBlockProcessor } from './BaseHelpCodeBlockProcessor';

export class ChartHelpCodeBlockProcessor extends BaseHelpCodeBlockProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin, 'vaultquery-chart-help', chartHelp);
  }
}
