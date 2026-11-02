import {
  CART_MAX_LINES,
  CART_MAX_QTY,
  CART_MIN_QTY,
  GROCERY_QUERY_MAX_CHARS,
  GROCERY_QUERY_MAX_WORDS,
  GROCERY_QUERY_MIN_CHARS,
  GROCERY_QUERY_RE,
  GROCERY_SEARCH_DEFAULT_MAX,
  GROCERY_SEARCH_MAX,
  KROGER_LOCATION_ID_RE,
  KROGER_PRODUCT_ID_RE,
} from "./rules";

export * from "./rules";

/**
 * Kroger / King Soopers grocery module (docs/CONNECTORS.md §2, §7; backlog "Connector: Kroger").
 * Slice 1: provider logic only. Registering `grocery.search` / `grocery.cart.add` on a `kroger`
 * connector, OAuth + ConnectionStore wiring and the Claude tools come in slice 2.
 *
 * - Scopes: `product.compact` (search) and `cart.basic:write` (add). Kroger's public API has no
 *   checkout, order, pickup-slot or payment endpoint, and this module calls none. Checkout is a
 *   `user_finishes` hand-off: `krogerCartUrl()` is the page the phone opens.
 * - The cart is add-only (`PUT /v1/cart/add` → 204). The brain can't read or undo an add, so the
 *   result is just `{ok, count}` and the assistant reads back what it asked to add.
 * - Caps: ≤ 50 lines per call, quantity 1–10 per line (after merging duplicate lines), and product
 *   ids must have come from `grocery.search` recently (`SearchedProducts`), so
 *   injected text can't put an arbitrary UPC into the owner's cart.
 * - Search queries go to a third party, so they are capped (≤ 80 chars, basic characters only).
 * - Every string from Kroger is cleaned (control/bidi characters stripped, length capped). Product
 *   names are still third-party text: callers treat them as data, never as instructions.
 */

export const KROGER_API_BASE = "https://api.kroger.com/v1";
export const KROGER_SCOPES = { search: "product.compact", cart: "cart.basic:write" } as const;
const TIMEOUT_MS = 15_000;
/** Kroger product search responses are a few KB per item; anything far bigger is refused. */
const MAX_RESPONSE_CHARS = 512 * 1024;
const NAME_MAX = 120;
const SIZE_MAX = 40;
/** How long a searched product id stays addable. */
export const SEARCHED_TTL_MS = 2 * 60 * 60_000;

export interface Product {
  /** 13-digit UPC (Kroger `productId`), the id `grocery.cart.add` takes. */
  id: string;
  name: string;
  size: string;
  /** Store price in USD (promo if lower). Only present when a `locationId` was given. */
  price?: number;
  /** From the store's stock level. Unknown → omitted. */
  inStock?: boolean;
}

export interface GrocerySearchQuery {
  query: string;
  locationId?: string;
  max?: number;
}

export interface CartLine {
  productId: string;
  quantity: number;
}

/** `grocery.cart.add` input, as in docs/CONNECTORS.md §2. */
export interface GroceryCartAddInput {
  items: CartLine[];
}

export interface CartAddResult {
  ok: true;
  /** Lines sent, after merging duplicates. */
  count: number;
}

export type Modality = "PICKUP" | "DELIVERY";

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export class GroceryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroceryInputError";
  }
}

/** 401/403: token expired, revoked or missing a scope. Slice 2 maps this to `needs_reauth`. */
export class KrogerAuthError extends Error {
  constructor(readonly status: number) {
    super("Kroger access isn't granted or has expired. The owner must reconnect Kroger.");
    this.name = "KrogerAuthError";
  }
}

export class KrogerRateLimitError extends Error {
  constructor() {
    super("Kroger's API rate limit was reached. Try again later.");
    this.name = "KrogerRateLimitError";
  }
}

export class KrogerUnavailableError extends Error {
  constructor(detail: string) {
    super(`Kroger isn't responding right now (${detail}).`);
    this.name = "KrogerUnavailableError";
  }
}

/**
 * The cart add failed in a way where Kroger may still have applied it (timeout, dropped
 * connection, 5xx). The add isn't idempotent and the brain can't read the cart, so callers must
 * NOT retry automatically: the owner checks the Kroger app first.
 */
export class KrogerCartUncertainError extends Error {
  constructor(detail: string) {
    super(`Kroger didn't confirm the cart add (${detail}). It may or may not have gone through: check the cart in the Kroger app before trying again.`);
    this.name = "KrogerCartUncertainError";
  }
}

// ---------------------------------------------------------------------------------------
// HTTP layer (injected so tests never touch the network)
// ---------------------------------------------------------------------------------------

/** The two Kroger endpoints we use. Raw JSON in, raw JSON out; all validation is above this. */
export interface KrogerApi {
  searchProducts(params: { term: string; locationId?: string; limit: number }): Promise<unknown>;
  addToCart(items: { upc: string; quantity: number; modality: Modality }[]): Promise<void>;
}

