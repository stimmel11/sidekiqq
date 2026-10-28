/**
 * Limits and allowed characters for `contacts.lookup` queries. Kept free of `googleapis` so the
 * capability schema (lib/connectors/capabilities.ts) can validate names before any connector runs.
 */
export const CONTACTS_MAX = 10;
export const CONTACTS_DEFAULT_MAX = 5;
export const CONTACT_NAME_MAX_CHARS = 80;
/** Names are letters, spaces and . ' ’ - only. */
export const CONTACT_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
