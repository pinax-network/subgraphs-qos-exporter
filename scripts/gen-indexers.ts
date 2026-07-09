// gen-indexers.ts — regenerate indexers.json: { "<indexer_wallet>": "<name>" } for every registered
// indexer with more than MIN_STAKE_GRT staked (default 100000). The stake floor prunes deregistered /
// unstaked indexers. Name preference: ENS primary name (reverse resolution on mainnet) →
// network-subgraph defaultDisplayName → URL host. Run OUT-OF-BAND (cron/CI); the exporter only reads
// the file. Usage:
//   NETWORK_SUBGRAPH_URL="https://gateway.thegraph.com/api/<key>/subgraphs/id/DZz4…" \
//   MAINNET_RPC_URL="https://eth.rpc.example/v1/<key>/" \
//   MIN_STAKE_GRT=100000 \
//     bun run scripts/gen-indexers.ts > indexers.json
import { keccak_256 } from "@noble/hashes/sha3.js";
const NET = process.env.NETWORK_SUBGRAPH_URL;
const RPC = process.env.MAINNET_RPC_URL ?? "";   // optional; without it, ENS reverse is skipped
const MIN_STAKE_GRT = Number(process.env.MIN_STAKE_GRT ?? 100000);   // prune deregistered / sub-floor indexers
const MIN_STAKE_WEI = (BigInt(Math.max(0, Math.round(MIN_STAKE_GRT))) * 10n ** 18n).toString();
if (!NET) { console.error("NETWORK_SUBGRAPH_URL required"); process.exit(1); }

async function gql(query: string): Promise<any> {
  const r = await fetch(NET!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const j = (await r.json()) as any;
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
  return ((await r.json()) as any).result ?? "0x";
}

// keccak256 for ENS namehash (Bun's CryptoHasher does NOT support keccak256 → use @noble/hashes).
function keccak(hex: string): string {
  return "0x" + Buffer.from(keccak_256(Buffer.from(hex.replace(/^0x/, ""), "hex"))).toString("hex");
}
function keccakStr(s: string): string {
  return "0x" + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex");
}
function namehash(name: string): string {
  let node = "0x" + "00".repeat(32);
  if (name) for (const label of name.split(".").reverse()) node = keccak(node.slice(2) + keccakStr(label).slice(2));
  return node;
}
function decodeString(ret: string): string {
  // ABI-encoded string: [offset][length][data]
  const h = ret.replace(/^0x/, "");
  if (h.length < 128) return "";
  const len = parseInt(h.slice(64, 128), 16);
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf-8");
}
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e".toLowerCase();
async function ensReverse(addr: string): Promise<string> {
  if (!RPC) return "";
  try {
    const node = namehash(`${addr.slice(2).toLowerCase()}.addr.reverse`);
    // registry.resolver(node) → 0x0178b8bf
    const resolver = "0x" + (await ethCall(ENS_REGISTRY, "0x0178b8bf" + node.slice(2))).slice(26);
    if (/^0x0+$/.test(resolver)) return "";
    // resolver.name(node) → 0x691f3431
    return decodeString(await ethCall(resolver, "0x691f3431" + node.slice(2)));
  } catch { return ""; }
}

const out: Record<string, string> = {};
let last = "";
for (;;) {
  const d = await gql(`{ indexers(first:1000, orderBy:id, where:{id_gt:"${last}", stakedTokens_gt:"${MIN_STAKE_WEI}"}){ id defaultDisplayName url } }`);
  const rows = d.indexers ?? [];
  if (!rows.length) break;
  for (const ix of rows) {
    const ens = await ensReverse(ix.id);
    const host = (ix.url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    out[ix.id.toLowerCase()] = ens || ix.defaultDisplayName || host || "";
  }
  last = rows[rows.length - 1].id;
  console.error(`… ${Object.keys(out).length} indexers (> ${MIN_STAKE_GRT} GRT)`);
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).sort()), null, 2));
console.error(`done: ${Object.keys(out).length} indexers (${Object.values(out).filter(Boolean).length} named), floor ${MIN_STAKE_GRT} GRT`);
export {};
