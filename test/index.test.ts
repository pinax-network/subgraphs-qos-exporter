// Unit tests for the pure logic — run on every commit (bun test). No network / no server:
// importing src/index.ts is side-effect-free (server + poll loop are guarded by import.meta.main).
import { expect, test, describe } from "bun:test";
import { decodeBytesArg, render } from "../src/index.ts";

// ABI-encode a UTF-8 string as a single `bytes` arg behind a 4-byte selector, mimicking
// submitQoSPayload(bytes) calldata: selector + offset(0x20) + length + right-padded data.
function encodeCalldata(s: string): string {
  const data = Buffer.from(s, "utf-8").toString("hex");
  const len = (s.length).toString(16).padStart(64, "0");
  const off = (32).toString(16).padStart(64, "0");
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  return "0xaabbccdd" + off + len + padded;
}

describe("decodeBytesArg", () => {
  test("round-trips a QoS payload JSON", () => {
    const payload = '{"topic":"gateway_query_result_qos_5_minutes_prod_v3","hash":"QmAbc","timestamp":1783554300}';
    expect(decodeBytesArg(encodeCalldata(payload))).toBe(payload);
    // and it actually parses to the expected shape
    const p = JSON.parse(decodeBytesArg(encodeCalldata(payload)));
    expect(p.topic).toContain("query_result");
    expect(p.hash).toBe("QmAbc");
  });
  test("handles input without 0x prefix", () => {
    const cd = encodeCalldata("hello").slice(2);
    expect(decodeBytesArg(cd)).toBe("hello");
  });
});

const qr = (o: Partial<any>) => ({
  subgraph_deployment_ipfs_hash: "QmDep", chain: "mainnet", gateway_id: "0xGW",
  query_count: 100, total_query_fees: 1.5, avg_query_fee: 0.001, max_query_fee: 0.002,
  gateway_query_success_rate: 1, user_attributed_error_rate: 0,
  avg_gateway_latency_ms: 150, max_gateway_latency_ms: 900, stdev_gateway_latency_ms: 40,
  most_recent_query_ts: 1783554299949, ...o,
});
const ia = (wallet: string, o: Partial<any>) => ({
  subgraph_deployment_ipfs_hash: "QmDep", chain: "mainnet", indexer_wallet: wallet, indexer_url: "https://x/",
  query_count: 0, avg_query_fee: 0.001, max_query_fee: 0.002, total_query_fees: 0.5,
  avg_indexer_latency_ms: 200, max_indexer_latency_ms: 900, stdev_indexer_latency_ms: 30,
  proportion_indexer_200_responses: 1, avg_indexer_blocks_behind: 0.3, max_indexer_blocks_behind: 1, ...o,
});
const OUR = "0x3717cef8020bddee7a18f4efb2bfa88fefdcb1bc"; // matches default OUR_INDEXER

describe("render", () => {
  const out = render(
    [qr({ query_count: 100 })],
    [
      ia("0xaaa", { query_count: 500, avg_indexer_latency_ms: 100 }),  // winner
      ia("0xbbb", { query_count: 300, avg_indexer_latency_ms: 400 }),
      ia(OUR,     { query_count: 100, avg_indexer_latency_ms: 250 }),  // us: 3rd by volume, 2nd by latency
    ],
  );
  test("emits current-window gateway gauges incl. the newly-added fields", () => {
    expect(out).toContain('graph_qos_query_count{deployment="QmDep",name="",chain="mainnet",gateway="0xGW"} 100');
    expect(out).toContain("graph_qos_stdev_gateway_latency_ms{");
    expect(out).toContain("graph_qos_max_query_fee_grt{");
    expect(out).toContain("graph_qos_most_recent_query_seconds{");
  });
  test("network aggregate counts indexers + query-weighted latency", () => {
    expect(out).toMatch(/graph_qos_network_indexers\{[^}]*\} 3/);
    // weighted avg latency = (500*100 + 300*400 + 100*250)/900 = 216.67
    expect(out).toMatch(/graph_qos_avg_indexer_latency_ms\{[^}]*\} 216\.6/);
  });
  test("computes OUR rank: 3rd by queries, 2nd by latency", () => {
    expect(out).toMatch(/graph_qos_our_query_rank\{[^}]*\} 3/);
    expect(out).toMatch(/graph_qos_our_latency_rank\{[^}]*\} 2/);
    // our share = 100/900 = 0.111…
    expect(out).toMatch(/graph_qos_our_query_share\{[^}]*\} 0\.111/);
  });
  test("emits per-indexer detail incl. fee fields", () => {
    expect(out).toContain("graph_qos_indexer_query_count{");
    expect(out).toContain("graph_qos_indexer_query_fees_grt{");
    expect(out).toContain("graph_qos_indexer_stdev_latency_ms{");
  });
});

describe("committed name files", () => {
  test("deployments.json is a non-empty object of hash→name", async () => {
    const d = await Bun.file("deployments.json").json();
    expect(Object.keys(d).length).toBeGreaterThan(1000);
    for (const k of Object.keys(d).slice(0, 50)) expect(k).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
  });
  test("indexers.json is a non-empty object of address→name", async () => {
    const d = await Bun.file("indexers.json").json();
    expect(Object.keys(d).length).toBeGreaterThan(50);
    for (const k of Object.keys(d).slice(0, 50)) expect(k).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
