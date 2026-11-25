import { runCli } from "./cli.ts";
import { formatLogLine } from "./proxy.ts";

runCli().catch((err) => {
  console.error(formatLogLine("Fatal error:", { level: "ERROR" }), err);
  process.exit(1);
});
