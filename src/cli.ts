#!/usr/bin/env bun
import pkg from "../package.json";
import { loadConfig, MissingApiKeyError, resolveLettaApiKeyAsync } from "./config.ts";
import {
  type RunningControlPlane,
  resolveLettaCommand,
  spawnManagedControlPlane,
} from "./control-plane.ts";
import { type Logger, MultiplexerProxy } from "./proxy.ts";
import { type StatusServer, startStatusServer } from "./status-server.ts";

export type LifecycleState =
  | "starting"
  | "ready"
  | "working"
  | "reconnecting"
  | "error"
  | "stopped";

export interface CliParseResult {
  help: boolean;
  version: boolean;
  lifecycleOutput?: "jsonl";
  envOverrides: Record<string, string>;
  autoControlPlane: boolean;
  statusPort?: number;
  lettaBin?: string;
}

export const CLI_VERSION = `lettabox ${pkg.version}`;

export const CLI_HELP = `lettabox — Single remote Letta environment backed by per-conversation Microsandbox microVMs

Usage:
  lettabox [options]

Options:
  --name, --computer-name <name>  Environment name in chat.letta.com (default: lettabox-<hostname>)
  --mode <msb|static>             Sandbox mode (default: msb, or static if WORKER_URLS is set)
  --backend <local|cloud>         Microsandbox backend (default: local; alias: remote)
  --compute-type <standard|shared>
                                  Microsandbox Cloud compute tier (cloud backend only)
  --msb-profile <name>            Named Microsandbox profile from ~/.microsandbox/config.json
  --msb-api-url <url>             Override Microsandbox Cloud API endpoint
  --image <oci-image>             OCI image for microVMs (default: ghcr.io/letta-ai/letta-code:latest)
  --memory <size>                 Memory limit per microVM (default: 2G)
  --cpus <count>                  vCPU limit per microVM (default: 2)
  --idle-timeout <ms>             Idle timeout before reaping microVMs (default: 1800000 / 30m)
  --control-plane-url <ws://>     Attach to an existing control-plane letta server instead of auto-spawning
  --status-port <port>            Expose local http://127.0.0.1:<port>/status JSON endpoint
  --lifecycle-output <jsonl>      Emit lettaLifecycleProtocol v1 JSONL events on stdout (for macOS menubar)
  --letta-bin <path>              Override the bundled letta CLI binary for control-plane (advanced)
  --msb-path <path>               Override the SDK-bundled msb runtime binary (advanced)
  --debug                         Log routed envelope frames and event_seq rewrites
  -v, --version                   Print version and exit
  -h, --help                      Show this help message

Environment:
  LETTA_API_KEY                   Letta Cloud API key (or auto-loaded from ~/.letta/settings.json)
  MSB_BACKEND                     Microsandbox backend: local or cloud/remote (default: local)
  MSB_API_KEY                     Microsandbox Cloud API key (required for cloud unless MSB_PROFILE is set)
  MSB_API_URL                     Optional Microsandbox Cloud API URL override
  MSB_PROFILE                     Optional named Microsandbox profile from ~/.microsandbox/config.json
  MSB_COMPUTE_TYPE                Optional Microsandbox Cloud compute tier: standard or shared
  MSB_HOME                        Microsandbox home (default: ~/.lettabox/microsandbox)
`;

export function createLifecycleEmitter(
  enabled: boolean,
  write: (line: string) => void = (line) => process.stdout.write(line),
): (state: LifecycleState) => void {
  let lastState: LifecycleState | null = null;
  return (state: LifecycleState) => {
    if (!enabled || state === lastState) return;
    lastState = state;
    write(`${JSON.stringify({ lettaLifecycleProtocol: 1, state })}\n`);
  };
}

