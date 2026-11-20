import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../src/cli.ts";
import { loadConfig, readApiKeyFromLettaSettings } from "../src/config.ts";
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

  test("handles --help and rejects unknown flags", () => {
    expect(parseCliArgs(["--help"], {}).help).toBe(true);
    expect(() => parseCliArgs(["--bogus"], {})).toThrow("Unknown argument: --bogus");
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
});
