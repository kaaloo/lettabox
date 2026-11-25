import { dlopen, FFIType } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CloudHttpError,
  Image,
  ImageNotFoundError,
  InvalidConfigError,
  installRuntime,
  LocalContext,
  RemoteContext,
  type ResolvedRuntime,
  resolveRuntime,
  resolveRuntimeVersion,
  Sandbox,
  SandboxAlreadyExistsError,
  type SandboxBuilder,
  SandboxNotFoundError,
  Service,
  ServiceNotFoundError,
} from "microsandbox";
import pkg from "../package.json";
import type { MsbComputeType, SandboxBackend } from "./config.ts";
import { ensureGhBinaryCached, GH_GUEST_BIN_PATH } from "./gh-binary.ts";

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
 * so `microsandbox`'s native addon sees `MSB_HOME`, `MSB_PATH`, `MSB_LIBKRUNFW_PATH`,
 * and cloud backend settings (`MSB_BACKEND`, `MSB_API_KEY`, `MSB_API_URL`, `MSB_PROFILE`).
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

export interface MsbRootfsPatch {
  kind: "copyFile";
  src: string;
  dst: string;
  mode?: number;
  replace?: boolean;
}

export interface MsbRunSpec {
  name: string;
  image: string;
  backend?: SandboxBackend;
  hostPort?: number;
  guestPort: number;
  ephemeral?: boolean;
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
  patches?: MsbRootfsPatch[];
}

export interface MsbRunResult {
  name: string;
  httpUrl: string;
  wsUrl: string;
  hostPort?: number;
  serviceSlug?: string;
  serviceUrl?: string;
}

export interface MsbRunner {
  ensureReady?(image?: string): Promise<void>;
  runSandbox(spec: MsbRunSpec): Promise<MsbRunResult>;
  removeSandbox(name: string): Promise<void>;
  readSandboxLogs?(name: string): Promise<string | undefined>;
}

export interface SdkRuntimeOps {
  resolveRuntime: typeof resolveRuntime;
  resolveRuntimeVersion: typeof resolveRuntimeVersion;
  installRuntime: typeof installRuntime;
}

export interface SdkImageOps {
  isCached: (reference: string) => Promise<boolean>;
  pull: (
    msbPath: string,
    reference: string,
    env: Record<string, string | undefined>,
  ) => Promise<void>;
}

export interface SdkExecOutput {
  readonly code: number;
  readonly success: boolean;
  stdout(): string;
  stderr(): string;
}

