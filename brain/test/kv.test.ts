import { describe, expect, it } from "vitest";
import { pairsToRecord, UpstashKV } from "../src/lib/kv";

describe("pairsToRecord", () => {
  it("converts the raw flat HGETALL reply into a record", () => {
    expect(pairsToRecord(["a", '{"id":"a"}', "b", '{"id":"b"}'])).toEqual({
      a: '{"id":"a"}',
      b: '{"id":"b"}',
    });
  });
  it("handles null / empty", () => {
    expect(pairsToRecord(null)).toEqual({});
    expect(pairsToRecord([])).toEqual({});
  });
  it("accepts an already-deserialized object", () => {
    expect(pairsToRecord({ a: "x", b: { n: 1 } })).toEqual({ a: "x", b: '{"n":1}' });
  });
});

describe("UpstashKV.hgetall", () => {
  it("returns a field→value record when the client yields a flat array", async () => {
    const fakeRedis = { hgetall: async () => ["c1", '{"id":"c1"}', "c2", '{"id":"c2"}'] };
    const kv = new UpstashKV(fakeRedis as never);
    expect(await kv.hgetall("sk:commitments")).toEqual({ c1: '{"id":"c1"}', c2: '{"id":"c2"}' });
  });
});
