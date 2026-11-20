import { runCli } from "./cli.ts";

runCli().catch((err) => {
  console.error("[lettabox] Fatal error:", err);
  process.exit(1);
});
