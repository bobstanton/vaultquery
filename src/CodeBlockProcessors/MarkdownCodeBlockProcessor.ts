import { createForcedOutputProcessor } from './BaseReadQueryCodeBlockProcessor';

export const MarkdownCodeBlockProcessor = createForcedOutputProcessor('markdown');
export type MarkdownCodeBlockProcessor = InstanceType<typeof MarkdownCodeBlockProcessor>;
