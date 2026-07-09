# subgraphs-qos-exporter

A tiny [Bun](https://bun.sh) service that exposes **The Graph's Gateway QoS data as Prometheus
metrics** — read straight off the on-chain feed, bypassing the (stale) public QoS subgraph.

## What the QoS feed publishes

E&N posts QoS data to a **DataEdge** contract on Gnosis every ~5 minutes. Each
`submitQoSPayload(bytes)` tx is `{topic, hash (IPFS CID), timestamp}`; the CID holds a JSON array.
There are **two topics**, each a 5-min window:

### 1. `gateway_query_result_qos_5_minutes_prod_v3` — network-wide, per subgraph
~1,186 records/window, keyed by **(deployment, chain, gateway)**:

| field | example | exporter metric |
|---|---|---|
| `subgraph_deployment_ipfs_hash` | `Qmbsc6XQ…` | → `deployment` label |
| `chain` | `base` | → `chain` label |
| `gateway_id` | `0xff4b7a5e…` | → `gateway` label |
| `start_epoch` / `end_epoch` | `1783554000` / `…300` | → `graph_qos_payload_timestamp_seconds` |
| `query_count` | `42119` | ✅ `graph_qos_query_count` (window) · `graph_qos_queries_total` (counter) |
| `total_query_fees` | `47.408` GRT | ✅ `graph_qos_query_fees_grt_total` (counter) |
| `avg_query_fee` / `max_query_fee` | `0.001126` / `0.001147` | ✅ `graph_qos_avg_query_fee_grt` (avg only) |
| `gateway_query_success_rate` | `1.0` | ✅ `graph_qos_success_rate` |
| `user_attributed_error_rate` | `0.0` | ✅ `graph_qos_user_error_rate` |
| `avg_gateway_latency_ms` | `357.5` | ✅ `graph_qos_avg_gateway_latency_ms` |
| `max_gateway_latency_ms` | `15066` | ✅ `graph_qos_max_gateway_latency_ms` |
| `stdev_gateway_latency_ms` | `489.4` | ⬜ not yet exported |
| `most_recent_query_ts` | `1783554299949` | ⬜ not exported |

### 2. `gateway_indexer_attempt_qos_5_minutes_prod_v3` — **per-indexer**, per subgraph
~2,708 records/window, keyed by **(indexer_wallet, indexer_url, deployment, chain, gateway)**:

| field | example | exporter metric |
|---|---|---|
| `indexer_wallet` | `0xf92f430d…` | → `indexer` label |
| `indexer_url` | `https://graph-l2prod.ellipfra.com/` | → `indexer_url` label |
| `subgraph_deployment_ipfs_hash` / `chain` / `gateway_id` | `Qmbsc6XQ…` / `base` / `0xff4b…` | → labels |
| `query_count` | `42119` | ✅ `graph_qos_indexer_query_count` |
| `avg/max/stdev_indexer_latency_ms` | `355` / `15064` / `489` | ✅ `graph_qos_indexer_avg_latency_ms` · `…_max_latency_ms` (stdev ⬜) |
| `num_indexer_200_responses` / `proportion_indexer_200_responses` | `42119` / `1.0` | ✅ `graph_qos_indexer_success_rate` (proportion) |
| `avg_indexer_blocks_behind` / `max_indexer_blocks_behind` | `9.34` / `91` | ✅ `graph_qos_indexer_avg_blocks_behind` · `…_max_blocks_behind` |
| `avg/max/total_query_fees` | per-indexer fees | ⬜ not yet exported |

**Why this matters (the per-indexer topic):** it carries *each indexer's* gateway-measured latency,
success proportion and blocks-behind per subgraph — so we can extract **our own indexer's exact
gateway-scored QoS and where we rank against competitors on each deployment** (the authoritative
answer to "why are/aren't we in the gateway's top-3 here?"). The exporter derives, per deployment:

| metric | meaning |
|---|---|
| `graph_qos_network_indexers` | how many indexers the gateway attempted |
| `graph_qos_avg_indexer_blocks_behind` / `…_max_…` | network blocks-behind (query-weighted / worst) |
| `graph_qos_our_query_count` / `graph_qos_our_query_share` | our queries / our share of them (0–1) |
| `graph_qos_our_query_rank` / `graph_qos_our_latency_rank` | our rank among indexers (1 = best) |
| `graph_qos_our_avg_latency_ms` / `graph_qos_our_avg_blocks_behind` | our gateway-measured values |

Everything is exposed by default — `graph_qos_indexer_*` (per-indexer) and `graph_qos_our_*` (rank
vs competitors) are emitted for **every** deployment/indexer the gateway reports (~30k series). No
allow-list to configure. Subgraph **names** are optional: set `NAME_QUERY_URL` (a network-subgraph
GraphQL endpoint) and the exporter resolves deployment hash → display name into a `name` label;
unset, series carry the hash only (fully portable). Indexers are identified by their `indexer_url`.

## Why not the QoS subgraph?

The published Gateway QoS Oracle subgraph is **stale**: its mapping hardcodes a submitter allowlist
and E&N rotated the submitter key, so it rejects every new message and stopped producing data points
(frozen since ~2026-07-01; the gateway and downstream tools like Lodestar are frozen with it). The
underlying feed is fine, though — this exporter reads it directly, so it has no subgraph /
submitter-allowlist coupling and survives future key rotations.

## Health / meta metrics
`graph_qos_exporter_up` · `graph_qos_records_exported` · `graph_qos_payload_timestamp_seconds` ·
`graph_qos_last_refresh_seconds`. `GET /healthz` → 200 when the last refresh succeeded, else 503.

## Configuration (env)

| var | default | |
|---|---|---|
| `RPC_URL` | **(required)** | full JSON-RPC endpoint for the chain the DataEdge contract lives on (Gnosis) |
| `IPFS_URL` | `https://ipfs.thegraph.com` | base for `POST /api/v0/cat?arg=<cid>` (a kubo API; point at your own for reliability) |
| `QOS_CONTRACTS` | `0x5b4293b4c0f36cb5d4448950830bc777759b6c4f` | comma-separated DataEdge contract allowlist |
| `QOS_TOPIC` / `QOS_TOPIC_INDEXER` | the two topics above | override the topics to select |
| `OUR_INDEXER` | `0x3717cef8…` | our indexer wallet — drives the `graph_qos_our_*` rank/share metrics |
| `NAME_QUERY_URL` | *(unset)* | optional network-subgraph GraphQL endpoint; resolves deployment hash → subgraph display name (`name` label). Unset = hash only |
| `SCAN_BLOCKS` | `180` | recent blocks scanned per refresh (DataEdge emits no events → a block scan is required; early-exits at already-counted windows) |
| `REFRESH_SECONDS` | `300` | poll cadence (feed is 5-min) |
| `PORT` | `9090` | |
| `OUR_INDEXER` | `0x3717cef8…` | our indexer wallet — drives the `graph_qos_our_*` rank/share metrics |

## Run

```bash
# local (see .env.example)
RPC_URL="https://gnosis.rpc.example/v1/<key>/" bun run src/index.ts
# → curl localhost:9090/metrics

# docker
docker run -e RPC_URL="https://gnosis.rpc.example/v1/<key>/" -p 9090:9090 \
  ghcr.io/pinax-network/subgraphs-qos-exporter:latest
```

Images publish to `ghcr.io/pinax-network/subgraphs-qos-exporter` via `.github/workflows/docker.yml`
on push to `main` (`latest` + `sha-<short>`) and on `v*` tags. Any Prometheus/VictoriaMetrics setup
can scrape `:9090/metrics`; runs as a single stateless replica (re-derives state from chain each cycle;
cumulative counters reset on restart, which VM's `increase()` handles).