export function parseCliArgs(
  argv: string[],
  baseEnv: Record<string, string | undefined> = process.env,
): CliParseResult {
  const envOverrides: Record<string, string> = {};
  let help = false;
  let version = false;
  let lifecycleOutput: "jsonl" | undefined;
  let explicitControlPlane = Boolean(
    baseEnv.CONTROL_PLANE_URL?.trim() || baseEnv.DOWNSTREAM_URL?.trim(),
  );
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
    if ((arg === "up" || arg === "server") && i === 0) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      version = true;
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
      case "--computer-name":
        envOverrides.LETTA_CONNECTION_NAME = nextValue();
        break;
      case "--mode":
        envOverrides.SANDBOX_MODE = nextValue();
        break;
      case "--backend":
        envOverrides.MSB_BACKEND = nextValue();
        break;
      case "--compute-type":
        envOverrides.MSB_COMPUTE_TYPE = nextValue();
        break;
      case "--msb-profile":
        envOverrides.MSB_PROFILE = nextValue();
        break;
      case "--msb-api-url":
        envOverrides.MSB_API_URL = nextValue();
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
      case "--lifecycle-output": {
        const format = nextValue();
        if (format !== "jsonl") {
          throw new Error(`Unsupported --lifecycle-output format: ${format} (expected "jsonl")`);
        }
        lifecycleOutput = "jsonl";
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
    version,
    lifecycleOutput,
    envOverrides,
    autoControlPlane: !explicitControlPlane,
    statusPort,
    lettaBin,
  };
}

export interface RunCliOptions {
  env?: Record<string, string | undefined>;
  spawnControlPlane?: typeof spawnManagedControlPlane;
  runInteractiveLogin?: (lettaBin: string) => Promise<number>;
  isInteractiveTty?: boolean;
  exit?: (code: number) => void;
}