export interface KrogerHttpOptions {
  /** Owner's OAuth access token (`cart.basic:write`, and `product.compact` if no app token). */
  userToken: () => Promise<string>;
  /** Optional client-credentials token for product search, so search works without the owner's token. */
  appToken?: () => Promise<string>;
  fetch?: typeof fetch;
  base?: string;
  timeoutMs?: number;
}

export function krogerHttpApi(opts: KrogerHttpOptions): KrogerApi {
  const f = opts.fetch ?? fetch;
  const base = opts.base ?? KROGER_API_BASE;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  async function call(url: string, init: RequestInit & { headers: Record<string, string> }, token: string): Promise<Response> {
    let res: Response;
    try {
      res = await f(url, {
        ...init,
        headers: { ...init.headers, Accept: "application/json", Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new KrogerUnavailableError(netDetail(e));
    }
    if (res.status === 401 || res.status === 403) throw new KrogerAuthError(res.status);
    if (res.status === 429) throw new KrogerRateLimitError();
    return res;
  }

  async function readText(res: Response): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) throw new KrogerUnavailableError("response too large");
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new KrogerUnavailableError(netDetail(e));
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new KrogerUnavailableError("response too large");
    return text;
  }

  return {
    async searchProducts({ term, locationId, limit }) {
      const q = new URLSearchParams({ "filter.term": term, "filter.limit": String(limit) });
      if (locationId) q.set("filter.locationId", locationId);
      const token = await (opts.appToken ?? opts.userToken)();
      const res = await call(`${base}/products?${q.toString()}`, { method: "GET", headers: {} }, token);
      if (res.status === 400) throw new GroceryInputError("Kroger didn't accept that search. Try different words.");
      if (!res.ok) throw new KrogerUnavailableError(`HTTP ${res.status}`);
      const text = await readText(res);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new KrogerUnavailableError("unreadable response");
      }
    },
    async addToCart(items) {
      const token = await opts.userToken();
      let res: Response;
      try {
        res = await call(
          `${base}/cart/add`,
          { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) },
          token,
        );
      } catch (e) {
        // The request may have reached Kroger: never let this look like a clean, retryable failure.
        if (e instanceof KrogerUnavailableError) throw new KrogerCartUncertainError(e.message.replace(/^.*\((.*)\)\.$/, "$1"));
        throw e;
      }
      // Kroger answers 204; any 2xx is success. 4xx means it was refused (nothing added); 5xx may
      // or may not have applied, and a partial add can't be inspected or undone.
      if (res.status >= 500) throw new KrogerCartUncertainError(`HTTP ${res.status}`);
      if (!res.ok) throw new KrogerUnavailableError(`HTTP ${res.status}`);
    },
  };
}

function netDetail(e: unknown): string {
  const name = (e as { name?: string })?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timed out" : "network error";
}

// ---------------------------------------------------------------------------------------
// Provenance: product ids only from grocery.search
// ---------------------------------------------------------------------------------------

/** Ids returned by a recent search. Slice 2 backs this with KV; tests use the in-memory one. */
export interface SearchedProducts {
  remember(ids: string[]): Promise<void>;
  /** The ids NOT returned by a recent search (one round trip for the whole cart). */
  missing(ids: string[]): Promise<string[]>;
}

/** In-memory, per instance. Evicts lazily on lookup, so it's for tests and single requests only. */
export class MemorySearchedProducts implements SearchedProducts {
  private seen = new Map<string, number>();
  constructor(
    private ttlMs = SEARCHED_TTL_MS,
    private now: () => number = Date.now,
  ) {}
  async remember(ids: string[]): Promise<void> {
    const until = this.now() + this.ttlMs;
    for (const id of ids) this.seen.set(id, until);
  }
  async missing(ids: string[]): Promise<string[]> {
    const now = this.now();
    return ids.filter((id) => {
      const until = this.seen.get(id);
      if (until !== undefined && until <= now) this.seen.delete(id);
      return until === undefined || until <= now;
    });
  }
}

// ---------------------------------------------------------------------------------------
// Validation and cleaning
// ---------------------------------------------------------------------------------------

/** Strip control, format (incl. bidi), private-use and lone-surrogate characters; collapse whitespace; cap by code points. */
export function cleanText(s: unknown, maxLen: number): string {
  if (typeof s !== "string") return "";
  const t = s
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(t).slice(0, maxLen).join("").trim();
}

export function parseGroceryQuery(q: GrocerySearchQuery): { query: string; locationId?: string; max: number } {
  const query = cleanText(q.query, 1000);
  if (!query) throw new GroceryInputError("Say what to search for.");
  if (Array.from(query).length > GROCERY_QUERY_MAX_CHARS) throw new GroceryInputError(`Searches are at most ${GROCERY_QUERY_MAX_CHARS} characters.`);
  if (Array.from(query).length < GROCERY_QUERY_MIN_CHARS) throw new GroceryInputError(`Searches need at least ${GROCERY_QUERY_MIN_CHARS} characters.`);
  if (query.split(" ").length > GROCERY_QUERY_MAX_WORDS) throw new GroceryInputError(`Searches are at most ${GROCERY_QUERY_MAX_WORDS} words.`);
  if (!GROCERY_QUERY_RE.test(query)) throw new GroceryInputError("A grocery search can only contain letters, numbers, spaces and basic punctuation.");
  if (q.locationId !== undefined && !KROGER_LOCATION_ID_RE.test(q.locationId)) throw new GroceryInputError("That isn't a Kroger store id.");
  const max = q.max ?? GROCERY_SEARCH_DEFAULT_MAX;
  if (!Number.isInteger(max) || max < 1 || max > GROCERY_SEARCH_MAX) throw new GroceryInputError(`max must be an integer from 1 to ${GROCERY_SEARCH_MAX}.`);
  return { query, ...(q.locationId ? { locationId: q.locationId } : {}), max };
}

