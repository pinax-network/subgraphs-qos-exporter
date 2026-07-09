// subgraphs-qos-exporter — serve The Graph's Gateway QoS feed as Prometheus metrics.
//
// The public QoS subgraph is stale (its hardcoded submitter allowlist predates E&N's rotated
// key), but the data itself is posted fresh to a "DataEdge" contract every ~5 min. There are two
// topics; each tx is submitQoSPayload(bytes) with {topic, hash (IPFS CID), timestamp}, the CID a
// JSON array of records:
//   query_result   — one record per (deployment, chain, gateway): network-wide query volume, fees,
//                    gateway-observed latency & success for that 5-min window.
//   indexer_attempt— one record per (indexer, deployment, chain, gateway): each indexer's queries,
//                    latency, 200-rate and BLOCKS BEHIND — the gateway's per-indexer measurement.
// We poll the contract, decode the newest payload(s), fetch from IPFS, and expose:
//   • current-window gauges (per-deployment gateway QoS),
//   • CUMULATIVE counters (queries + fees) summed across windows → VM increase(…[$range]) gives
//     network volume over any window, comparable to our own served-query counter,
//   • a per-deployment network aggregate of indexer blocks-behind (from indexer_attempt).
// Zero npm deps — Bun's global fetch + manual ABI decode.

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error("RPC_URL is required (full JSON-RPC endpoint)"); process.exit(1); }

const IPFS_URL   = (process.env.IPFS_URL ?? "https://ipfs.thegraph.com").replace(/\/+$/, "");
const CONTRACTS  = (process.env.QOS_CONTRACTS ?? "0x5b4293b4c0f36cb5d4448950830bc777759b6c4f")
  .split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
const TOPIC_QR = process.env.QOS_TOPIC ?? "gateway_query_result_qos_5_minutes_prod_v3";
const TOPIC_IA = process.env.QOS_TOPIC_INDEXER ?? "gateway_indexer_attempt_qos_5_minutes_prod_v3";
// Our indexer wallet — drives the graph_qos_our_* rank/share metrics.
const OUR_INDEXER = (process.env.OUR_INDEXER ?? "0x3717cef8020bddee7a18f4efb2bfa88fefdcb1bc").toLowerCase();
const SCAN_BLOCKS = Number(process.env.SCAN_BLOCKS ?? 180);      // ~15 min at 5s blocks
const REFRESH_MS  = Number(process.env.REFRESH_SECONDS ?? 300) * 1000;
const PORT        = Number(process.env.PORT ?? 9090);
// Static name enrichment from local JSON — produced OUT-OF-BAND by scripts/ (see README). The
// exporter itself performs NO auxiliary queries at runtime; it only reads chain RPC + the IPFS
// payload and reports. Both files optional (missing → metrics carry hash/wallet only).
//   deployments.json : { "<ipfs_hash>": "<subgraph display name>" }
//   indexers.json    : { "<indexer_wallet>": "<ENS / display name>" }
const DEPLOYMENTS_FILE = process.env.DEPLOYMENTS_FILE ?? "deployments.json";
const INDEXERS_FILE = process.env.INDEXERS_FILE ?? "indexers.json";
let names: Record<string, string> = {};          // deployment hash → subgraph name
let indexerNames: Record<string, string> = {};   // indexer wallet (lowercase) → ENS / name
try { names = await Bun.file(DEPLOYMENTS_FILE).json(); } catch { /* optional */ }
try {
  const raw = (await Bun.file(INDEXERS_FILE).json()) as Record<string, string>;
  indexerNames = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
} catch { /* optional */ }
console.log(`loaded ${Object.keys(names).length} subgraph names, ${Object.keys(indexerNames).length} indexer names`);

type QRec = {
  subgraph_deployment_ipfs_hash: string; chain: string; gateway_id: string;
  query_count: number; total_query_fees: number; avg_query_fee: number; max_query_fee: number;
  gateway_query_success_rate: number; user_attributed_error_rate: number;
  avg_gateway_latency_ms: number; max_gateway_latency_ms: number; stdev_gateway_latency_ms: number;
  most_recent_query_ts: number;
};
type IARec = {
  subgraph_deployment_ipfs_hash: string; chain: string; indexer_wallet: string; indexer_url: string;
  query_count: number; avg_query_fee: number; max_query_fee: number; total_query_fees: number;
  avg_indexer_latency_ms: number; max_indexer_latency_ms: number; stdev_indexer_latency_ms: number;
  proportion_indexer_200_responses: number;
  avg_indexer_blocks_behind: number; max_indexer_blocks_behind: number;
};
type Found = { hash: string; ts: number };

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
  h = h.slice(8);
  const off = parseInt(h.slice(0, 64), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  return Buffer.from(h.slice(off + 64, off + 64 + len), "hex").toString("utf-8");
}

