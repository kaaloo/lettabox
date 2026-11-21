import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allocateEphemeralLoopbackPort } from "./microsandbox-provider.ts";

export interface ManagedControlPlaneOptions {
  lettaBin?: string;
  lettaApiKey: string;
  lettaServerUrl: string;
  allocatePort?: () => Promise<number>;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  onUnexpectedExit?: (exitCode: number) => void;
}

export interface RunningControlPlane {
  readonly port: number;
  readonly wsUrl: string;
  readonly httpUrl: string;
  stop(): Promise<void>;
}

export function resolveBundledLettaScript(): string | null {
  try {
    const resolved = import.meta.resolve("@letta-ai/letta-code");
    const scriptPath = resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved;
    return existsSync(scriptPath) ? scriptPath : null;
  } catch {
    return null;
  }
}

export function resolveLettaCommand(
  lettaBin?: string,
  options?: {
    resolveBundled?: () => string | null;
    execPath?: string;
  },
): string[] {
  const explicit = lettaBin?.trim();
  if (explicit) {
    return [explicit];
  }
  const bundledScript = (options?.resolveBundled ?? resolveBundledLettaScript)();
  if (bundledScript) {
    return [options?.execPath ?? process.execPath, bundledScript];
  }
  return ["letta"];
}

function drainStream(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): void {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) onChunk(text);
      }
    } catch {
      // Ignore stream close on shutdown
    }
  })();
}

export async function spawnManagedControlPlane(
  options: ManagedControlPlaneOptions,
): Promise<RunningControlPlane> {
  const lettaCommand = resolveLettaCommand(options.lettaBin);
  const allocatePort = options.allocatePort ?? allocateEphemeralLoopbackPort;
  const port = await allocatePort();
  const listenUrl = `ws://127.0.0.1:${port}`;

  const proc = Bun.spawn([...lettaCommand, "server", "--listen", listenUrl], {
    stdout: options.onStdout ? "pipe" : "ignore",
    stderr: options.onStderr ? "pipe" : "ignore",
    env: {
      ...process.env,
      LETTA_API_KEY: options.lettaApiKey,
      LETTA_SERVER_URL: options.lettaServerUrl,
    },
  });

  if (options.onStdout && proc.stdout) {
    drainStream(proc.stdout, options.onStdout);
  }
  if (options.onStderr && proc.stderr) {
    drainStream(proc.stderr, options.onStderr);
  }

  let stopped = false;

  void proc.exited.then((exitCode) => {
    if (!stopped) {
      stopped = true;
      options.onUnexpectedExit?.(exitCode);
    }
  });

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
