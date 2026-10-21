import { createForcedOutputProcessor } from './BaseReadQueryCodeBlockProcessor';

export const ChartCodeBlockProcessor = createForcedOutputProcessor('chart');
export type ChartCodeBlockProcessor = InstanceType<typeof ChartCodeBlockProcessor>;