// Scan recent blocks (newest first) collecting the payloads for both topics, newest-first.
async function scanPayloads(): Promise<{ qr: Found[]; ia: Found[] }> {
  const head = parseInt(await rpc("eth_blockNumber", []), 16);
  const qr: Found[] = [], ia: Found[] = [];
  for (let b = head; b > head - SCAN_BLOCKS; b--) {
    const blk = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), true]);
    if (!blk?.transactions) continue;
    for (const tx of blk.transactions) {
      if (!CONTRACTS.includes((tx.to ?? "").toLowerCase()) || (tx.input ?? "").length <= 10) continue;
      try {
        const p = JSON.parse(decodeBytesArg(tx.input));
        const f = { hash: p.hash, ts: Number(p.timestamp ?? 0) };
        if (p.topic === TOPIC_QR) qr.push(f);
        else if (p.topic === TOPIC_IA) ia.push(f);
      } catch { /* not a payload we parse */ }
    }
  }
  return { qr, ia };
}

const _cache = new Map<string, unknown>();   // per-refresh IPFS cache (avoid double-fetch)
async function fetchIpfs<T>(cid: string): Promise<T[]> {
  if (_cache.has(cid)) return _cache.get(cid) as T[];
  const r = await fetch(`${IPFS_URL}/api/v0/cat?arg=${cid}`, {
    method: "POST", headers: { "user-agent": "subgraphs-qos-exporter" },
  });
  if (!r.ok) throw new Error(`ipfs cat ${cid}: HTTP ${r.status}`);
  const j = (await r.json()) as T[];
  _cache.set(cid, j);
  return j;
}


// ── cumulative state (persists across refreshes; resets on restart → VM handles counter reset) ──
const cumQueries = new Map<string, number>();   // key deployment|chain|gateway -> Σ query_count
const cumFees = new Map<string, number>();       // key deployment|chain|gateway -> Σ total_query_fees
let lastEpoch = 0;                               // newest query_result end_epoch already counted

const esc = (s: unknown) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const lbl3 = (dep: string, chain: string) =>
  `deployment="${esc(dep)}",name="${esc(names[dep] ?? "")}",chain="${esc(chain)}"`;