/** Validates shape and caps, and merges duplicate lines. Does not check provenance. */
export function parseCartLines(lines: CartLine[]): CartLine[] {
  if (!Array.isArray(lines) || lines.length === 0) throw new GroceryInputError("Nothing to add to the cart.");
  if (lines.length > CART_MAX_LINES) throw new GroceryInputError(`At most ${CART_MAX_LINES} lines per add.`);
  const merged = new Map<string, number>();
  for (const l of lines) {
    const id = typeof l?.productId === "string" ? l.productId.trim() : "";
    if (!KROGER_PRODUCT_ID_RE.test(id)) throw new GroceryInputError("Cart items must be product ids from a grocery search.");
    const qty = l.quantity;
    if (!Number.isInteger(qty) || qty < CART_MIN_QTY || qty > CART_MAX_QTY) {
      throw new GroceryInputError(`Quantity must be a whole number from ${CART_MIN_QTY} to ${CART_MAX_QTY}.`);
    }
    merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  if (merged.size > CART_MAX_LINES) throw new GroceryInputError(`At most ${CART_MAX_LINES} different items per add.`);
  for (const [, qty] of merged) {
    if (qty > CART_MAX_QTY) throw new GroceryInputError(`At most ${CART_MAX_QTY} of any one item.`);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) && x > 0 && x < 10_000 ? Math.round(x * 100) / 100 : undefined;
}

type RawItem = { size?: unknown; price?: { regular?: unknown; promo?: unknown }; inventory?: { stockLevel?: unknown } };
type RawProduct = { productId?: unknown; upc?: unknown; description?: unknown; brand?: unknown; items?: unknown };

/** One Kroger product → our Product, or undefined if it has no valid id or name. */
export function toProduct(raw: unknown): Product | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as RawProduct;
  const id = typeof p.productId === "string" ? p.productId.trim() : "";
  if (!KROGER_PRODUCT_ID_RE.test(id)) return undefined;
  const name = cleanText(p.description, NAME_MAX);
  if (!name) return undefined;
  const item = (Array.isArray(p.items) ? p.items[0] : undefined) as RawItem | undefined;
  const size = cleanText(item?.size, SIZE_MAX);
  const regular = num(item?.price?.regular);
  const promo = num(item?.price?.promo);
  const price = promo !== undefined && (regular === undefined || promo < regular) ? promo : regular;
  const level = item?.inventory?.stockLevel;
  const inStock = level === "HIGH" || level === "LOW" ? true : level === "TEMPORARILY_OUT_OF_STOCK" ? false : undefined;
  return { id, name, size, ...(price !== undefined ? { price } : {}), ...(inStock !== undefined ? { inStock } : {}) };
}

// ---------------------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------------------

export class KrogerGrocery {
  constructor(
    private api: KrogerApi,
    private searched: SearchedProducts,
    private modality: Modality = "PICKUP",
  ) {}

  /** `grocery.search`. Read-only on Kroger's side; remembers returned ids for `addToCart`. */
  async search(q: GrocerySearchQuery): Promise<Product[]> {
    const { query, locationId, max } = parseGroceryQuery(q);
    const body = await this.api.searchProducts({ term: query, limit: max, ...(locationId ? { locationId } : {}) });
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new KrogerUnavailableError("unexpected response");
    const seen = new Set<string>();
    const out: Product[] = [];
    for (const raw of data) {
      const p = toProduct(raw);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      if (out.length >= max) break;
    }
    await this.searched.remember(out.map((p) => p.id));
    return out;
  }

  /**
   * `grocery.cart.add`. Validates caps and provenance for every line before any call, so a bad
   * line adds nothing. No money moves; checkout is the owner's, on the phone.
   */
  async addToCart(input: GroceryCartAddInput): Promise<CartAddResult> {
    const parsed = parseCartLines(input?.items);
    if ((await this.searched.missing(parsed.map((l) => l.productId))).length > 0) {
      throw new GroceryInputError("Cart items must be product ids from a recent grocery search.");
    }
    await this.api.addToCart(parsed.map((l) => ({ upc: l.productId, quantity: l.quantity, modality: this.modality })));
    return { ok: true, count: parsed.length };
  }
}

/** Where the owner finishes checkout (a `user_finishes` hand-off). Hosts match OPEN_URL_HOSTS. */
export function krogerCartUrl(banner: "kroger" | "kingsoopers" = "kroger"): string {
  return banner === "kingsoopers" ? "https://www.kingsoopers.com/cart" : "https://www.kroger.com/cart";
}
