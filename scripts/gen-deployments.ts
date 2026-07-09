// gen-deployments.ts — regenerate deployments.json: { "<ipfs_hash>": "<subgraph display name>" }
// for every published subgraph on the Graph Network. Run OUT-OF-BAND (cron/CI); the exporter only
// reads the resulting file. Usage:
//   NETWORK_SUBGRAPH_URL="https://gateway.thegraph.com/api/<key>/subgraphs/id/DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp" \
//     bun run scripts/gen-deployments.ts > deployments.json
const URL_ = process.env.NETWORK_SUBGRAPH_URL;
if (!URL_) { console.error("NETWORK_SUBGRAPH_URL required (a Graph Network subgraph GraphQL endpoint)"); process.exit(1); }

async function gql(query: string): Promise<any> {
  const r = await fetch(URL_!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const j = (await r.json()) as any;
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// Cursor-paginate subgraphs by id (skip-pagination caps out on large sets). Each subgraph carries
// its display name (off-chain metadata) + the ipfsHash of its current deployment.
const out: Record<string, string> = {};
let last = "";
for (;;) {
  const d = await gql(`{ subgraphs(first:1000, orderBy:id, where:{id_gt:"${last}"}){
      id metadata{ displayName } currentVersion{ subgraphDeployment{ ipfsHash } } } }`);
  const rows = d.subgraphs ?? [];
  if (!rows.length) break;
  for (const s of rows) {
    const h = s?.currentVersion?.subgraphDeployment?.ipfsHash;
    const nm = s?.metadata?.displayName;
    if (h && nm) out[h] = nm;
  }
  last = rows[rows.length - 1].id;
  console.error(`… ${Object.keys(out).length} named deployments so far`);
}
console.log(JSON.stringify(out, null, 0));
console.error(`done: ${Object.keys(out).length} deployment names`);
export {};
