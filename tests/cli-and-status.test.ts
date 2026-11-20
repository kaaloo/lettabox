import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycleEmitter, parseCliArgs, runCli } from "../src/cli.ts";
import { loadConfig, readApiKeyFromLettaSettings } from "../src/config.ts";
import { spawnManagedControlPlane } from "../src/control-plane.ts";
import { startStatusServer, type StatusServer } from "../src/status-server.ts";

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
        upstreamReady: true,
        uptimeMs: 1234,
        activeSandboxes: [
          {
            id: "msb-1",
            sandboxName: "letta-msb-abc",
            conversationId: "conv-1",
            hostPort: 49155,
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
    expect(body.upstreamReady).toBe(true);
    expect((body.activeSandboxes as unknown[]).length).toBe(1);

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
    writeFileSync(crashingBin, "#!/usr/bin/env bash\nexit 42\n", { mode: 0o755 });

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
    writeFileSync(sleepingBin, "#!/usr/bin/env bash\nsleep 30\n", { mode: 0o755 });
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
});
