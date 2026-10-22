import { Redis } from "@upstash/redis";
import { required } from "./env";

/**
 * Minimal key-value surface the brain needs. Upstash Redis implements it in production;
 * tests use the in-memory fake in test/fakes. Values are always strings — callers own
 * (de)serialisation and validation.
 */
export interface KV {
  get(key: string): Promise<string | null>;
  /** Returns false only when `nx` is set and the key already existed. */
  set(key: string, value: string, opts?: { exSeconds?: number; nx?: boolean }): Promise<boolean>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  /** Increment and (on first increment) set expiry. Returns the new value. */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<number>;
}

export class UpstashKV implements KV {
  constructor(private readonly redis: Redis) {}

  static fromEnv(): UpstashKV {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
    return new UpstashKV(
      new Redis({
        url: url || required("UPSTASH_REDIS_REST_URL"),
        token: token || required("UPSTASH_REDIS_REST_TOKEN"),
        // We store raw strings and validate with zod ourselves.
        automaticDeserialization: false,
      }),
    );
  }

  async get(key: string) {
    return (await this.redis.get<string>(key)) ?? null;
  }
  async set(key: string, value: string, opts?: { exSeconds?: number; nx?: boolean }) {
    const res =
      opts?.exSeconds && opts.nx
        ? await this.redis.set(key, value, { ex: opts.exSeconds, nx: true })
        : opts?.exSeconds
          ? await this.redis.set(key, value, { ex: opts.exSeconds })
          : opts?.nx
            ? await this.redis.set(key, value, { nx: true })
            : await this.redis.set(key, value);
    return res !== null;
  }
  async getdel(key: string) {
    return (await this.redis.getdel<string>(key)) ?? null;
  }
  async del(key: string) {
    return this.redis.del(key);
  }
  async incrWithTtl(key: string, ttlSeconds: number) {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }
  async hget(key: string, field: string) {
    return (await this.redis.hget<string>(key, field)) ?? null;
  }
  async hset(key: string, field: string, value: string) {
    await this.redis.hset(key, { [field]: value });
  }
  async hgetall(key: string) {
    return ((await this.redis.hgetall<Record<string, string>>(key)) ?? {}) as Record<string, string>;
  }
  async hdel(key: string, field: string) {
    return this.redis.hdel(key, field);
  }
}
