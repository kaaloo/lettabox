import { loadConfig } from "./config.ts";
import { MultiplexerProxy } from "./proxy.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const proxy = new MultiplexerProxy({
    config,
    onTerminalClose: () => {
      process.exit(0);
    },
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[letta-sandbox] Received ${signal}, shutting down...`);
    void proxy.stopAsync().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await proxy.start();
}

main().catch((err) => {
  console.error(`[letta-sandbox] Fatal error:`, err);
  process.exit(1);
});
