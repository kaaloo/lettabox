import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { RegistrationAuthError, registerEnvironment } from "../src/register.ts";
import { UpstreamRelayClient } from "../src/upstream.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Authentication & login handling", () => {
  test("runCli launches interactive `letta login` in TTY mode when credentials are missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lettabox-auth-"));
    tempDirs.push(dir);
    const settingsFile = join(dir, "settings.json");

    const loginCalls: string[] = [];
    let spawnedWithKey: string | undefined;
    let exitCode: number | undefined;

    await runCli(["--letta-bin", "/usr/local/bin/letta"], {
      env: {
        LETTA_SETTINGS_FILE: settingsFile,
        LETTA_DEVICE_ID_FILE: join(dir, "device-id"),
      },
      isInteractiveTty: true,
      runInteractiveLogin: async (bin) => {
        loginCalls.push(bin);
        writeFileSync(settingsFile, JSON.stringify({ apiKey: "sk-let-logged-in" }), "utf8");
        return 0;
      },
      spawnControlPlane: async (opts) => {
        spawnedWithKey = opts.lettaApiKey;
        throw new Error("stop after verifying token");
      },
      exit: (code) => {
        exitCode = code;
      },
    });

    expect(loginCalls).toEqual(["/usr/local/bin/letta"]);
    expect(spawnedWithKey).toBe("sk-let-logged-in");
    expect(exitCode).toBe(1);
  });

  test("runCli skips interactive login in --lifecycle-output jsonl mode and exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lettabox-auth-jsonl-"));
    tempDirs.push(dir);
    const settingsFile = join(dir, "settings.json");

    let loginCalled = false;
    let exitCode: number | undefined;

    await runCli(["--lifecycle-output", "jsonl"], {
      env: {
        LETTA_SETTINGS_FILE: settingsFile,
        LETTA_DEVICE_ID_FILE: join(dir, "device-id"),
      },
      isInteractiveTty: true,
      runInteractiveLogin: async () => {
        loginCalled = true;
        return 0;
      },
      exit: (code) => {
        exitCode = code;
      },
    });

    expect(loginCalled).toBe(false);
    expect(exitCode).toBe(1);
  });

  test("runCli fails cleanly if interactive login exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lettabox-auth-fail-"));
    tempDirs.push(dir);

    let spawnCalled = false;
    let exitCode: number | undefined;

    await runCli([], {
      env: {
        LETTA_SETTINGS_FILE: join(dir, "settings.json"),
        LETTA_DEVICE_ID_FILE: join(dir, "device-id"),
      },
      isInteractiveTty: true,
      runInteractiveLogin: async () => 1,
      spawnControlPlane: async () => {
        spawnCalled = true;
        throw new Error("should not spawn");
      },
      exit: (code) => {
        exitCode = code;
      },
    });

    expect(spawnCalled).toBe(false);
    expect(exitCode).toBe(1);
  });

  test("registerEnvironment throws RegistrationAuthError on HTTP 401 and 403", async () => {
    for (const status of [401, 403]) {
      const mockFetch = (async () =>
        new Response("Invalid token", { status })) as unknown as typeof fetch;

      let caught: unknown;
      try {
        await registerEnvironment({
          lettaServerUrl: "https://api.letta.com",
          lettaApiKey: "sk-let-expired",
          deviceId: "dev-1",
          listenerInstanceId: "server-1",
          connectionName: "test-mac",
          appServerInfo: { lettaCodeVersion: "0.10.0", supported_commands: [] },
          machine: { model: "📦 MacBook Pro" },
          fetchImpl: mockFetch,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RegistrationAuthError);
      expect((caught as RegistrationAuthError).status).toBe(status);
      expect((caught as Error).message).toContain("letta login");
    }
  });

  test("UpstreamRelayClient fails fast on HTTP 401 registration without retrying", async () => {
    let fetchCount = 0;
    const mockFetch = (async () => {
      fetchCount += 1;
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    let terminalReason: string | undefined;
    let terminalIsError: boolean | undefined;

    const client = new UpstreamRelayClient({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "sk-let-expired",
      deviceId: "dev-1",
      listenerInstanceId: "server-1",
      connectionName: "test-mac",
      appServerInfo: { lettaCodeVersion: "0.10.0", supported_commands: [] },
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 20,
      fetchImpl: mockFetch,
      onMessage: () => {},
      onError: () => {},
      onTerminalClose: (reason, isError) => {
        terminalReason = reason;
        terminalIsError = isError;
      },
    });

    await client.start();
    await Bun.sleep(60);

    expect(fetchCount).toBe(1);
    expect(terminalIsError).toBe(true);
    expect(terminalReason).toContain("HTTP 401");
    expect(terminalReason).toContain("letta login");
  });

  test("readApiKeyFromLettaSettings supports nested env.LETTA_API_KEY written by letta-code", async () => {
    const { readApiKeyFromLettaSettings } = await import("../src/config.ts");
    const dir = mkdtempSync(join(tmpdir(), "lettabox-auth-env-"));
    tempDirs.push(dir);
    const settingsFile = join(dir, "settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({ env: { LETTA_API_KEY: "sk-let-from-env-block" } }),
      "utf8",
    );

    expect(readApiKeyFromLettaSettings(settingsFile)).toBe("sk-let-from-env-block");
  });

  test("resolveLettaApiKeyAsync falls back to Bun.secrets keychain storage", async () => {
    const { resolveLettaApiKeyAsync } = await import("../src/config.ts");
    const dir = mkdtempSync(join(tmpdir(), "lettabox-auth-secret-"));
    tempDirs.push(dir);
    const missingSettings = join(dir, "missing.json");

    const queries: Array<{ service: string; name: string }> = [];
    const key = await resolveLettaApiKeyAsync(
      {
        LETTA_SETTINGS_FILE: missingSettings,
        LETTA_TEST_SECRETS_SERVICE_PREFIX: "test-prefix",
      },
      {
        getSecret: async (opts) => {
          queries.push(opts);
          return "sk-let-from-keychain";
        },
      },
    );

    expect(key).toBe("sk-let-from-keychain");
    expect(queries).toEqual([{ service: "test-prefix:letta-code", name: "letta-api-key" }]);
  });
});
