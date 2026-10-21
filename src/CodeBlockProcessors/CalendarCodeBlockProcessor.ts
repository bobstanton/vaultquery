import { createForcedOutputProcessor } from './BaseReadQueryCodeBlockProcessor';

export const CalendarCodeBlockProcessor = createForcedOutputProcessor('calendar');
export type CalendarCodeBlockProcessor = InstanceType<typeof CalendarCodeBlockProcessor>;
