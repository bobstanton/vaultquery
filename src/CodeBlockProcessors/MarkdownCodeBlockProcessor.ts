import { createForcedOutputProcessor } from './BaseReadQueryCodeBlockProcessor';

export const MarkdownCodeBlockProcessor = createForcedOutputProcessor('vaultquery-markdown', 'markdown');
export type MarkdownCodeBlockProcessor = InstanceType<typeof MarkdownCodeBlockProcessor>;