function render(qrRecs: QRec[], iaRecs: IARec[]): string {
  const out: string[] = [];
  const help = (g: string, t: string, h: string) => out.push(`# HELP ${g} ${h}\n# TYPE ${g} ${t}`);

  // ── current-window gateway QoS (gauges) ──
  for (const g of ["graph_qos_query_count", "graph_qos_avg_gateway_latency_ms",
    "graph_qos_max_gateway_latency_ms", "graph_qos_stdev_gateway_latency_ms", "graph_qos_success_rate",
    "graph_qos_user_error_rate", "graph_qos_avg_query_fee_grt", "graph_qos_max_query_fee_grt",
    "graph_qos_most_recent_query_seconds"]) help(g, "gauge", "network-wide gateway QoS, latest 5-min window");
  for (const r of qrRecs) {
    const l = `${lbl3(r.subgraph_deployment_ipfs_hash, r.chain)},gateway="${esc(r.gateway_id)}"`;
    out.push(
      `graph_qos_query_count{${l}} ${r.query_count}`,
      `graph_qos_avg_gateway_latency_ms{${l}} ${r.avg_gateway_latency_ms}`,
      `graph_qos_max_gateway_latency_ms{${l}} ${r.max_gateway_latency_ms}`,
      `graph_qos_stdev_gateway_latency_ms{${l}} ${r.stdev_gateway_latency_ms ?? 0}`,
      `graph_qos_success_rate{${l}} ${r.gateway_query_success_rate}`,
      `graph_qos_user_error_rate{${l}} ${r.user_attributed_error_rate}`,
      `graph_qos_avg_query_fee_grt{${l}} ${r.avg_query_fee}`,
      `graph_qos_max_query_fee_grt{${l}} ${r.max_query_fee ?? 0}`,
      `graph_qos_most_recent_query_seconds{${l}} ${(r.most_recent_query_ts ?? 0) / 1000}`,
    );
  }

  // ── cumulative counters (network volume/fees over time → increase()[range] compares to ours) ──
  help("graph_qos_queries_total", "counter", "cumulative gateway queries per deployment (network-wide) since exporter start");
  for (const [k, v] of cumQueries) {
    const [dep, chain, gw] = k.split("|");
    out.push(`graph_qos_queries_total{${lbl3(dep!, chain!)},gateway="${esc(gw)}"} ${v}`);
  }
  help("graph_qos_query_fees_grt_total", "counter", "cumulative gateway query fees (GRT) per deployment (network-wide) since exporter start");
  for (const [k, v] of cumFees) {
    const [dep, chain, gw] = k.split("|");
    out.push(`graph_qos_query_fees_grt_total{${lbl3(dep!, chain!)},gateway="${esc(gw)}"} ${v}`);
  }

  // ── indexer_attempt: network view (ALL) + per-indexer detail + our rank (tracked) ──
  help("graph_qos_network_indexers", "gauge", "number of indexers the gateway attempted per deployment");
  help("graph_qos_avg_indexer_latency_ms", "gauge", "network avg indexer latency per deployment, query-weighted");
  help("graph_qos_avg_indexer_blocks_behind", "gauge", "network avg indexer blocks-behind per deployment, query-weighted");
  help("graph_qos_max_indexer_blocks_behind", "gauge", "worst indexer blocks-behind per deployment");
  if (iaRecs.length) {
    for (const [g, h] of [
      ["graph_qos_indexer_query_count", "per-indexer queries the gateway routed for a deployment (5-min)"],
      ["graph_qos_indexer_avg_latency_ms", "per-indexer gateway-measured avg latency"],
      ["graph_qos_indexer_max_latency_ms", "per-indexer gateway-measured max latency"],
      ["graph_qos_indexer_stdev_latency_ms", "per-indexer gateway-measured latency stdev"],
      ["graph_qos_indexer_success_rate", "per-indexer 200-response proportion (0-1)"],
      ["graph_qos_indexer_avg_blocks_behind", "per-indexer avg blocks-behind"],
      ["graph_qos_indexer_max_blocks_behind", "per-indexer max blocks-behind"],
      ["graph_qos_indexer_avg_query_fee_grt", "per-indexer avg query fee (GRT)"],
      ["graph_qos_indexer_max_query_fee_grt", "per-indexer max query fee (GRT)"],
      ["graph_qos_indexer_query_fees_grt", "per-indexer total query fees this window (GRT)"],
      ["graph_qos_our_query_count", "OUR indexer's queries for a deployment (5-min)"],
      ["graph_qos_our_query_share", "OUR share of indexer queries for a deployment (0-1)"],
      ["graph_qos_our_query_rank", "OUR rank by queries among indexers on a deployment (1=most)"],
      ["graph_qos_our_latency_rank", "OUR rank by avg latency among indexers (1=fastest)"],
      ["graph_qos_our_avg_latency_ms", "OUR gateway-measured avg latency for a deployment"],
      ["graph_qos_our_avg_blocks_behind", "OUR avg blocks-behind for a deployment"],
    ] as const) help(g, "gauge", h);
  }
  const byDep = new Map<string, IARec[]>();
  for (const r of iaRecs) {
    const k = `${r.subgraph_deployment_ipfs_hash}|${r.chain}`;
    let arr = byDep.get(k); if (!arr) { arr = []; byDep.set(k, arr); } arr.push(r);
  }
  for (const [k, recs] of byDep) {
    const [dep, chain] = k.split("|");
    const L = lbl3(dep!, chain!);
    const totalQ = recs.reduce((s, r) => s + (r.query_count ?? 0), 0);
    const wlat = recs.reduce((s, r) => s + (r.avg_indexer_latency_ms ?? 0) * (r.query_count ?? 0), 0);
    const wbb = recs.reduce((s, r) => s + (r.avg_indexer_blocks_behind ?? 0) * (r.query_count ?? 0), 0);
    const maxbb = recs.reduce((m, r) => Math.max(m, r.max_indexer_blocks_behind ?? 0), 0);
    out.push(
      `graph_qos_network_indexers{${L}} ${new Set(recs.map((r) => r.indexer_wallet)).size}`,
      `graph_qos_avg_indexer_latency_ms{${L}} ${totalQ ? wlat / totalQ : 0}`,
      `graph_qos_avg_indexer_blocks_behind{${L}} ${totalQ ? wbb / totalQ : 0}`,
      `graph_qos_max_indexer_blocks_behind{${L}} ${maxbb}`,
    );
    // where do WE rank on this subgraph? Computed for EVERY deployment — cheap, and only actually
    // emits where our wallet appears (i.e. the subgraphs the gateway attempted us on = ours).
    const byQ = [...recs].sort((a, b) => (b.query_count ?? 0) - (a.query_count ?? 0));
    const byLat = [...recs].sort((a, b) => (a.avg_indexer_latency_ms ?? 1e12) - (b.avg_indexer_latency_ms ?? 1e12));
    const qi = byQ.findIndex((r) => (r.indexer_wallet ?? "").toLowerCase() === OUR_INDEXER);
    if (qi >= 0) {
      const our = byQ[qi]!;
      const li = byLat.findIndex((r) => (r.indexer_wallet ?? "").toLowerCase() === OUR_INDEXER);
      out.push(
        `graph_qos_our_query_count{${L}} ${our.query_count ?? 0}`,
        `graph_qos_our_query_share{${L}} ${totalQ ? (our.query_count ?? 0) / totalQ : 0}`,
        `graph_qos_our_query_rank{${L}} ${qi + 1}`,
        `graph_qos_our_latency_rank{${L}} ${li + 1}`,
        `graph_qos_our_avg_latency_ms{${L}} ${our.avg_indexer_latency_ms ?? 0}`,
        `graph_qos_our_avg_blocks_behind{${L}} ${our.avg_indexer_blocks_behind ?? 0}`,
      );
    }
    // full per-indexer breakdown is the cardinality driver — gate it to tracked deployments.
    for (const r of recs) {   // full per-indexer breakdown for EVERY deployment (network-wide)
      const iname = indexerNames[(r.indexer_wallet ?? "").toLowerCase()] ?? "";
      const il = `${L},indexer="${esc(r.indexer_wallet)}",indexer_name="${esc(iname)}",indexer_url="${esc(r.indexer_url ?? "")}"`;
      out.push(
        `graph_qos_indexer_query_count{${il}} ${r.query_count ?? 0}`,
        `graph_qos_indexer_avg_latency_ms{${il}} ${r.avg_indexer_latency_ms ?? 0}`,
        `graph_qos_indexer_max_latency_ms{${il}} ${r.max_indexer_latency_ms ?? 0}`,
        `graph_qos_indexer_stdev_latency_ms{${il}} ${r.stdev_indexer_latency_ms ?? 0}`,
        `graph_qos_indexer_success_rate{${il}} ${r.proportion_indexer_200_responses ?? 0}`,
        `graph_qos_indexer_avg_blocks_behind{${il}} ${r.avg_indexer_blocks_behind ?? 0}`,
        `graph_qos_indexer_max_blocks_behind{${il}} ${r.max_indexer_blocks_behind ?? 0}`,
        `graph_qos_indexer_avg_query_fee_grt{${il}} ${r.avg_query_fee ?? 0}`,
        `graph_qos_indexer_max_query_fee_grt{${il}} ${r.max_query_fee ?? 0}`,
        `graph_qos_indexer_query_fees_grt{${il}} ${r.total_query_fees ?? 0}`,
      );
    }
  }
  return out.join("\n") + "\n";
}

