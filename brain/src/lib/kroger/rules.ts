/**
 * Limits and allowed characters for `grocery.search` and `grocery.cart.add` (docs/CONNECTORS.md
 * §2 and §4.4). Dependency-free so the capability schemas can validate inputs before any
 * connector runs.
 *
 * The search query is sent to a third party, so it is a leak channel: short, and only letters,
 * digits, spaces and basic punctuation.
 */
/** Counted in code points by the provider module (a zod `.max` counts UTF-16 units; they differ only for astral characters). */
export const GROCERY_QUERY_MAX_CHARS = 80;
/** Kroger rejects `filter.term` shorter than 3 characters or longer than 8 words (HTTP 400). */
export const GROCERY_QUERY_MIN_CHARS = 3;
export const GROCERY_QUERY_MAX_WORDS = 8;
/**
 * Letters, digits, spaces and . , ' ’ & - / ( ), plus % only right after a digit and not before two
 * hex digits ("2% milk"), so percent-encoded text ("dana%40acme.com", "a2%40b") can't pass. Must start with a letter or digit.
 * No run of 5+ digits (see GROCERY_QUERY_DIGIT_RUN_RE).
 */
export const GROCERY_QUERY_RE = /^(?!.*\p{N}(?:[ .,/()-]*\p{N}){4})[\p{L}\p{N}](?:[\p{L}\p{M}\p{N} .,'’&/()-]|(?<=\p{N})%(?![0-9A-Fa-f]{2}))*$/u;
/**
 * 5+ digits in a row: a UPC (searching one would make it "from search" and so addable) or a code,
 * account or phone number copied from an email, also when split by spaces or punctuation
 * ("303-555-1234", "4829 13"). Short numbers ("12 ct", "2%", "1/2 gallon") are fine.
 */
export const GROCERY_QUERY_DIGIT_RUN_RE = /\p{N}(?:[ .,/()-]*\p{N}){4}/u;
export const GROCERY_SEARCH_MAX = 25;
export const GROCERY_SEARCH_DEFAULT_MAX = 10;

/** Kroger store ids are 8 alphanumeric characters (from GET /v1/locations). */
export const KROGER_LOCATION_ID_RE = /^[0-9A-Za-z]{8}$/;
/** Kroger product ids are 13-digit UPCs. Cart lines are keyed by the same value. */
export const KROGER_PRODUCT_ID_RE = /^\d{13}$/;

export const CART_MAX_LINES = 50;
export const CART_MIN_QTY = 1;
export const CART_MAX_QTY = 10;
