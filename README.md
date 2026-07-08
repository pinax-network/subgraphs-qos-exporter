# subgraphs-qos-exporter

A tiny [Bun](https://bun.sh) service that exposes **The Graph's Gateway QoS data as Prometheus
metrics** — read straight off the on-chain feed, bypassing the public QoS subgraph.

## Why not the QoS subgraph?

The published Gateway QoS Oracle subgraph is **stale**: its mapping hardcodes a submitter allowlist,
and Edge & Node rotated the QoS submitter key, so the subgraph rejects every new message and stops
producing data points (frozen since ~2026-07-01; the gateway and downstream tools like Lodestar are
frozen with it).

The underlying data is **not** dark, though. E&N still posts a fresh payload to a "DataEdge" contract
on Gnosis every ~5 minutes. Each `submitQoSPayload(bytes)` tx carries `{topic, hash, timestamp}` where
`hash` is an IPFS CID pointing at a JSON array of per-deployment QoS records. This exporter polls the
contract, decodes the newest matching payload, fetches it from IPFS, and serves it — no subgraph, no
submitter-allowlist coupling (so it survives future key rotations).

## Metrics

`GET /metrics` (Prometheus text). One series per deployment (network-wide, ~1,100 across ~48 chains):

| metric | |
|---|---|
| `graph_qos_query_count` | queries in the 5-min window |
| `graph_qos_avg_gateway_latency_ms` / `graph_qos_max_gateway_latency_ms` | gateway-observed latency |
| `graph_qos_success_rate` / `graph_qos_user_error_rate` | 0–1 |
| `graph_qos_avg_query_fee_grt` | avg fee |
| `graph_qos_exporter_up` / `graph_qos_records_exported` / `graph_qos_payload_timestamp_seconds` / `graph_qos_last_refresh_seconds` | health |

Labels: `deployment` (IPFS hash), `name` (from `deployments.json`, blank if unknown), `chain`, `gateway`.
`GET /healthz` → 200 when the last refresh succeeded, else 503.

## Configuration (env)

| var | default | |
|---|---|---|
| `RPC_URL` | **(required)** | full JSON-RPC endpoint for the chain the DataEdge contract lives on (Gnosis) |
| `IPFS_URL` | `https://ipfs.thegraph.com` | base for `POST /api/v0/cat?arg=<cid>` (a kubo API; point at your own for reliability) |
| `QOS_CONTRACTS` | `0x5b4293b4c0f36cb5d4448950830bc777759b6c4f` | comma-separated DataEdge contract allowlist — narrows which txs are decoded |
| `QOS_TOPIC` | `gateway_query_result_qos_5_minutes_prod_v3` | payload topic to select |
| `SCAN_BLOCKS` | `180` | how many recent blocks to scan per refresh (DataEdge emits no events, so a block scan is required; the scan early-exits at the newest match) |
| `REFRESH_SECONDS` | `300` | poll cadence (feed is 5-min) |
| `PORT` | `9090` | |
| `DEPLOYMENTS_FILE` | `deployments.json` | `{ipfs_hash: name}` label enrichment (not a filter) |

## Run

```bash
# local
RPC_URL="https://gnosis.rpc.example/v1/<key>/" bun run src/index.ts
# → curl localhost:9090/metrics

# docker
docker build -t subgraphs-qos-exporter .
docker run -e RPC_URL="https://gnosis.rpc.example/v1/<key>/" -p 9090:9090 subgraphs-qos-exporter
```

Images are published to `ghcr.io/<owner>/subgraphs-qos-exporter` by `.github/workflows/docker.yml`
on push to `main` (`latest` + `sha-<short>`) and on `v*` tags (`{{version}}`).

## Deploy

Any Prometheus/VictoriaMetrics setup can scrape `:9090/metrics`. It runs as a single stateless
replica (it just re-derives state from the chain every cycle).
