import { createForcedOutputProcessor } from './BaseReadQueryCodeBlockProcessor';

export const CalendarCodeBlockProcessor = createForcedOutputProcessor('vaultquery-calendar', 'calendar');
export type CalendarCodeBlockProcessor = InstanceType<typeof CalendarCodeBlockProcessor>;
