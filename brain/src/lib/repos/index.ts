import type { KV } from "../kv";
import { AlertsRepo } from "./alerts";
import { ClientsRepo } from "./clients";
import { CommitmentsRepo } from "./commitments";
import { ConversationsRepo } from "./conversations";
import { DecisionsRepo } from "./decisions";
import { DevicesRepo } from "./devices";
import { DraftsRepo } from "./drafts";
import { FollowUpsRepo } from "./followups";
import { PairingRepo } from "./pairing";
import { StateRepo } from "./state";
import { TimelineRepo } from "./timeline";

export interface Repos {
  commitments: CommitmentsRepo;
  followups: FollowUpsRepo;
  clients: ClientsRepo;
  timeline: TimelineRepo;
  decisions: DecisionsRepo;
  drafts: DraftsRepo;
  devices: DevicesRepo;
  conversations: ConversationsRepo;
  pairing: PairingRepo;
  state: StateRepo;
  alerts: AlertsRepo;
}

export interface RepoOptions {
  prefix: string;
  conversationTtlSeconds: number;
  conversationMaxMessages: number;
  /** Days of proactive alerts kept for polling devices. Default 7. */
  alertRetentionDays?: number;
  clock?: () => Date;
}

export function createRepos(kv: KV, o: RepoOptions): Repos {
  const clock = o.clock ?? (() => new Date());
  return {
    commitments: new CommitmentsRepo(kv, o.prefix, clock),
    followups: new FollowUpsRepo(kv, o.prefix, clock),
    clients: new ClientsRepo(kv, o.prefix, clock),
    timeline: new TimelineRepo(kv, o.prefix, clock),
    decisions: new DecisionsRepo(kv, o.prefix, clock),
    drafts: new DraftsRepo(kv, o.prefix, clock),
    devices: new DevicesRepo(kv, o.prefix, clock),
    conversations: new ConversationsRepo(kv, o.prefix, o.conversationTtlSeconds, o.conversationMaxMessages),
    pairing: new PairingRepo(kv, o.prefix),
    state: new StateRepo(kv, o.prefix),
    alerts: new AlertsRepo(kv, o.prefix, clock, o.alertRetentionDays ?? 7),
  };
}

export { AlertsRepo, ClientsRepo, CommitmentsRepo, ConversationsRepo, DecisionsRepo, DevicesRepo, DraftsRepo, FollowUpsRepo, PairingRepo, StateRepo, TimelineRepo };
