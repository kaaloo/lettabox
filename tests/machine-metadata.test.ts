import { describe, expect, test } from "bun:test";
import {
  collectMachineMetadata,
  LETTABOX_STATUS_EMOJI,
  type MachineMetadataSources,
} from "../src/machine-metadata.ts";
import { registerEnvironment } from "../src/register.ts";

function makeSources(overrides: Partial<MachineMetadataSources>): MachineMetadataSources {
  return {
    platform: "darwin",
    architecture: "arm64",
    cpu: "Apple M5 Pro",
    memoryBytes: 24 * 1024 ** 3,
    read: async () => {
      throw new Error("not found");
    },
    run: async () => "",
    ...overrides,
  };
}

describe("collectMachineMetadata", () => {
  test("parses macOS system_profiler output and prefixes model with emoji", async () => {
    const metadata = await collectMachineMetadata(
      makeSources({
        platform: "darwin",
        architecture: "arm64",
        memoryBytes: 24 * 1024 ** 3,
        run: async () =>
          JSON.stringify({
            SPHardwareDataType: [{ machine_name: "MacBook Pro", chip_type: "Apple M5 Pro" }],
            SPSoftwareDataType: [{ os_version: "macOS 15.4 (24E248)" }],
            SPDisplaysDataType: [{ sppci_model: "Apple M5 Pro" }],
          }),
      }),
    );

    expect(metadata).toEqual({
      model: `${LETTABOX_STATUS_EMOJI} MacBook Pro`,
      osName: "macOS",
      osVersion: "15.4",
      architecture: "arm64",
      cpu: "Apple M5 Pro",
      memoryBytes: 24 * 1024 ** 3,
      gpus: ["Apple M5 Pro"],
    });
  });

  test("parses Linux host metadata and applies cgroup memory limit", async () => {
    const files: Record<string, string> = {
      "/etc/os-release": 'NAME="Ubuntu"\nVERSION_ID="24.04"\n',
      "/sys/class/dmi/id/product_name": "ThinkPad X1 Carbon\n",
      "/sys/fs/cgroup/memory.max": String(16 * 1024 ** 3),
    };

    const metadata = await collectMachineMetadata(
      makeSources({
        platform: "linux",
        architecture: "x64",
        cpu: "AMD Ryzen 9",
        memoryBytes: 64 * 1024 ** 3,
        read: async (path) => {
          const content = files[path];
          if (content === undefined) throw new Error("ENOENT");
          return content;
        },
        run: async (cmd) =>
          cmd === "lspci" ? "01:00.0 VGA compatible controller: NVIDIA RTX 4090\n" : "",
      }),
    );

    expect(metadata).toEqual({
      model: `${LETTABOX_STATUS_EMOJI} ThinkPad X1 Carbon`,
      osName: "Ubuntu",
      osVersion: "24.04",
      architecture: "x64",
      cpu: "AMD Ryzen 9",
      memoryBytes: 16 * 1024 ** 3,
      gpus: ["NVIDIA RTX 4090"],
    });
  });

  test("falls back to emoji + osName when platform probe fails or times out", async () => {
    const metadata = await collectMachineMetadata(
      makeSources({
        platform: "darwin",
        run: async () => {
          throw new Error("system_profiler unavailable");
        },
      }),
      50,
    );

    expect(metadata.model).toBe(`${LETTABOX_STATUS_EMOJI} macOS`);
    expect(metadata.osName).toBe("macOS");
    expect(metadata.cpu).toBe("Apple M5 Pro");
    expect(metadata.memoryBytes).toBe(24 * 1024 ** 3);
  });

  test("registerEnvironment includes metadata.machine in the registration payload", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Response.json({
        connectionId: "conn-meta",
        wsUrl: "wss://api.letta.com/ws",
        supportsSplitStatusChannels: true,
        supportsPairedListenerGenerations: true,
      });
    }) as unknown as typeof fetch;

    await registerEnvironment({
      lettaServerUrl: "https://api.letta.com",
      lettaApiKey: "test-key",
      deviceId: "dev-1",
      listenerInstanceId: "server-abc",
      connectionName: "Luis's MacBook Pro",
      appServerInfo: { lettaCodeVersion: "0.10.0", supported_commands: ["input"] },
      machine: {
        model: `${LETTABOX_STATUS_EMOJI} MacBook Pro`,
        osName: "macOS",
        cpu: "Apple M5 Pro",
        memoryBytes: 24 * 1024 ** 3,
      },
      fetchImpl: mockFetch,
    });

    const metadata = (capturedBody as { metadata?: Record<string, unknown> } | null)?.metadata;
    expect(metadata?.machine).toEqual({
      model: "📦 MacBook Pro",
      osName: "macOS",
      cpu: "Apple M5 Pro",
      memoryBytes: 24 * 1024 ** 3,
    });
  });
});
