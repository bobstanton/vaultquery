import { createForcedOutputProcessor } from './BaseReadQueryCodeBlockProcessor';

export const ChartCodeBlockProcessor = createForcedOutputProcessor('vaultquery-chart', 'chart');
export type ChartCodeBlockProcessor = InstanceType<typeof ChartCodeBlockProcessor>;
