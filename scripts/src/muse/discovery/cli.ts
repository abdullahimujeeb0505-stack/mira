import {
  listDiscoveries,
  reclassifyDiscoveries,
  runDiscovery,
} from "./tavily-discovery.js";

async function main(): Promise<void> {
  const command = process.argv.slice(2).find((arg) => arg !== "--") ?? "search";

  if (command === "search") {
    await runDiscovery();
    return;
  }
  if (command === "list") {
    await listDiscoveries();
    return;
  }
  if (command === "verify") {
    const id = process.argv.slice(2).filter((arg) => arg !== "--")[1];
    if (!id) throw new Error('Use "verify <DISCOVERY_ID>".');
    const { verifyDiscovery } = await import("./source-verification.js");
    await verifyDiscovery(id);
    return;
  }
  if (command === "verify-all") {
    const { verifyAllDiscoveries } = await import("./source-verification.js");
    await verifyAllDiscoveries();
    return;
  }
  if (command === "import-approved") {
    await import("./import-approved.js");
    return;
  }
  if (command === "reclassify") {
    await reclassifyDiscoveries();
    return;
  }
  throw new Error('Use "search", "list", "reclassify", "verify <ID>", "verify-all", or "import-approved".');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Discovery failed.");
  process.exitCode = 1;
});
