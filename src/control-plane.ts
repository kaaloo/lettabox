import { allocateEphemeralLoopbackPort } from "./microsandbox-provider.ts";

export interface ManagedControlPlaneOptions {
  lettaBin?: string;
  lettaApiKey: string;
  lettaServerUrl: string;
  allocatePort?: () => Promise<number>;
  onStderr?: (line: string) => void;
}

export interface RunningControlPlane {
  readonly port: number;
  readonly wsUrl: string;
  readonly httpUrl: string;
  stop(): Promise<void>;
}

export async function spawnManagedControlPlane(
  options: ManagedControlPlaneOptions,
): Promise<RunningControlPlane> {
  const lettaBin = options.lettaBin?.trim() || "letta";
  const allocatePort = options.allocatePort ?? allocateEphemeralLoopbackPort;
  const port = await allocatePort();
  const listenUrl = `ws://127.0.0.1:${port}`;

  const proc = Bun.spawn([lettaBin, "server", "--listen", listenUrl], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LETTA_API_KEY: options.lettaApiKey,
      LETTA_SERVER_URL: options.lettaServerUrl,
    },
  });

  if (options.onStderr && proc.stderr) {
    void (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true }).trim();
          if (text) options.onStderr?.(text);
        }
      } catch {
        // Ignore stream close on shutdown
      }
    })();
  }

  let stopped = false;

  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited
      }
      const exited = Promise.race([proc.exited, Bun.sleep(3_000)]);
      await exited;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited
      }
    },
  };
}
