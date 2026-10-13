// Indirection so UI components can talk to the engine without importing the bootstrap module.
import type { FromEngine, ToEngine } from './shared/protocol';

export type QueryResult = Extract<FromEngine, { type: 'query-result' }>;

export const bus = {
  send: (_m: ToEngine, _t?: Transferable[]): void => {},
  query: (): Promise<QueryResult> => Promise.reject(new Error('engine not started')),
};
