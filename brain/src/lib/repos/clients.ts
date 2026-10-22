import type { KV } from "../kv";
import { ClientProfileSchema, type ClientProfile } from "../models";
import { slugify } from "../util";
import { Collection } from "./collection";

export type ClientProfileInput = Partial<Omit<ClientProfile, "id" | "createdAt" | "updatedAt">> & { name: string };

export class ClientsRepo {
  private readonly col: Collection<ClientProfile>;
  constructor(kv: KV, prefix: string, private readonly clock: () => Date = () => new Date()) {
    this.col = new Collection(kv, prefix, "clients", ClientProfileSchema);
  }

  static idFor(name: string): string {
    const slug = slugify(name);
    if (!slug) throw new Error("Client name must contain letters or digits");
    return slug;
  }

  /** Merge provided fields into the profile; omitted fields are preserved. */
  async upsert(input: ClientProfileInput): Promise<{ client: ClientProfile; created: boolean }> {
    const id = ClientsRepo.idFor(input.name);
    const now = this.clock().toISOString();
    const cur = await this.col.get(id);
    const defined = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    const next: ClientProfile = cur
      ? { ...cur, ...defined, id, name: cur.name, updatedAt: now }
      : ({ ...defined, id, name: input.name, createdAt: now, updatedAt: now } as ClientProfile);
    return { client: await this.col.put(next), created: !cur };
  }

  async get(name: string): Promise<ClientProfile | null> {
    return this.col.get(ClientsRepo.idFor(name));
  }

  list() {
    return this.col.all();
  }
}
