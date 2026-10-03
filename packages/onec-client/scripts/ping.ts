/** Phase 0: call Ping and GetOrganizations through winax.  pnpm --filter @platform/onec-client ping -- --file ... --user ... */
import { connectFromArgs, run } from "./connect.js";

await run(async () => {
  const { client } = await connectFromArgs();
  try {
    console.log(
      JSON.stringify({ ping: await client.ping(), organizations: await client.getOrganizations() }, null, 2),
    );
  } finally {
    await client.close();
  }
});
