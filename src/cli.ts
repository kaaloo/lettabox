#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { type RunningControlPlane, spawnManagedControlPlane } from "./control-plane.ts";
import { MultiplexerProxy } from "./proxy.ts";
import { startStatusServer, type StatusServer } from "./status-server.ts";

export interface CliParseResult {
  help: boolean;
  envOverrides: Record<string, string>;
  autoControlPlane: boolean;
  statusPort?: number;
  lettaBin?: string;
}

export const CLI_HELP = `lettabox — Single remote Letta environment backed by per-conversation Microsandbox microVMs

Usage:
  lettabox [options]

Options:
  --name <name>                 Environment name in chat.letta.com (default: lettabox-<hostname>)
  --mode <msb|static>           Sandbox mode (default: msb, or static if WORKER_URLS is set)
  --image <oci-image>           OCI image for microVMs (default: ghcr.io/letta-ai/letta-code:latest)
  --memory <size>               Memory limit per microVM (default: 2G)
  --cpus <count>                vCPU limit per microVM (default: 2)
  --idle-timeout <ms>           Idle timeout before reaping microVMs (default: 1800000 / 30m)
  --control-plane-url <ws://>   Attach to an existing control-plane letta server instead of auto-spawning
  --status-port <port>          Expose local http://127.0.0.1:<port>/status JSON endpoint (e.g. for menubar)
  --letta-bin <path>            Path to local letta CLI binary for control-plane (default: letta)
  --msb-path <path>             Path to msb binary (default: msb)
  --debug                       Log routed envelope frames and event_seq rewrites
  -h, --help                    Show this help message

Environment:
  LETTA_API_KEY                 Letta Cloud API key (or auto-loaded from ~/.letta/settings.json)
`;

export function parseCliArgs(
  argv: string[],
  baseEnv: Record<string, string | undefined> = process.env,
): CliParseResult {
  const envOverrides: Record<string, string> = {};
  let help = false;
  let explicitControlPlane = Boolean(baseEnv.CONTROL_PLANE_URL?.trim() || baseEnv.DOWNSTREAM_URL?.trim());
  let statusPort: number | undefined;
  let lettaBin = baseEnv.LETTA_BIN?.trim();

  if (baseEnv.STATUS_PORT?.trim()) {
    const parsed = Number.parseInt(baseEnv.STATUS_PORT.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid STATUS_PORT: ${baseEnv.STATUS_PORT}`);
    }
    statusPort = parsed;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "up" && i === 0) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--debug") {
      envOverrides.DEBUG_FRAMES = "1";
      continue;
    }

    const nextValue = () => {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      return val;
    };

    switch (arg) {
      case "--name":
        envOverrides.LETTA_CONNECTION_NAME = nextValue();
        break;
      case "--mode":
        envOverrides.SANDBOX_MODE = nextValue();
        break;
      case "--image":
        envOverrides.SANDBOX_IMAGE = nextValue();
        break;
      case "--memory":
        envOverrides.SANDBOX_MEMORY_LIMIT = nextValue();
        break;
      case "--cpus":
        envOverrides.SANDBOX_CPU_LIMIT = nextValue();
        break;
      case "--idle-timeout":
        envOverrides.SANDBOX_IDLE_TIMEOUT_MS = nextValue();
        break;
      case "--control-plane-url":
        envOverrides.CONTROL_PLANE_URL = nextValue();
        explicitControlPlane = true;
        break;
      case "--status-port": {
        const raw = nextValue();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid --status-port: ${raw}`);
        }
        statusPort = parsed;
        break;
      }
      case "--letta-bin":
        lettaBin = nextValue();
        break;
      case "--msb-path":
        envOverrides.MSB_PATH = nextValue();
        break;
      default:
        throw new Error(`Unknown argument: ${arg} (run with --help for usage)`);
    }
  }

  // Default CLI experience uses Microsandbox unless WORKER_URLS or explicit --mode/SANDBOX_MODE is set
  if (!envOverrides.SANDBOX_MODE && !baseEnv.SANDBOX_MODE && !baseEnv.WORKER_URLS?.trim()) {
    envOverrides.SANDBOX_MODE = "microsandbox";
  }

  return {
    help,
    envOverrides,
    autoControlPlane: !explicitControlPlane,
    statusPort,
    lettaBin,
  };
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv, process.env);
  if (parsed.help) {
    console.log(CLI_HELP);
    return;
  }

  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    ...parsed.envOverrides,
  };

  let managedControlPlane: RunningControlPlane | null = null;
  if (parsed.autoControlPlane) {
    // Load early to resolve LETTA_API_KEY (including ~/.letta/settings.json fallback) & LETTA_SERVER_URL
    const preConfig = loadConfig(mergedEnv);
    console.log("[lettabox] Starting managed control-plane letta server...");
    managedControlPlane = await spawnManagedControlPlane({
      lettaBin: parsed.lettaBin,
      lettaApiKey: preConfig.lettaApiKey,
      lettaServerUrl: preConfig.lettaServerUrl,
      onStderr: (line) => {
        if (preConfig.debugFrames) {
          console.error(`[lettabox:control-plane] ${line}`);
        }
      },
    });
    mergedEnv.CONTROL_PLANE_URL = managedControlPlane.wsUrl;
  }

  const config = loadConfig(mergedEnv);
  const startedAt = Date.now();
  let upstreamReady = false;
  let statusServer: StatusServer | null = null;

  const proxy = new MultiplexerProxy({
    config,
    onUpstreamReady: () => {
      upstreamReady = true;
    },
    onTerminalClose: () => {
      void cleanupAndExit(0);
    },
  });

  if (parsed.statusPort !== undefined) {
    statusServer = startStatusServer({
      port: parsed.statusPort,
      getSnapshot: () => ({
        name: "lettabox",
        connectionName: config.connectionName,
        sandboxMode: config.sandboxMode,
        upstreamReady,
        uptimeMs: Date.now() - startedAt,
        activeSandboxes: proxy.listActiveSandboxes(),
      }),
    });
    console.log(`[lettabox] Status endpoint listening at ${statusServer.url}/status`);
  }

  let shuttingDown = false;
  const cleanupAndExit = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    statusServer?.stop();
    await proxy.stopAsync();
    if (managedControlPlane) {
      await managedControlPlane.stop();
    }
    process.exit(code);
  };

  process.on("SIGINT", () => {
    console.log("[lettabox] Received SIGINT, shutting down...");
    void cleanupAndExit(0);
  });
  process.on("SIGTERM", () => {
    console.log("[lettabox] Received SIGTERM, shutting down...");
    void cleanupAndExit(0);
  });

  try {
    await proxy.start();
  } catch (err) {
    console.error("[lettabox] Fatal error:", err);
    await cleanupAndExit(1);
  }
}

if (import.meta.main) {
  runCli().catch((err) => {
    console.error("[lettabox] Fatal error:", err);
    process.exit(1);
  });
}