let lastGood = "";
let up = 0, records = 0, payloadTs = 0, lastRefresh = 0;

async function refresh(): Promise<void> {
  try {
    _cache.clear();
    const { qr, ia } = await scanPayloads();
    // 1. accumulate cumulative counters for every NEW query_result window (ts > lastEpoch).
    for (const w of qr) {                       // newest-first
      if (w.ts <= lastEpoch) break;             // reached an already-counted window (and older)
      for (const r of await fetchIpfs<QRec>(w.hash)) {
        const k = `${r.subgraph_deployment_ipfs_hash}|${r.chain}|${r.gateway_id}`;
        cumQueries.set(k, (cumQueries.get(k) ?? 0) + (r.query_count ?? 0));
        cumFees.set(k, (cumFees.get(k) ?? 0) + (r.total_query_fees ?? 0));
      }
    }
    if (qr.length && qr[0]!.ts > lastEpoch) lastEpoch = qr[0]!.ts;
    // 2. current-window gauges from the newest payload of each topic.
    const qrRecs = qr.length ? await fetchIpfs<QRec>(qr[0]!.hash) : [];
    const iaRecs = ia.length ? await fetchIpfs<IARec>(ia[0]!.hash) : [];
    lastGood = render(qrRecs, iaRecs);
    records = qrRecs.length; payloadTs = qr[0]?.ts ?? payloadTs; up = 1;
    console.log(`refreshed: qr=${qr.length} ia=${ia.length} windows, latest ts=${payloadTs}, tracked deployments=${cumQueries.size}`);
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

// Pure functions exported for unit tests (bun test). Only start the poller + HTTP server when run
// as the entrypoint, so importing this module in a test has no side effects.
export { decodeBytesArg, render };

if (import.meta.main) {
  // Retry fast (30s) after a failure so a transient RPC/IPFS blip never leaves us stale for a full
  // window (and never fails a k8s rollout, since readiness gates on the first good refresh).
  (async function loop() { await refresh(); setTimeout(loop, up ? REFRESH_MS : 30_000); })();

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
  console.log(`qos-exporter on :${PORT} — contracts=${CONTRACTS.join(",")} topics=[${TOPIC_QR}, ${TOPIC_IA}] refresh=${REFRESH_MS / 1000}s`);
}