async function defaultRunInteractiveLogin(lettaBin?: string): Promise<number> {
  const command = resolveLettaCommand(lettaBin);
  const proc = Bun.spawn([...command, "login"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<void> {
  const baseEnv = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const spawnControlPlane = options.spawnControlPlane ?? spawnManagedControlPlane;
  const isInteractiveTty =
    options.isInteractiveTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const parsed = parseCliArgs(argv, baseEnv);
  if (parsed.help) {
    console.log(CLI_HELP);
    return;
  }
  if (parsed.version) {
    console.log(CLI_VERSION);
    return;
  }

  const jsonlMode = parsed.lifecycleOutput === "jsonl";
  const emitLifecycle = createLifecycleEmitter(jsonlMode);
  const logInfo = (msg: string) =>
    jsonlMode ? console.error(`[lettabox] ${msg}`) : console.log(`[lettabox] ${msg}`);

  const proxyLogger: Logger | undefined = jsonlMode
    ? {
        info: (msg) => console.error(`[lettabox] ${msg}`),
        warn: (msg) => console.error(`[lettabox] WARN: ${msg}`),
        error: (msg) => console.error(`[lettabox] ERROR: ${msg}`),
        debug: (msg) => console.error(`[lettabox] DEBUG: ${msg}`),
      }
    : undefined;

  const mergedEnv: Record<string, string | undefined> = {
    ...baseEnv,
    ...parsed.envOverrides,
  };

  let managedControlPlane: RunningControlPlane | null = null;
  let statusServer: StatusServer | null = null;
  let proxy: MultiplexerProxy | null = null;
  let shuttingDown = false;

  const cleanupAndExit = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    emitLifecycle(code === 0 ? "stopped" : "error");
    statusServer?.stop();
    statusServer = null;
    if (proxy) {
      await proxy.stopAsync();
      proxy = null;
    }
    if (managedControlPlane) {
      await managedControlPlane.stop();
      managedControlPlane = null;
    }
    exit(code);
  };

  emitLifecycle("starting");

  try {
    let resolvedApiKey = await resolveLettaApiKeyAsync(mergedEnv);
    if (!resolvedApiKey && !jsonlMode && isInteractiveTty) {
      const explicitBin = parsed.lettaBin?.trim();
      const label = explicitBin || "letta";
      logInfo(`No Letta credentials found. Launching \`${label} login\`...`);
      const loginCode = options.runInteractiveLogin
        ? await options.runInteractiveLogin(label)
        : await defaultRunInteractiveLogin(explicitBin);
      if (loginCode !== 0) {
        throw new MissingApiKeyError(
          `\`${label} login\` exited with code ${loginCode}. Set LETTA_API_KEY or run \`letta login\` to authenticate.`,
        );
      }
      resolvedApiKey = await resolveLettaApiKeyAsync(mergedEnv);
      if (!resolvedApiKey) {
        throw new MissingApiKeyError(
          `\`${label} login\` completed, but no API key was found in ~/.letta/settings.json or keychain. Set LETTA_API_KEY or retry \`letta login\`.`,
        );
      }
    }

    if (resolvedApiKey && !mergedEnv.LETTA_API_KEY?.trim()) {
      mergedEnv.LETTA_API_KEY = resolvedApiKey;
    }

    if (parsed.autoControlPlane) {
      // Load early to resolve LETTA_API_KEY (including ~/.letta/settings.json fallback) & LETTA_SERVER_URL
      const preConfig = loadConfig(mergedEnv);
      logInfo("Starting managed control-plane letta server...");
      managedControlPlane = await spawnControlPlane({
        lettaBin: parsed.lettaBin,
        lettaApiKey: preConfig.lettaApiKey,
        lettaServerUrl: preConfig.lettaServerUrl,
        onStderr: preConfig.debugFrames
          ? (line) => {
              console.error(`[lettabox:control-plane] ${line}`);
            }
          : undefined,
        onUnexpectedExit: (exitCode) => {
          console.error(
            `[lettabox] Managed control-plane exited unexpectedly (code ${exitCode}), shutting down...`,
          );
          void cleanupAndExit(1);
        },
      });
      mergedEnv.CONTROL_PLANE_URL = managedControlPlane.wsUrl;
    }

    const config = loadConfig(mergedEnv);
    const startedAt = Date.now();
    let upstreamReady = false;
    let working = false;

    const activeProxy = new MultiplexerProxy({
      config,
      logger: proxyLogger,
      onUpstreamReady: () => {
        upstreamReady = true;
        working = activeProxy.listActiveSandboxes().some((s) => s.busy);
        emitLifecycle(working ? "working" : "ready");
      },
      onUpstreamDisconnect: () => {
        upstreamReady = false;
        if (!shuttingDown) {
          emitLifecycle("reconnecting");
        }
      },
      onWorkingChange: (anyBusy) => {
        working = anyBusy;
        if (upstreamReady && !shuttingDown) {
          emitLifecycle(anyBusy ? "working" : "ready");
        }
      },
      onTerminalClose: (_reason, isError) => {
        void cleanupAndExit(isError ? 1 : 0);
      },
    });
    proxy = activeProxy;

    if (parsed.statusPort !== undefined) {
      statusServer = startStatusServer({
        port: parsed.statusPort,
        getSnapshot: () => ({
          name: "lettabox",
          connectionName: config.connectionName,
          sandboxMode: config.sandboxMode,
          sandboxBackend:
            config.sandboxMode === "microsandbox" ? config.sandbox.backend : undefined,
          upstreamReady,
          uptimeMs: Date.now() - startedAt,
          activeSandboxes: activeProxy.listActiveSandboxes(),
        }),
      });
      logInfo(`Status endpoint listening at ${statusServer.url}/status`);
    }

    process.on("SIGINT", () => {
      logInfo("Received SIGINT, shutting down...");
      void cleanupAndExit(0);
    });
    process.on("SIGTERM", () => {
      logInfo("Received SIGTERM, shutting down...");
      void cleanupAndExit(0);
    });

    await activeProxy.start();
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
