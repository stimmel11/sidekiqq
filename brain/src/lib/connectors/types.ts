import type { DeviceKind } from "../models";
import type { Caller, CapabilityId, ImplementedCapability, In, Out } from "./capabilities";

/** Call context. `caller` decides what is allowed (docs/CONNECTORS.md §4.4). */
export interface ConnCtx {
  caller: Caller;
  device?: DeviceKind;
}

/**
 * A provider implementation of one or more capabilities (docs/CONNECTORS.md §3).
 *
 * `invoke` must only be called by `invokeCapability` (enforced by test/connectors.test.ts).
 * No connector's `invoke` may reach a send executor: those live only in ./senders.ts.
 */
export interface Connector {
  id: string;
  displayName: string;
  /** First-party connectors (Google, Microsoft) skip argument logging in the audit log. */
  firstParty: boolean;
  capabilities: readonly CapabilityId[];
  /** Minimal OAuth scopes for the given capabilities. */
  scopesFor(caps: readonly CapabilityId[]): string[];
  invoke<C extends ImplementedCapability>(cap: C, input: In<C>, ctx: ConnCtx): Promise<Out<C>>;
}

export class CapabilityDeniedError extends Error {
  constructor(
    readonly capability: string,
    reason: string,
  ) {
    super(`${capability}: ${reason}`);
    this.name = "CapabilityDeniedError";
  }
}

export class CapabilityUnavailableError extends Error {
  constructor(readonly capability: string) {
    super(`No connected service provides ${capability} yet.`);
    this.name = "CapabilityUnavailableError";
  }
}
