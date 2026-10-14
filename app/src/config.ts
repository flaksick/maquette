// Build-time constants.
import { CLASSES, DEFAULT_CLASS } from './budget';

declare const __CHANNEL__: string;

/** 'prod' or 'dev': namespaces storage and caches so dev builds can't touch real projects. */
export const CHANNEL: string = __CHANNEL__;

/** The class prior the app starts from (budget.ts holds the number: 0.6 x 2,432 MB, the lowest
 *  last-good allocation on the iPad Air 4, DECISIONS.md). What's in force is the LEARNED budget:
 *  `budgetMB()` / `fits()` from budget.ts (PLT-8). */
export const BUDGET = { mb: CLASSES[DEFAULT_CLASS].priorMB, source: CLASSES[DEFAULT_CLASS].source };
