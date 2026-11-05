import type { DeviceKind } from "../models";
import type { Caller, CapabilityId, ImplementedCapability, In, ProviderOut } from "./capabilities";

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
  invoke<C extends ImplementedCapability>(cap: C, input: In<C>, ctx: ConnCtx): Promise<ProviderOut<C>>;
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

/**
 * The connection exists but can't be used for this call: the owner turned the capability off,
 * the provider didn't grant its scope, or the connection needs to be reconnected. The message
 * is written to be spoken to the owner.
 */
export class ConnectionUnusableError extends CapabilityDeniedError {
  constructor(
    capability: string,
    readonly connectorId: string,
    readonly reason: "disabled" | "needs_reauth",
    message: string,
  ) {
    super(capability, message);
    this.name = "ConnectionUnusableError";
  }
}
