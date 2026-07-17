// gen-deployments.ts — regenerate deployments.json: { "<ipfs_hash>": "<subgraph display name>" }
// for EVERY deployment on the Graph Network (not just each subgraph's current version), so newly
// synced / older-version deployments resolve a name without hand-editing this file. Run OUT-OF-BAND
// (the scheduled refresh-names.yml workflow, or manually):
//   NETWORK_SUBGRAPH_URL="https://gateway.thegraph.com/api/<key>/subgraphs/id/DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp" \
//     bun run scripts/gen-deployments.ts > deployments.json
//
// The exporter only READS the result; a missing hash falls back to a short deployment id.
const URL_ = process.env.NETWORK_SUBGRAPH_URL;
if (!URL_) { console.error("NETWORK_SUBGRAPH_URL required (a Graph Network subgraph GraphQL endpoint)"); process.exit(1); }

async function gql(query: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(URL_!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      const j = (await r.json()) as any;
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      return j.data;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
    }
  }
}

// Enumerate deployments directly (cursor-paginate by id; skip-pagination caps out on large sets).
// Each deployment carries its ipfsHash and the versions that point at it; a version links to a
// subgraph whose off-chain metadata holds the display name. Prefer the newest version's subgraph
// name (the canonical publisher), so a deployment reused across subgraphs still gets a stable name.
const out: Record<string, string> = {};
let last = "";
let scanned = 0;
for (;;) {
  const d = await gql(`{ subgraphDeployments(first:1000, orderBy:id, where:{id_gt:"${last}"}){
      id ipfsHash
      versions(first:1, orderBy:version, orderDirection:desc){ subgraph{ metadata{ displayName } } }
    } }`);
  const rows = d.subgraphDeployments ?? [];
  if (!rows.length) break;
  for (const dep of rows) {
    scanned++;
    const h = dep?.ipfsHash;
    const nm = dep?.versions?.[0]?.subgraph?.metadata?.displayName;
    if (h && typeof nm === "string" && nm.trim()) out[h] = nm.trim();
  }
  last = rows[rows.length - 1].id;
  console.error(`… scanned ${scanned} deployments, ${Object.keys(out).length} named so far`);
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).sort()), null, 2));
console.error(`done: ${Object.keys(out).length} named of ${scanned} deployments`);
export {};
