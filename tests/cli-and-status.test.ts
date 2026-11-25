import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycleEmitter, parseCliArgs, runCli } from "../src/cli.ts";
import { loadConfig, readApiKeyFromLettaSettings } from "../src/config.ts";
import {
  resolveBundledLettaScript,
  resolveLettaCommand,
  spawnManagedControlPlane,
} from "../src/control-plane.ts";
import { createConsoleLogger, formatLogLine } from "../src/proxy.ts";
import { fetchAppServerInfo, waitForDownstreamHealth } from "../src/register.ts";
import { type StatusServer, startStatusServer } from "../src/status-server.ts";

const tempDirs: string[] = [];
const servers: StatusServer[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lettabox-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("lettabox CLI argument parsing", () => {
  test("defaults to microsandbox mode with auto-managed control-plane", () => {
    const parsed = parseCliArgs([], {});
    expect(parsed.help).toBe(false);
    expect(parsed.autoControlPlane).toBe(true);
    expect(parsed.envOverrides.SANDBOX_MODE).toBe("microsandbox");
  });

  test("parses all flags and disables autoControlPlane when --control-plane-url is provided", () => {
    const parsed = parseCliArgs(
      [
        "up",
        "--name",
        "my-mac",
        "--mode",
        "msb",
        "--image",
        "ghcr.io/letta-ai/letta-code:0.34.16",
        "--memory",
        "4G",
        "--cpus",
        "4",
        "--idle-timeout",
        "600000",
        "--control-plane-url",
        "ws://127.0.0.1:4500/ws",
        "--status-port",
        "4590",
        "--msb-path",
        "/usr/local/bin/msb",
        "--debug",
      ],
      {},
    );

    expect(parsed.autoControlPlane).toBe(false);
    expect(parsed.statusPort).toBe(4590);
    expect(parsed.envOverrides).toEqual({
      LETTA_CONNECTION_NAME: "my-mac",
      SANDBOX_MODE: "msb",
      SANDBOX_IMAGE: "ghcr.io/letta-ai/letta-code:0.34.16",
      SANDBOX_MEMORY_LIMIT: "4G",
      SANDBOX_CPU_LIMIT: "4",
      SANDBOX_IDLE_TIMEOUT_MS: "600000",
      CONTROL_PLANE_URL: "ws://127.0.0.1:4500/ws",
      MSB_PATH: "/usr/local/bin/msb",
      DEBUG_FRAMES: "1",
    });
  });

  test("handles --help, --version, and rejects unknown flags", () => {
    expect(parseCliArgs(["--help"], {}).help).toBe(true);
    expect(parseCliArgs(["--version"], {}).version).toBe(true);
    expect(() => parseCliArgs(["--bogus"], {})).toThrow("Unknown argument: --bogus");
    expect(() => parseCliArgs(["--lifecycle-output", "xml"], {})).toThrow(
      "Unsupported --lifecycle-output format",
    );
  });

  test("accepts letta server drop-in flags (--computer-name and --lifecycle-output jsonl)", () => {
    const parsed = parseCliArgs(
      ["server", "--computer-name", "mac-studio", "--lifecycle-output", "jsonl"],
      {},
    );
    expect(parsed.envOverrides.LETTA_CONNECTION_NAME).toBe("mac-studio");
    expect(parsed.lifecycleOutput).toBe("jsonl");
  });

  test("parses cloud backend flags (--backend, --compute-type, --msb-profile, --msb-api-url)", () => {
    const parsed = parseCliArgs(
      [
        "--backend",
        "cloud",
        "--compute-type",
        "shared",
        "--msb-profile",
        "work",
        "--msb-api-url",
        "https://sandbox.example.com",
      ],
      {},
    );
    expect(parsed.envOverrides).toMatchObject({
      SANDBOX_MODE: "microsandbox",
      MSB_BACKEND: "cloud",
      MSB_COMPUTE_TYPE: "shared",
      MSB_PROFILE: "work",
      MSB_API_URL: "https://sandbox.example.com",
    });
  });

  test("createLifecycleEmitter writes deduplicated lettaLifecycleProtocol v1 JSONL lines", () => {
    const lines: string[] = [];
    const emit = createLifecycleEmitter(true, (line) => lines.push(line));
    emit("starting");
    emit("starting");
    emit("ready");
    emit("working");
    emit("working");
    emit("ready");

    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { lettaLifecycleProtocol: 1, state: "starting" },
      { lettaLifecycleProtocol: 1, state: "ready" },
      { lettaLifecycleProtocol: 1, state: "working" },
      { lettaLifecycleProtocol: 1, state: "ready" },
    ]);
  });
});

