import * as calendarHelp from '../generated-help/vaultquery-calendar-help.generated';
import { App } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import { BaseHelpCodeBlockProcessor } from './BaseHelpCodeBlockProcessor';

export class CalendarHelpCodeBlockProcessor extends BaseHelpCodeBlockProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin, 'vaultquery-calendar-help', calendarHelp);
  }
}
