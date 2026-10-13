// Build-time constants.
declare const __CHANNEL__: string;

/** 'prod' or 'dev': namespaces storage and caches so dev builds can't touch real projects. */
export const CHANNEL: string = __CHANNEL__;

/** Memory budget for the whole app. 4 GB-class prior from the P0 device run (DECISIONS.md):
 *  0.6 x 2,432 MB, the lowest last-good allocation measured on the iPad Air 4. */
export const BUDGET = { mb: 1459, source: '4 GB-class prior, measured on iPad Air 4 (P0)' };
