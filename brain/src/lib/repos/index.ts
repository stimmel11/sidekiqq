import type { KV } from "../kv";
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
}

export interface RepoOptions {
  prefix: string;
  conversationTtlSeconds: number;
  conversationMaxMessages: number;
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
  };
}

export { ClientsRepo, CommitmentsRepo, ConversationsRepo, DecisionsRepo, DevicesRepo, DraftsRepo, FollowUpsRepo, PairingRepo, StateRepo, TimelineRepo };