describe("~/.letta/settings.json API key fallback", () => {
  test("loads API key from settings.json when LETTA_API_KEY env var is absent", () => {
    const dir = makeTempDir();
    const settingsFile = join(dir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ apiKey: "sk-let-from-settings" }), "utf8");

    expect(readApiKeyFromLettaSettings(settingsFile)).toBe("sk-let-from-settings");

    const cfg = loadConfig({
      LETTA_SETTINGS_FILE: settingsFile,
      LETTA_DEVICE_ID: "dev-1",
    });
    expect(cfg.lettaApiKey).toBe("sk-let-from-settings");
  });
});

describe("StatusServer", () => {
  test("serves /healthz and /status JSON snapshot for menubar integration", async () => {
    const srv = startStatusServer({
      port: 0,
      getSnapshot: () => ({
        name: "lettabox",
        connectionName: "my-mac",
        sandboxMode: "microsandbox",
        sandboxBackend: "cloud",
        upstreamReady: true,
        uptimeMs: 1234,
        activeSandboxes: [
          {
            id: "msb-1",
            sandboxName: "letta-msb-abc",
            conversationId: "conv-1",
            serviceUrl: "https://lb-0123456789abcdef.microsandbox.dev",
            busy: true,
            lastActivityAt: 1700000000,
          },
        ],
      }),
    });
    servers.push(srv);

    const healthRes = await fetch(`${srv.url}/healthz`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.text()).toBe("ok");

    const statusRes = await fetch(`${srv.url}/status`);
    expect(statusRes.status).toBe(200);
    const body = (await statusRes.json()) as Record<string, unknown>;
    expect(body.name).toBe("lettabox");
    expect(body.sandboxBackend).toBe("cloud");
    expect(body.upstreamReady).toBe(true);
    expect(body.activeSandboxes).toEqual([
      {
        id: "msb-1",
        sandboxName: "letta-msb-abc",
        conversationId: "conv-1",
        serviceUrl: "https://lb-0123456789abcdef.microsandbox.dev",
        busy: true,
        lastActivityAt: 1700000000,
      },
    ]);

    const notFound = await fetch(`${srv.url}/nope`);
    expect(notFound.status).toBe(404);
  });

  test("runCli stops managed control-plane when --status-port is already occupied", async () => {
    const occupied = startStatusServer({
      port: 0,
      getSnapshot: () => ({
        name: "lettabox",
        connectionName: "occupied",
        sandboxMode: "microsandbox",
        upstreamReady: false,
        uptimeMs: 0,
        activeSandboxes: [],
      }),
    });
    servers.push(occupied);

    let stopped = false;
    const exitCodes: number[] = [];
    const origError = console.error;
    const origLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await runCli(["--status-port", String(occupied.port)], {
        env: {
          LETTA_API_KEY: "test-key",
          LETTA_DEVICE_ID: "dev-1",
        },
        spawnControlPlane: async () => ({
          port: 49999,
          wsUrl: "ws://127.0.0.1:49999/ws",
          httpUrl: "http://127.0.0.1:49999",
          async stop() {
            stopped = true;
          },
        }),
        exit: (code) => {
          exitCodes.push(code);
        },
      });
    } finally {
      console.error = origError;
      console.log = origLog;
    }

    expect(stopped).toBe(true);
    expect(exitCodes).toEqual([1]);
  });

  test("spawnManagedControlPlane does not block when child writes large stdout", async () => {
    const dir = makeTempDir();
    const doneFile = join(dir, "stdout-done");
    const stubBin = join(dir, "stub-letta.sh");
    writeFileSync(
      stubBin,
      `#!/usr/bin/env bash\npython3 -c 'print("x" * 262144)'\ntouch "${doneFile}"\nsleep 30\n`,
      { mode: 0o755 },
    );

    const cp = await spawnManagedControlPlane({
      lettaBin: stubBin,
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
    });

    try {
      const deadline = Date.now() + 3_000;
      const { existsSync } = await import("node:fs");
      while (!existsSync(doneFile) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(existsSync(doneFile)).toBe(true);
    } finally {
      await cp.stop();
    }
  });

  test("spawnManagedControlPlane invokes onUnexpectedExit when child crashes, not on stop()", async () => {
    const dir = makeTempDir();
    const crashingBin = join(dir, "crash-letta.sh");
    writeFileSync(crashingBin, "#!/usr/bin/env bash\nexit 42\n", {
      mode: 0o755,
    });

    const crashCodes: number[] = [];
    const cp = await spawnManagedControlPlane({
      lettaBin: crashingBin,
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      onUnexpectedExit: (code) => {
        crashCodes.push(code);
      },
    });

    const deadline = Date.now() + 2_000;
    while (crashCodes.length === 0 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(crashCodes).toEqual([42]);
    await cp.stop();

    // Intentional stop must NOT trigger onUnexpectedExit
    const sleepingBin = join(dir, "sleep-letta.sh");
    writeFileSync(sleepingBin, "#!/usr/bin/env bash\nsleep 30\n", {
      mode: 0o755,
    });
    const cleanCodes: number[] = [];
    const cp2 = await spawnManagedControlPlane({
      lettaBin: sleepingBin,
      lettaApiKey: "test-key",
      lettaServerUrl: "https://api.letta.com",
      onUnexpectedExit: (code) => {
        cleanCodes.push(code);
      },
    });
    await cp2.stop();
    await Bun.sleep(30);
    expect(cleanCodes).toEqual([]);
  });

  test("resolveBundledLettaScript and resolveLettaCommand prefer bundled @letta-ai/letta-code under Bun", () => {
    const bundled = resolveBundledLettaScript();
    expect(bundled).not.toBeNull();
    expect(bundled?.endsWith("letta.js")).toBe(true);

    expect(resolveLettaCommand(undefined)).toEqual([process.execPath, bundled!]);
    expect(resolveLettaCommand("  ")).toEqual([process.execPath, bundled!]);
    expect(resolveLettaCommand("/custom/letta")).toEqual(["/custom/letta"]);
    expect(resolveLettaCommand(undefined, { resolveBundled: () => null })).toEqual(["letta"]);
  });

  test("spawnManagedControlPlane boots bundled @letta-ai/letta-code without an explicit lettaBin", async () => {
    const cp = await spawnManagedControlPlane({
      lettaApiKey: "test-dummy-key",
      lettaServerUrl: "https://api.letta.com",
    });

    try {
      await waitForDownstreamHealth(cp.httpUrl, { timeoutMs: 15_000, pollIntervalMs: 100 });
      const info = await fetchAppServerInfo(cp.httpUrl);
      const version =
        info.lettaCodeVersion ??
        (typeof info.letta_code_version === "string" ? info.letta_code_version : undefined) ??
        info.version;
      expect(typeof version).toBe("string");
      expect(version?.length).toBeGreaterThan(0);
    } finally {
      await cp.stop();
    }
  });

  test("formatLogLine and createConsoleLogger prepend ISO-8601 UTC timestamps and respect stderrOnly", () => {
    const fixedNow = () => new Date("2026-11-25T15:30:45.123Z");

    expect(formatLogLine("hello", { now: fixedNow })).toBe(
      "2026-11-25T15:30:45.123Z [lettabox] hello",
    );
    expect(
      formatLogLine("boom", { prefix: "lettabox:control-plane", level: "ERROR", now: fixedNow }),
    ).toBe("2026-11-25T15:30:45.123Z [lettabox:control-plane] ERROR: boom");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const warn: string[] = [];
    const logger = createConsoleLogger({
      now: fixedNow,
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
      writeWarn: (line) => warn.push(line),
    });
    logger.info("started");
    logger.warn("slow");
    logger.error("failed");
    logger.debug("frame");

    expect(stdout).toEqual([
      "2026-11-25T15:30:45.123Z [lettabox] started",
      "2026-11-25T15:30:45.123Z [lettabox] DEBUG: frame",
    ]);
    expect(warn).toEqual(["2026-11-25T15:30:45.123Z [lettabox] WARN: slow"]);
    expect(stderr).toEqual(["2026-11-25T15:30:45.123Z [lettabox] ERROR: failed"]);

    const jsonlStdout: string[] = [];
    const jsonlStderr: string[] = [];
    const jsonlLogger = createConsoleLogger({
      stderrOnly: true,
      now: fixedNow,
      writeStdout: (line) => jsonlStdout.push(line),
      writeStderr: (line) => jsonlStderr.push(line),
      writeWarn: (line) => jsonlStdout.push(line),
    });
    jsonlLogger.info("a");
    jsonlLogger.warn("b");
    jsonlLogger.error("c");
    jsonlLogger.debug("d");

    expect(jsonlStdout).toEqual([]);
    expect(jsonlStderr).toEqual([
      "2026-11-25T15:30:45.123Z [lettabox] a",
      "2026-11-25T15:30:45.123Z [lettabox] WARN: b",
      "2026-11-25T15:30:45.123Z [lettabox] ERROR: c",
      "2026-11-25T15:30:45.123Z [lettabox] DEBUG: d",
    ]);
  });
});
