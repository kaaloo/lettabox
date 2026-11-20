import { homedir } from "node:os";
import { join } from "node:path";
import {
  installRuntime,
  type ResolvedRuntime,
  resolveRuntime,
  resolveRuntimeVersion,
  Sandbox,
  type SandboxBuilder,
  SandboxNotFoundError,
} from "microsandbox";
import pkg from "../package.json";

export const EXPECTED_MSB_RUNTIME_VERSION: string = pkg.dependencies.microsandbox.replace(
  /^[~^]/,
  "",
);

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
  ensureReady?(): Promise<void>;
  runSandbox(spec: MsbRunSpec): Promise<string>;
  removeSandbox(name: string): Promise<void>;
}

export interface SdkRuntimeOps {
  resolveRuntime: typeof resolveRuntime;
  resolveRuntimeVersion: typeof resolveRuntimeVersion;
  installRuntime: typeof installRuntime;
}

export interface SdkMsbRunnerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SdkMsbRunnerOptions {
  msbBin?: string;
  msbHome?: string;
  expectedVersion?: string;
  env?: Record<string, string | undefined>;
  runtimeOps?: SdkRuntimeOps;
  logger?: SdkMsbRunnerLogger;
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
  private readonly msbHome: string;
  private readonly explicitMsbBin?: string;
  private readonly expectedVersion: string;
  private readonly env: Record<string, string | undefined>;
  private readonly runtimeOps: SdkRuntimeOps;
  private readonly logger?: SdkMsbRunnerLogger;
  private readyPromise: Promise<ResolvedRuntime> | null = null;

  constructor(options: SdkMsbRunnerOptions = {}) {
    this.env = options.env ?? process.env;
    this.msbHome =
      options.msbHome?.trim() ||
      this.env.MSB_HOME?.trim() ||
      join(homedir(), ".lettabox", "microsandbox");
    this.explicitMsbBin = options.msbBin?.trim() || this.env.MSB_PATH?.trim() || undefined;
    this.expectedVersion = options.expectedVersion ?? EXPECTED_MSB_RUNTIME_VERSION;
    this.runtimeOps = options.runtimeOps ?? {
      resolveRuntime,
      resolveRuntimeVersion,
      installRuntime,
    };
    this.logger = options.logger;
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.resolveOrInstallMatchingRuntime().catch((err) => {
        this.readyPromise = null;
        throw err;
      });
    }
    await this.readyPromise;
  }

  async runSandbox(spec: MsbRunSpec): Promise<string> {
    await this.ensureReady();
    const sandbox = await buildSdkSandbox(spec).create();
    await sandbox.detach();
    return sandbox.name;
  }

  async removeSandbox(name: string): Promise<void> {
    await this.ensureReady();
    try {
      const handle = await Sandbox.get(name);
      await handle.destroy({ force: true });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      throw error;
    }
  }

  private pinRuntimeEnv(resolved: ResolvedRuntime): void {
    this.env.MSB_HOME = this.msbHome;
    this.env.MSB_PATH = resolved.msbPath;
    this.env.MSB_LIBKRUNFW_PATH = resolved.libkrunfwPath;
  }

  private async resolveOrInstallMatchingRuntime(): Promise<ResolvedRuntime> {
    this.env.MSB_HOME = this.msbHome;

    if (this.explicitMsbBin) {
      const resolved = this.runtimeOps.resolveRuntime({
        home: this.msbHome,
        msbPath: this.explicitMsbBin,
      });
      const version = await this.runtimeOps.resolveRuntimeVersion(resolved.msbPath);
      if (version !== this.expectedVersion) {
        throw new Error(
          `Microsandbox runtime at ${resolved.msbPath} is version ${version ?? "unknown"}, but lettabox requires ${this.expectedVersion} (matching microsandbox SDK ${this.expectedVersion}). Unset MSB_PATH to let lettabox install its own matching runtime under ${this.msbHome}.`,
        );
      }
      this.pinRuntimeEnv(resolved);
      return resolved;
    }

    let existing: ResolvedRuntime | null = null;
    try {
      existing = this.runtimeOps.resolveRuntime({ home: this.msbHome });
    } catch {
      existing = null;
    }

    if (existing) {
      const version = await this.runtimeOps.resolveRuntimeVersion(existing.msbPath);
      if (version === this.expectedVersion) {
        this.pinRuntimeEnv(existing);
        return existing;
      }
      this.logger?.warn(
        `Resolved msb runtime ${version ?? "unknown"} at ${existing.msbPath} does not match SDK ${this.expectedVersion}; installing matching runtime into ${this.msbHome}...`,
      );
    } else {
      this.logger?.info(
        `Installing matching microsandbox runtime ${this.expectedVersion} into ${this.msbHome}...`,
      );
    }

    const installed = await this.runtimeOps.installRuntime(
      { home: this.msbHome },
      { version: this.expectedVersion, force: true },
    );
    const installedVersion = await this.runtimeOps.resolveRuntimeVersion(installed.msbPath);
    if (installedVersion !== this.expectedVersion) {
      throw new Error(
        `Installed microsandbox runtime at ${installed.msbPath} reported version ${installedVersion ?? "unknown"}, expected ${this.expectedVersion}`,
      );
    }
    this.pinRuntimeEnv(installed);
    this.logger?.info(`Microsandbox runtime ${this.expectedVersion} ready at ${installed.msbPath}`);
    return installed;
  }
}
