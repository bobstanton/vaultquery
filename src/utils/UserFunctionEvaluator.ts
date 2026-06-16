type UserSqlFunction = (...args: unknown[]) => unknown;
type DynamicFunctionFactory = (body: string) => () => unknown;

const createDynamicFunction = Function as unknown as DynamicFunctionFactory;

export function createUserSqlFunction(source: string): UserSqlFunction {
  const evaluated = createDynamicFunction(`"use strict";\nreturn (${source});`)();
  if (typeof evaluated !== 'function') {
    throw new Error(`Invalid function definition: expected a function, got ${typeof evaluated}`);
  }
  return evaluated as UserSqlFunction;
}
