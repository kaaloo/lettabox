import { dlopen, FFIType } from "bun:ffi";
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

interface NativeEnvLib {
  setenv: (name: Buffer, value: Buffer, overwrite: number) => number;
  unsetenv: (name: Buffer) => number;
}

let cachedNativeEnvLib: NativeEnvLib | null | undefined;

function getNativeEnvLib(): NativeEnvLib | null {
  if (cachedNativeEnvLib !== undefined) return cachedNativeEnvLib;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    cachedNativeEnvLib = null;
    return null;
  }
  try {
    const libName = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
    const lib = dlopen(libName, {
      setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
    });
    cachedNativeEnvLib = {
      setenv: (name, value, overwrite) => lib.symbols.setenv(name, value, overwrite),
      unsetenv: (name) => lib.symbols.unsetenv(name),
    };
  } catch {
    cachedNativeEnvLib = null;
  }
  return cachedNativeEnvLib;
}

/**
 * Bun's `process.env` mutations do not propagate to the native C `environ` read by
 * Rust N-API addons (`std::env::var`). Mirror runtime env updates via libc `setenv`
 * so `microsandbox`'s native addon sees `MSB_HOME`, `MSB_PATH`, and `MSB_LIBKRUNFW_PATH`.
 */
export function setNativeProcessEnv(key: string, value: string): void {
  process.env[key] = value;
  const lib = getNativeEnvLib();
  if (lib) {
    lib.setenv(Buffer.from(`${key}\0`), Buffer.from(`${value}\0`), 1);
  }
}

export function unsetNativeProcessEnv(key: string): void {
  delete process.env[key];
  const lib = getNativeEnvLib();
  if (lib) {
    lib.unsetenv(Buffer.from(`${key}\0`));
  }
}

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
  readSandboxLogs?(name: string): Promise<string | undefined>;
}

export interface SdkRuntimeOps {
  resolveRuntime: typeof resolveRuntime;
  resolveRuntimeVersion: typeof resolveRuntimeVersion;
  installRuntime: typeof installRuntime;
}

export interface SdkSandboxInstance {
  readonly name: string;
  execDetached(cmd: string, args?: Iterable<string>): Promise<{ id: string }>;
  detach(): Promise<void>;
  destroy(options?: { force?: boolean }): Promise<void>;
}

export interface SdkSandboxJobListBuilder {
  all(value?: boolean): this;
  limit(value: number): this;
}

export interface SdkSandboxHandle {
  destroy(options?: { force?: boolean }): Promise<void>;
  listJobsWith(configure: (b: SdkSandboxJobListBuilder) => SdkSandboxJobListBuilder): Promise<{
    items: ReadonlyArray<{
      id: string;
      state: string;
      exitCode: number | null;
      error: string | null;
    }>;
  }>;
  getJob(id: string): Promise<{
    logs(options?: { tail?: number }): Promise<ReadonlyArray<{ source: string; data: Buffer }>>;
  }>;
  logs(options?: {
    tail?: number;
    sources?: ReadonlyArray<"stdout" | "stderr" | "output" | "system" | "all">;
  }): Promise<ReadonlyArray<{ source: string; text(): string }>>;
}

export interface SdkSandboxOps {
  create: (spec: MsbRunSpec) => Promise<SdkSandboxInstance>;
  get: (name: string) => Promise<SdkSandboxHandle>;
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
  sandboxOps?: SdkSandboxOps;
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

export function resolveMsbLaunchCommand(spec: MsbRunSpec): { cmd: string; args: string[] } | null {
  const entrypoint = spec.entrypoint?.trim();
  if (entrypoint) {
    return { cmd: entrypoint, args: spec.command ? [...spec.command] : [] };
  }
  if (spec.command && spec.command.length > 0) {
    const [cmd, ...args] = spec.command;
    if (cmd && cmd.trim().length > 0) {
      return { cmd, args };
    }
  }
  return null;
}

export class SdkMsbRunner implements MsbRunner {
  private readonly msbHome: string;
  private readonly explicitMsbBin?: string;
  private readonly expectedVersion: string;
  private readonly env: Record<string, string | undefined>;
  private readonly mirrorToNativeEnv: boolean;
  private readonly runtimeOps: SdkRuntimeOps;
  private readonly sandboxOps: SdkSandboxOps;
  private readonly logger?: SdkMsbRunnerLogger;
  private readyPromise: Promise<ResolvedRuntime> | null = null;

