import { loadConfig } from "./config.ts";
import { PassthroughProxy } from "./proxy.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const proxy = new PassthroughProxy({
    config,
    onTerminalClose: () => {
      process.exit(0);
    },
  });

  const shutdown = (signal: string) => {
    console.log(`[letta-sandbox] Received ${signal}, shutting down...`);
    proxy.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await proxy.start();
}

main().catch((err) => {
  console.error(`[letta-sandbox] Fatal error:`, err);
  process.exit(1);
});
