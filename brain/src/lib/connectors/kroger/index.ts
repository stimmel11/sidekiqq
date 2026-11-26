import type { CapabilityId, ImplementedCapability, In, ProviderOut } from "../capabilities";
import type { Connector } from "../types";
import { KROGER_SCOPES, KrogerAuthError, krogerHttpApi, type KrogerApi, type KrogerGrocery } from "../../kroger/grocery";
import { KROGER_CONNECTOR_ID, type KrogerAuth } from "./auth";

/**
 * The built-in Kroger / King Soopers connector (docs/CONNECTORS.md §2, §10 step 6; backlog
 * "Connector: Kroger" slice 2b). Two capabilities: `grocery.search` (read-only, app token) and
 * `grocery.cart.add` (auto, capped, add-only, owner token). No checkout, order, pickup-slot or
 * payment call exists anywhere: Kroger's public API has none, and checkout is a `user_finishes`
 * hand-off to the phone (later slice).
 *
 * Not first-party, so `invokeCapability` logs its arguments (query / product ids + quantities).
 */

export const KROGER_CAPABILITIES = ["grocery.search", "grocery.cart.add"] as const satisfies readonly CapabilityId[];

export class KrogerConnector implements Connector {
  readonly id = KROGER_CONNECTOR_ID;
  readonly displayName = "Kroger";
  readonly firstParty = false;
  readonly capabilities: readonly CapabilityId[] = KROGER_CAPABILITIES;

  constructor(private readonly grocery: () => Promise<KrogerGrocery>) {}

  scopesFor(caps: readonly CapabilityId[]): string[] {
    const out: string[] = [];
    if (caps.includes("grocery.search")) out.push(KROGER_SCOPES.search);
    if (caps.includes("grocery.cart.add")) out.push(KROGER_SCOPES.cart);
    return out;
  }

  async invoke<C extends ImplementedCapability>(cap: C, input: In<C>): Promise<ProviderOut<C>> {
    const g = await this.grocery();
    if (cap === "grocery.search") return (await g.search(input as In<"grocery.search">)) as ProviderOut<C>;
    if (cap === "grocery.cart.add") return (await g.addToCart(input as In<"grocery.cart.add">)) as ProviderOut<C>;
    throw new Error(`kroger connector does not implement ${String(cap)}`);
  }
}

/**
 * `KrogerApi` over `KrogerAuth`, with ONE retry after a 401 and no other retry.
 *
 * Retry decision (explicit, backlog slice 2b):
 *  - Search (app token): on 401 drop the cached app token and try once more. Search is read-only,
 *    so a repeat is harmless. A second 401 is a server config problem (`KrogerAuthError` with
 *    `appCredentials`), never `needs_reauth`.
 *  - Cart add (owner token): on 401 drop the cached owner token, refresh once, and try once more.
 *    This is the ONLY case a cart add is repeated: a 401 means Kroger rejected the token before
 *    applying anything. A dead refresh token surfaces from `userToken()` as `ReauthRequiredError`,
 *    which `invokeCapability` turns into `needs_reauth`. 403 (scope), 429, other 4xx, 5xx,
 *    timeouts and network errors are never retried: an uncertain add may already be in the cart
 *    (`KrogerCartUncertainError`), and a duplicate is worse than asking the owner to check.
 */
export function krogerAuthedApi(auth: Pick<KrogerAuth, "userToken" | "appToken" | "invalidateUser" | "invalidateApp">, fetchFn: typeof fetch = fetch): KrogerApi {
  // Only a 401 from the Kroger API itself (after a token was minted) is retried; a refusal from the
  // token endpoint (`appToken()` can throw KrogerAuthError too) is passed straight through.
  const attempt = async <T>(run: (api: KrogerApi) => Promise<T>, invalidate: () => void): Promise<T> => {
    let minted = false;
    const tagged = (mint: () => Promise<string>) => async () => {
      const t = await mint();
      minted = true;
      return t;
    };
    const api = krogerHttpApi({ userToken: tagged(() => auth.userToken()), appToken: tagged(() => auth.appToken()), fetch: fetchFn });
    try {
      return await run(api);
    } catch (e) {
      if (!(minted && e instanceof KrogerAuthError && e.status === 401)) throw e;
      invalidate();
      const fresh = krogerHttpApi({ userToken: () => auth.userToken(), appToken: () => auth.appToken(), fetch: fetchFn });
      return await run(fresh);
    }
  };
  return {
    searchProducts: (params) => attempt((api) => api.searchProducts(params), () => auth.invalidateApp()),
    addToCart: (items) => attempt((api) => api.addToCart(items), () => auth.invalidateUser()),
  };
}
