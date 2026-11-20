import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRuntime, Sandbox, type SandboxBuilder, SandboxNotFoundError } from "microsandbox";

export interface MsbRunSpec {
  name: string;
  image: string;
  hostPort: number;
  guestPort: number;
  cpus?: string;
  memory?: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  /** Inject the real credential at the host network boundary, never in the guest environment. */
  secret?: {
    envName: string;
    value: string;
    allowedHosts: string[];
    headers?: string[];
  };
  entrypoint?: string;
  command?: string[];
}

export interface MsbRunner {
  runSandbox(spec: MsbRunSpec): Promise<string>;
  removeSandbox(name: string): Promise<void>;
}

export interface SdkMsbRunnerOptions {
  msbBin?: string;
  msbHome?: string;
}

export function parseMsbMemoryMiB(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(?:([kmgKMG])(?:[bB])?)?$/);
  if (!match) {
    throw new Error(`Invalid microsandbox memory limit: ${value} (expected MiB, K, M, or G)`);
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  const mib = unit === "G" ? amount * 1024 : unit === "K" ? amount / 1024 : amount;
  if (!Number.isFinite(mib) || mib <= 0) {
    throw new Error(`Invalid microsandbox memory limit: ${value} (must be greater than zero)`);
  }
  return Math.ceil(mib);
}

export function parseMsbCpuCount(value: string): number {
  const cpus = Number(value.trim());
  if (!Number.isInteger(cpus) || cpus <= 0) {
    throw new Error(`Invalid microsandbox CPU limit: ${value} (expected a positive integer)`);
  }
  return cpus;
}

export function buildSdkSandbox(spec: MsbRunSpec): SandboxBuilder {
  const builder = Sandbox.builder(spec.name)
    .image(spec.image)
    .detached(true)
    .replace()
    .portBind("127.0.0.1", spec.hostPort, spec.guestPort)
    .labels(spec.labels)
    .envs(spec.env);

  if (spec.cpus && spec.cpus.trim().length > 0) {
    builder.cpus(parseMsbCpuCount(spec.cpus));
  }
  if (spec.memory && spec.memory.trim().length > 0) {
    builder.memory(parseMsbMemoryMiB(spec.memory));
  }

  const secret = spec.secret;
  if (secret && secret.allowedHosts.length > 0) {
    builder.secret((s) => {
      s.env(secret.envName).value(secret.value);
      for (const host of secret.allowedHosts) {
        s.allow(host);
      }
      if (secret.headers?.length) {
        s.substituteInHeaderFields(secret.headers);
      }
      return s;
    });
  }

  if (spec.entrypoint && spec.entrypoint.trim().length > 0) {
    builder.entrypoint([spec.entrypoint.trim()]);
  }
  if (spec.command && spec.command.length > 0) {
    builder.cmd(spec.command);
  }

  return builder;
}

export class SdkMsbRunner implements MsbRunner {
  constructor(options: SdkMsbRunnerOptions = {}) {
    process.env.MSB_HOME =
      options.msbHome?.trim() ||
      process.env.MSB_HOME ||
      join(homedir(), ".lettabox", "microsandbox");
    if (options.msbBin?.trim()) {
      process.env.MSB_PATH = options.msbBin.trim();
    }

    // Fail at startup for missing/incomplete runtimes instead of on the first conversation.
    resolveRuntime();
  }

  async runSandbox(spec: MsbRunSpec): Promise<string> {
    const sandbox = await buildSdkSandbox(spec).create();
    await sandbox.detach();
    return sandbox.name;
  }

  async removeSandbox(name: string): Promise<void> {
    try {
      const handle = await Sandbox.get(name);
      await handle.destroy({ force: true });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      throw error;
    }
  }
}