export interface SdkSandboxInstance {
  readonly name: string;
  exec(cmd: string, args?: Iterable<string>): Promise<SdkExecOutput>;
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
  exec?(cmd: string, args?: Iterable<string>): Promise<SdkExecOutput>;
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

export interface SdkServiceInstance {
  readonly slug: string;
  readonly url: string;
  remove(): Promise<void>;
}

export interface SdkServiceOps {
  create: (slug: string, sandboxName: string, guestPort: number) => Promise<SdkServiceInstance>;
  get: (slug: string) => Promise<SdkServiceInstance>;
}

export interface SdkGhBinaryOps {
  ensureBinary: (msbHome: string) => Promise<string>;
}

export interface SdkMsbRunnerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SdkMsbRunnerOptions {
  backend?: SandboxBackend;
  msbBin?: string;
  msbHome?: string;
  msbApiKey?: string;
  msbApiUrl?: string;
  msbProfile?: string;
  msbComputeType?: MsbComputeType;
  image?: string;
  expectedVersion?: string;
  env?: Record<string, string | undefined>;
  runtimeOps?: SdkRuntimeOps;
  imageOps?: SdkImageOps;
  ghBinaryOps?: SdkGhBinaryOps;
  sandboxOps?: SdkSandboxOps;
  serviceOps?: SdkServiceOps;
  makeServiceSlug?: () => string;
  logger?: SdkMsbRunnerLogger;
}

export const CLOUD_SERVER_LOG_PATH = "/tmp/letta-server.log";

export function buildCloudDetachedLaunch(launch: { cmd: string; args: string[] }): {
  cmd: string;
  args: string[];
} {
  // Microsandbox Cloud rejects execDetached (managed background jobs are local-only).
  // Start the server in a new session with redirected stdio via positional parameters
  // so exec() returns immediately without shell-escaping hazards.
  const wrapper = `if command -v setsid >/dev/null 2>&1; then setsid "$@" </dev/null >${CLOUD_SERVER_LOG_PATH} 2>&1 & else nohup "$@" </dev/null >${CLOUD_SERVER_LOG_PATH} 2>&1 & fi`;
  return {
    cmd: "/bin/sh",
    args: ["-c", wrapper, "lettabox-launch", launch.cmd, ...launch.args],
  };
}

export function makeMsbServiceSlug(): string {
  return `lb-${randomBytes(8).toString("hex")}`;
}

export function serviceUrlToEndpoints(serviceUrl: string): { httpUrl: string; wsUrl: string } {
  const url = new URL(serviceUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported Microsandbox Service URL protocol: ${url.protocol}`);
  }
  url.search = "";
  url.hash = "";
  const httpUrl = url.toString().replace(/\/+$/, "");
  const wsBase =
    url.protocol === "https:"
      ? httpUrl.replace(/^https:/, "wss:")
      : httpUrl.replace(/^http:/, "ws:");
  return {
    httpUrl,
    wsUrl: `${wsBase}/ws`,
  };
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

export function buildSdkSandbox(
  spec: MsbRunSpec,
  builderFactory: (name: string) => SandboxBuilder = (name) => Sandbox.builder(name),
): SandboxBuilder {
  const isCloud = spec.backend === "cloud";
  const builder = builderFactory(spec.name).image(spec.image).detached(true);

  if (isCloud) {
    builder.ephemeral(spec.ephemeral ?? true);
  } else {
    builder.replace();
    if (spec.hostPort !== undefined) {
      builder.portBind("127.0.0.1", spec.hostPort, spec.guestPort);
    }
  }

  builder.labels(spec.labels).envs(spec.env);

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

  if (!isCloud) {
    if (spec.entrypoint && spec.entrypoint.trim().length > 0) {
      builder.entrypoint([spec.entrypoint.trim()]);
    }
    if (spec.command && spec.command.length > 0) {
      builder.cmd(spec.command);
    }
  }
  if (spec.patches && spec.patches.length > 0) {
    const patches = spec.patches;
    builder.patch((patch) => {
      for (const entry of patches) {
        if (entry.kind === "copyFile") {
          patch.copyFile(entry.src, entry.dst, {
            mode: entry.mode,
            replace: entry.replace,
          });
        }
      }
      return patch;
    });
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

function isLocalImagePath(reference: string): boolean {
  return reference.startsWith("/") || reference.startsWith("./") || reference.startsWith("../");
}

const defaultSdkImageOps: SdkImageOps = {
  async isCached(reference: string): Promise<boolean> {
    if (isLocalImagePath(reference)) return true;
    try {
      await Image.get(reference);
      return true;
    } catch (error) {
      if (error instanceof ImageNotFoundError) return false;
      throw error;
    }
  },
  async pull(
    msbPath: string,
    reference: string,
    env: Record<string, string | undefined>,
  ): Promise<void> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
    const proc = Bun.spawn([msbPath, "pull", "--quiet", reference], {
      env: cleanEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const detail = (stderr || stdout).trim();
      throw new Error(
        `Failed to pull microsandbox image ${reference} (exit ${exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }
  },
};

export class SdkMsbRunner implements MsbRunner {
  private readonly backend: SandboxBackend;
  private readonly msbHome: string;
  private readonly explicitMsbBin?: string;
  private readonly msbApiKey?: string;
  private readonly msbApiUrl?: string;
  private readonly msbProfile?: string;
  private readonly msbComputeType?: MsbComputeType;
  private readonly defaultImage?: string;
  private readonly expectedVersion: string;
  private readonly env: Record<string, string | undefined>;
  private readonly mirrorToNativeEnv: boolean;
  private readonly runtimeOps: SdkRuntimeOps;
  private readonly imageOps: SdkImageOps;
  private readonly ghBinaryOps: SdkGhBinaryOps;
  private readonly sandboxOps: SdkSandboxOps;
  private readonly serviceOps: SdkServiceOps;
  private readonly makeServiceSlug: () => string;
  private readonly hasCustomSandboxOps: boolean;
  private readonly logger?: SdkMsbRunnerLogger;
  private readyPromise: Promise<ResolvedRuntime> | null = null;
  private ghBinaryPromise: Promise<string> | null = null;
  private remoteContext: RemoteContext | null = null;
  private cloudReady = false;
  private readonly readyImages = new Map<string, Promise<void>>();
  private readonly sandboxServices = new Map<string, string>();

  constructor(options: SdkMsbRunnerOptions = {}) {
    this.mirrorToNativeEnv = options.env === undefined;
    this.env = options.env ?? process.env;
    this.backend = options.backend ?? "local";
    this.msbHome =
      options.msbHome?.trim() ||
      this.env.MSB_HOME?.trim() ||
      join(homedir(), ".lettabox", "microsandbox");
    this.explicitMsbBin = options.msbBin?.trim() || this.env.MSB_PATH?.trim() || undefined;
    this.msbApiKey = options.msbApiKey?.trim() || this.env.MSB_API_KEY?.trim() || undefined;
    this.msbApiUrl = options.msbApiUrl?.trim() || this.env.MSB_API_URL?.trim() || undefined;
    this.msbProfile = options.msbProfile?.trim() || this.env.MSB_PROFILE?.trim() || undefined;
    this.msbComputeType = options.msbComputeType;
    this.defaultImage = options.image?.trim() || undefined;
    this.expectedVersion = options.expectedVersion ?? EXPECTED_MSB_RUNTIME_VERSION;
    this.runtimeOps = options.runtimeOps ?? {
      resolveRuntime,
      resolveRuntimeVersion,
      installRuntime,
    };
    this.imageOps = options.imageOps ?? defaultSdkImageOps;
    this.ghBinaryOps = options.ghBinaryOps ?? {
      ensureBinary: (msbHome) => ensureGhBinaryCached({ msbHome, logger: options.logger }),
    };
    this.hasCustomSandboxOps = options.sandboxOps !== undefined;
    this.sandboxOps = options.sandboxOps ?? {
      create: (spec) => {
        if (this.backend === "cloud") {
          const ctx = this.getOrCreateRemoteContext();
          return buildSdkSandbox(spec, (name) => ctx.sandboxes.builder(name)).create();
        }
        const ctx = new LocalContext({ home: this.msbHome });
        return buildSdkSandbox(spec, (name) => ctx.sandboxes.builder(name)).create();
      },
      get: (name) => {
        if (this.backend === "cloud") {
          return this.getOrCreateRemoteContext().sandboxes.get(name);
        }
        return new LocalContext({ home: this.msbHome }).sandboxes.get(name);
      },
    };
    this.serviceOps = options.serviceOps ?? {
      create: (slug, sandboxName, guestPort) =>
        Service.builder(slug).target(sandboxName, guestPort).create(),
      get: (slug) => Service.get(slug),
    };
    this.makeServiceSlug = options.makeServiceSlug ?? makeMsbServiceSlug;
    this.logger = options.logger;
  }

  async ensureReady(image?: string): Promise<void> {
    if (this.backend === "cloud") {
      this.ensureCloudReady();
      return;
    }
    const resolved = await this.ensureRuntimeReady();
    const targetImage = image?.trim() || this.defaultImage;
    if (targetImage) {
      await Promise.all([
        this.ensureImageCached(resolved, targetImage),
        this.ensureGhBinaryReady(),
      ]);
    }
  }

  async runSandbox(spec: MsbRunSpec): Promise<MsbRunResult> {
    if (this.backend === "cloud") {
      return this.runCloudSandbox(spec);
    }

    await this.ensureReady(spec.image);
    const ghBinaryPath = await this.ensureGhBinaryReady();
    const hasExplicitGhPatch = spec.patches?.some((patch) => patch.dst === GH_GUEST_BIN_PATH);
    const effectiveSpec: MsbRunSpec = hasExplicitGhPatch
      ? { ...spec, backend: "local" }
      : {
          ...spec,
          backend: "local",
          patches: [
            {
              kind: "copyFile",
              src: ghBinaryPath,
              dst: GH_GUEST_BIN_PATH,
              mode: 0o755,
              replace: true,
            },
            ...(spec.patches ?? []),
          ],
        };
    const sandbox = await this.sandboxOps.create(effectiveSpec);
    const launch = resolveMsbLaunchCommand(effectiveSpec);
    try {
      if (launch) {
        // Microsandbox SDK's Sandbox.builder(...).create() only boots the microVM
        // and records entrypoint/cmd metadata without executing them. Launch the
        // server command as a detached guest job before detaching from the handle.
        await sandbox.execDetached(launch.cmd, launch.args);
      }
      await sandbox.detach();
      const hostPort = effectiveSpec.hostPort;
      if (hostPort === undefined) {
        throw new Error(`Local microsandbox ${sandbox.name} requires hostPort`);
      }
      return {
        name: sandbox.name,
        httpUrl: `http://127.0.0.1:${hostPort}`,
        wsUrl: `ws://127.0.0.1:${hostPort}/ws`,
        hostPort,
      };
    } catch (error) {
      await sandbox.destroy({ force: true }).catch(() => {});
      throw error;
    }
  }

  private async runCloudSandbox(spec: MsbRunSpec): Promise<MsbRunResult> {
    this.ensureCloudReady();
    const effectiveSpec: MsbRunSpec = {
      ...spec,
      backend: "cloud",
      hostPort: undefined,
      ephemeral: spec.ephemeral ?? true,
    };
    const tCreateStart = Date.now();
    let sandbox: SdkSandboxInstance;
    try {
      sandbox = await this.sandboxOps.create(effectiveSpec);
    } catch (error) {
      // If create() failed after the cloud API accepted the sandbox (e.g. readiness
      // wait expired while the sandbox remained starting), attempt best-effort cleanup
      // by name so it does not stay orphaned and consume the concurrency quota.
      const definitelyNotCreated =
        error instanceof CloudHttpError ||
        error instanceof InvalidConfigError ||
        error instanceof SandboxNotFoundError ||
        error instanceof SandboxAlreadyExistsError;
      if (!definitelyNotCreated) {
        await this.sandboxOps
          .get(effectiveSpec.name)
          .then((handle) => handle.destroy())
          .catch(() => {});
      }
      throw error;
    }
    this.logger?.info(
      `Cloud microsandbox ${sandbox.name} created (${Date.now() - tCreateStart}ms), launching guest server...`,
    );
    const launch = resolveMsbLaunchCommand(effectiveSpec);
    let createdService: SdkServiceInstance | null = null;
    try {
      if (launch) {
        const detached = buildCloudDetachedLaunch(launch);
        const output = await sandbox.exec(detached.cmd, detached.args);
        if (!output.success) {
          const detail = (output.stderr() || output.stdout()).trim();
          throw new Error(
            `Failed to launch guest server in cloud microsandbox ${sandbox.name} (exit ${output.code})${detail ? `: ${detail}` : ""}`,
          );
        }
      }
      await sandbox.detach();

      const slug = this.makeServiceSlug();
      createdService = await this.serviceOps.create(slug, sandbox.name, effectiveSpec.guestPort);
      this.sandboxServices.set(sandbox.name, createdService.slug);
      this.logger?.info(
        `Cloud microsandbox ${sandbox.name} service ready at ${createdService.url} (slug=${createdService.slug})`,
      );

      const { httpUrl, wsUrl } = serviceUrlToEndpoints(createdService.url);
      return {
        name: sandbox.name,
        httpUrl,
        wsUrl,
        serviceSlug: createdService.slug,
        serviceUrl: createdService.url,
      };
    } catch (error) {
      this.sandboxServices.delete(sandbox.name);
      if (createdService) {
        await createdService.remove().catch(() => {});
      }
      await sandbox.destroy().catch(() => {});
      throw error;
    }
  }

  async removeSandbox(name: string): Promise<void> {
    if (this.backend === "cloud") {
      await this.removeCloudSandbox(name);
      return;
    }
    await this.ensureRuntimeReady();
    try {
      const handle = await this.sandboxOps.get(name);
      await handle.destroy({ force: true });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      throw error;
    }
  }

  private async removeCloudSandbox(name: string): Promise<void> {
    this.ensureCloudReady();
    const slug = this.sandboxServices.get(name);
    this.sandboxServices.delete(name);

    const errors: unknown[] = [];

    if (slug) {
      try {
        const svc = await this.serviceOps.get(slug);
        await svc.remove();
      } catch (error) {
        if (!(error instanceof ServiceNotFoundError)) {
          errors.push(error);
        }
      }
    }

    try {
      const handle = await this.sandboxOps.get(name);
      await handle.destroy();
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw errors[0];
    }
  }

  async readSandboxLogs(name: string): Promise<string | undefined> {
    if (this.backend === "cloud") {
      this.ensureCloudReady();
    } else {
      await this.ensureRuntimeReady();
    }
    try {
      const handle = await this.sandboxOps.get(name);
      const parts: string[] = [];

      if (this.backend === "cloud" && handle.exec) {
        try {
          const out = await handle.exec("tail", ["-n", "40", CLOUD_SERVER_LOG_PATH]);
          const text = (out.stdout() || out.stderr()).trim();
          if (text) parts.push(text);
        } catch {
          // ignore cloud guest log read failures
        }
      } else {
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
      }

      const combined = parts.join("\n").trim();
      if (!combined) return undefined;
      return combined.length > 2_000 ? `${combined.slice(0, 2_000)}...` : combined;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return undefined;
      return undefined;
    }
  }

  private ensureCloudReady(): void {
    if (!this.msbApiKey && !this.msbProfile) {
      throw new Error(
        "Microsandbox cloud backend requires MSB_API_KEY (or MSB_PROFILE); refusing to fall back to local",
      );
    }

    // Mirror cloud backend env vars into native C environ so Service.* static methods
    // (which read ambient backend env rather than taking a RemoteContext) target the
    // same cloud endpoint and credentials.
    this.setEnvVar("MSB_BACKEND", "remote");
    if (this.msbProfile) {
      this.setEnvVar("MSB_PROFILE", this.msbProfile);
    }
    if (this.msbApiKey) {
      this.setEnvVar("MSB_API_KEY", this.msbApiKey);
    }
    if (this.msbApiUrl) {
      this.setEnvVar("MSB_API_URL", this.msbApiUrl);
    }

    if (!this.hasCustomSandboxOps) {
      this.getOrCreateRemoteContext();
    }

    if (!this.cloudReady) {
      this.cloudReady = true;
      const target = this.msbProfile
        ? `profile=${this.msbProfile}`
        : `url=${this.msbApiUrl ?? "https://api.microsandbox.dev"}`;
      const compute = this.msbComputeType ? `, computeType=${this.msbComputeType}` : "";
      this.logger?.info(`Microsandbox cloud backend ready (${target}${compute})`);
    }
  }

  private getOrCreateRemoteContext(): RemoteContext {
    if (this.remoteContext) {
      return this.remoteContext;
    }

    let ctx: RemoteContext;
    if (this.msbProfile) {
      const base = RemoteContext.fromProfile(this.msbProfile);
      if (this.msbApiKey || this.msbApiUrl || this.msbComputeType) {
        const derived = base.toBuilder();
        if (this.msbApiKey) derived.apiKey(this.msbApiKey);
        if (this.msbApiUrl) derived.url(this.msbApiUrl);
        if (this.msbComputeType) derived.computeType(this.msbComputeType);
        ctx = derived.build();
      } else {
        ctx = base;
      }
    } else {
      if (!this.msbApiKey) {
        throw new Error(
          "Microsandbox cloud backend requires MSB_API_KEY (or MSB_PROFILE); refusing to fall back to local",
        );
      }
      const builder = RemoteContext.builder().apiKey(this.msbApiKey);
      if (this.msbApiUrl) builder.url(this.msbApiUrl);
      if (this.msbComputeType) builder.computeType(this.msbComputeType);
      ctx = builder.build();
    }

    this.remoteContext = ctx;
    return ctx;
  }

  private async ensureRuntimeReady(): Promise<ResolvedRuntime> {
    if (!this.readyPromise) {
      this.readyPromise = this.resolveOrInstallMatchingRuntime().catch((err) => {
        this.readyPromise = null;
        throw err;
      });
    }
    return this.readyPromise;
  }

  private async ensureGhBinaryReady(): Promise<string> {
    if (!this.ghBinaryPromise) {
      this.ghBinaryPromise = this.ghBinaryOps.ensureBinary(this.msbHome).catch((err) => {
        this.ghBinaryPromise = null;
        throw err;
      });
    }
    return this.ghBinaryPromise;
  }

  private async ensureImageCached(resolved: ResolvedRuntime, reference: string): Promise<void> {
    let pending = this.readyImages.get(reference);
    if (!pending) {
      pending = (async () => {
        const cached = await this.imageOps.isCached(reference);
        if (cached) {
          this.logger?.info(`Microsandbox image ${reference} cached`);
          return;
        }
        this.logger?.info(
          `Pulling microsandbox image ${reference} into ${this.msbHome} (first run may take a minute)...`,
        );
        await this.imageOps.pull(resolved.msbPath, reference, {
          ...this.env,
          MSB_BACKEND: "local",
          MSB_HOME: this.msbHome,
          MSB_PATH: resolved.msbPath,
          MSB_LIBKRUNFW_PATH: resolved.libkrunfwPath,
        });
        this.logger?.info(`Microsandbox image ${reference} ready`);
      })().catch((err) => {
        this.readyImages.delete(reference);
        throw err;
      });
      this.readyImages.set(reference, pending);
    }
    await pending;
  }

  private setEnvVar(key: string, value: string): void {
    if (this.mirrorToNativeEnv) {
      setNativeProcessEnv(key, value);
    } else {
      this.env[key] = value;
    }
  }

  private pinRuntimeEnv(resolved: ResolvedRuntime): void {
    this.setEnvVar("MSB_BACKEND", "local");
    this.setEnvVar("MSB_HOME", this.msbHome);
    this.setEnvVar("MSB_PATH", resolved.msbPath);
    this.setEnvVar("MSB_LIBKRUNFW_PATH", resolved.libkrunfwPath);
  }

  private async resolveOrInstallMatchingRuntime(): Promise<ResolvedRuntime> {
    this.setEnvVar("MSB_BACKEND", "local");
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
