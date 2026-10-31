import type { CapabilityId, ImplementedCapability, In, Out } from "../capabilities";
import type { Connector } from "../types";
import { ZOOM_CONNECTOR_ID, ZOOM_MEETING_SCOPE } from "./auth";
import type { ZoomRooms } from "./meetings";

/**
 * The built-in Zoom connector (docs/CONNECTORS.md §2, §10 step 5). One capability so far:
 * `video.create_room` (auto, unannounced room for the owner). It has no send path and no way to
 * invite anyone; the Zoom link inside a calendar invite comes later with `calendar.invite.prepare`
 * and is created by its executor at approve time.
 *
 * Not first-party, so `invokeCapability` logs its arguments (topic, start, duration) in the audit log.
 */

export const ZOOM_CAPABILITIES = ["video.create_room"] as const satisfies readonly CapabilityId[];

export class ZoomConnector implements Connector {
  readonly id = ZOOM_CONNECTOR_ID;
  readonly displayName = "Zoom";
  readonly firstParty = false;
  readonly capabilities: readonly CapabilityId[] = ZOOM_CAPABILITIES;

  /** The factory throws ZoomNotConnectedError when Zoom isn't connected. */
  constructor(private readonly rooms: () => Promise<ZoomRooms>) {}

  scopesFor(caps: readonly CapabilityId[]): string[] {
    return caps.includes("video.create_room") ? [ZOOM_MEETING_SCOPE] : [];
  }

  async invoke<C extends ImplementedCapability>(cap: C, input: In<C>): Promise<Out<C>> {
    if (cap !== "video.create_room") throw new Error(`zoom connector does not implement ${String(cap)}`);
    const out: Out<"video.create_room"> = await (await this.rooms()).create(input as In<"video.create_room">);
    return out as Out<C>;
  }
}
