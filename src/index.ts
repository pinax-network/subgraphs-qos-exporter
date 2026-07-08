// subgraphs-qos-exporter — serve The Graph's Gateway QoS feed as Prometheus metrics.
//
// The public QoS subgraph is stale (its hardcoded submitter allowlist predates E&N's rotated
// key), but the data itself is posted fresh to a "DataEdge" contract every ~5 min: each tx is
// submitQoSPayload(bytes) with {topic, hash (IPFS CID), timestamp}; the CID holds a JSON array of
// per-deployment QoS records. We poll the contract, decode the newest matching payload, fetch it
// from IPFS, and expose it. Zero npm deps — Bun's global fetch + manual ABI decode.

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error("RPC_URL is required (full JSON-RPC endpoint)"); process.exit(1); }

const IPFS_URL   = (process.env.IPFS_URL ?? "https://ipfs.thegraph.com").replace(/\/+$/, "");
// Whitelist of DataEdge contract(s) to watch — narrows which txs we decode. Comma-separated.
const CONTRACTS  = (process.env.QOS_CONTRACTS ?? "0x5b4293b4c0f36cb5d4448950830bc777759b6c4f")
  .split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
const TOPIC      = process.env.QOS_TOPIC ?? "gateway_query_result_qos_5_minutes_prod_v3";
const SCAN_BLOCKS = Number(process.env.SCAN_BLOCKS ?? 180);      // ~15 min at 5s blocks
const REFRESH_MS  = Number(process.env.REFRESH_SECONDS ?? 300) * 1000;
const PORT        = Number(process.env.PORT ?? 9090);

// Optional {ipfs_hash: name} enrichment. NOT a filter — every deployment is exported; listed
// hashes just also get a human `name` label. From DEPLOYMENTS_FILE (default ./deployments.json).
let NAMES: Record<string, string> = {};
const DEPLOYMENTS_FILE = process.env.DEPLOYMENTS_FILE ?? "deployments.json";
try { NAMES = await Bun.file(DEPLOYMENTS_FILE).json(); } catch { NAMES = {}; }

type Rec = {
  subgraph_deployment_ipfs_hash: string; chain: string; gateway_id: string;
  query_count: number; avg_query_fee: number;
  gateway_query_success_rate: number; user_attributed_error_rate: number;
  avg_gateway_latency_ms: number; max_gateway_latency_ms: number;
};

async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(RPC_URL!, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { error?: unknown; result?: any };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ABI-decode a single `bytes` argument out of submitQoSPayload(bytes) calldata.
function decodeBytesArg(input: string): string {
  let h = input.startsWith("0x") ? input.slice(2) : input;
  h = h.slice(8);                                   // strip the 4-byte selector
  const off = parseInt(h.slice(0, 64), 16) * 2;     // offset to the bytes blob
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  return Buffer.from(h.slice(off + 64, off + 64 + len), "hex").toString("utf-8");
}

// Scan recent blocks (newest first) for the latest tx to a watched contract whose payload topic
// matches. DataEdge emits no events, so a block scan is required; the early-exit keeps it cheap.
async function latestPayload(): Promise<{ hash: string; ts: number } | null> {
  const head = parseInt(await rpc("eth_blockNumber", []), 16);
  for (let b = head; b > head - SCAN_BLOCKS; b--) {
    const blk = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), true]);
    if (!blk?.transactions) continue;
    for (const tx of blk.transactions) {
      if (CONTRACTS.includes((tx.to ?? "").toLowerCase()) && (tx.input ?? "").length > 10) {
        try {
          const p = JSON.parse(decodeBytesArg(tx.input));
          if (p.topic === TOPIC) return { hash: p.hash, ts: Number(p.timestamp ?? 0) };
        } catch { /* not this payload shape */ }
      }
    }
  }
  return null;
}

async function fetchIpfs(cid: string): Promise<Rec[]> {
  const r = await fetch(`${IPFS_URL}/api/v0/cat?arg=${cid}`, {
    method: "POST", headers: { "user-agent": "subgraphs-qos-exporter" },
  });
  if (!r.ok) throw new Error(`ipfs cat ${cid}: HTTP ${r.status}`);
  return (await r.json()) as Rec[];
}

const esc = (s: unknown) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const GAUGES = [
  "graph_qos_query_count", "graph_qos_avg_gateway_latency_ms", "graph_qos_max_gateway_latency_ms",
  "graph_qos_success_rate", "graph_qos_user_error_rate", "graph_qos_avg_query_fee_grt",
];

function render(recs: Rec[]): string {
  const out: string[] = GAUGES.map(
    (g) => `# HELP ${g} network-wide gateway QoS (The Graph QoS oracle feed)\n# TYPE ${g} gauge`);
  for (const r of recs) {
    const h = r.subgraph_deployment_ipfs_hash;
    const lbl = `deployment="${esc(h)}",name="${esc(NAMES[h] ?? "")}",chain="${esc(r.chain)}",gateway="${esc(r.gateway_id)}"`;
    out.push(
      `graph_qos_query_count{${lbl}} ${r.query_count}`,
      `graph_qos_avg_gateway_latency_ms{${lbl}} ${r.avg_gateway_latency_ms}`,
      `graph_qos_max_gateway_latency_ms{${lbl}} ${r.max_gateway_latency_ms}`,
      `graph_qos_success_rate{${lbl}} ${r.gateway_query_success_rate}`,
      `graph_qos_user_error_rate{${lbl}} ${r.user_attributed_error_rate}`,
      `graph_qos_avg_query_fee_grt{${lbl}} ${r.avg_query_fee}`,
    );
  }
  return out.join("\n") + "\n";
}

let lastGood = "";
let up = 0, records = 0, payloadTs = 0, lastRefresh = 0;

async function refresh(): Promise<void> {
  try {
    const p = await latestPayload();
    if (p) {
      const recs = await fetchIpfs(p.hash);
      lastGood = render(recs);
      records = recs.length; payloadTs = p.ts; up = 1;
      console.log(`refreshed: cid=${p.hash} ts=${p.ts} records=${recs.length}`);
    } else {
      up = 0; console.log(`no '${TOPIC}' tx in last ${SCAN_BLOCKS} blocks`);
    }
  } catch (e) {
    up = 0; console.error(`refresh error: ${e}`);
  }
  lastRefresh = Math.floor(Date.now() / 1000);
}

function body(): string {
  return lastGood +
    "# TYPE graph_qos_exporter_up gauge\n" + `graph_qos_exporter_up ${up}\n` +
    "# TYPE graph_qos_records_exported gauge\n" + `graph_qos_records_exported ${records}\n` +
    "# TYPE graph_qos_payload_timestamp_seconds gauge\n" + `graph_qos_payload_timestamp_seconds ${payloadTs}\n` +
    "# TYPE graph_qos_last_refresh_seconds gauge\n" + `graph_qos_last_refresh_seconds ${lastRefresh}\n`;
}

(async function loop() { await refresh(); setTimeout(loop, REFRESH_MS); })();

Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/metrics" || path === "/")
      return new Response(body(), { headers: { "content-type": "text/plain; version=0.0.4" } });
    if (path === "/healthz")
      return new Response(up ? "ok" : "degraded", { status: up ? 200 : 503 });
    return new Response("not found", { status: 404 });
  },
});
console.log(`qos-exporter listening on :${PORT} — contracts=${CONTRACTS.join(",")} topic=${TOPIC} refresh=${REFRESH_MS / 1000}s`);

// Top-level await (deployments.json load) requires this file to be a module.
export {};