  constructor(options: SdkMsbRunnerOptions = {}) {
    this.mirrorToNativeEnv = options.env === undefined;
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
    this.sandboxOps = options.sandboxOps ?? {
      create: (spec) => buildSdkSandbox(spec).create(),
      get: (name) => Sandbox.get(name),
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
    const sandbox = await this.sandboxOps.create(spec);
    const launch = resolveMsbLaunchCommand(spec);
    try {
      if (launch) {
        // Microsandbox SDK's Sandbox.builder(...).create() only boots the microVM
        // and records entrypoint/cmd metadata without executing them. Launch the
        // server command as a detached guest job before detaching from the handle.
        await sandbox.execDetached(launch.cmd, launch.args);
      }
      await sandbox.detach();
      return sandbox.name;
    } catch (error) {
      await sandbox.destroy({ force: true }).catch(() => {});
      throw error;
    }
  }

  async removeSandbox(name: string): Promise<void> {
    await this.ensureReady();
    try {
      const handle = await this.sandboxOps.get(name);
      await handle.destroy({ force: true });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      throw error;
    }
  }

  async readSandboxLogs(name: string): Promise<string | undefined> {
    await this.ensureReady();
    try {
      const handle = await this.sandboxOps.get(name);
      const parts: string[] = [];

      try {
        const jobs = await handle.listJobsWith((b) => b.all(true).limit(5));
        for (const info of jobs.items) {
          const statusParts = [`job=${info.id}`, `state=${info.state}`];
          if (info.exitCode !== null) statusParts.push(`exitCode=${info.exitCode}`);
          if (info.error) statusParts.push(`error=${info.error}`);
          parts.push(`[${statusParts.join(" ")}]`);
          try {
            const job = await handle.getJob(info.id);
            const entries = await job.logs({ tail: 40 });
            const text = entries
              .map((entry) => entry.data.toString("utf8"))
              .join("")
              .trim();
            if (text) parts.push(text);
          } catch {
            // ignore individual job log read failures
          }
        }
      } catch {
        // fall through to sandbox-level logs
      }

      if (parts.length === 0) {
        try {
          const entries = await handle.logs({ tail: 40, sources: ["all"] });
          const text = entries
            .map((entry) => entry.text())
            .join("")
            .trim();
          if (text) parts.push(text);
        } catch {
          // ignore
        }
      }

      const combined = parts.join("\n").trim();
      if (!combined) return undefined;
      return combined.length > 2_000 ? `${combined.slice(0, 2_000)}...` : combined;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return undefined;
      return undefined;
    }
  }

  private setEnvVar(key: string, value: string): void {
    if (this.mirrorToNativeEnv) {
      setNativeProcessEnv(key, value);
    } else {
      this.env[key] = value;
    }
  }

  private pinRuntimeEnv(resolved: ResolvedRuntime): void {
    this.setEnvVar("MSB_HOME", this.msbHome);
    this.setEnvVar("MSB_PATH", resolved.msbPath);
    this.setEnvVar("MSB_LIBKRUNFW_PATH", resolved.libkrunfwPath);
  }

  private async resolveOrInstallMatchingRuntime(): Promise<ResolvedRuntime> {
    this.setEnvVar("MSB_HOME", this.msbHome);

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
      this.logger?.info(
        `Microsandbox runtime ${this.expectedVersion} ready (${resolved.origin}: ${resolved.msbPath})`,
      );
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
        this.logger?.info(
          `Microsandbox runtime ${this.expectedVersion} ready (${existing.origin}: ${existing.msbPath})`,
        );
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
    this.logger?.info(
      `Microsandbox runtime ${this.expectedVersion} ready (${installed.origin}: ${installed.msbPath})`,
    );
    return installed;
  }
}
