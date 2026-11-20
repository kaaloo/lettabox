export interface MsbRunSpec {
  name: string;
  image: string;
  hostPort: number;
  guestPort: number;
  cpus?: string;
  memory?: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  /**
   * When set, uses microsandbox host-side secret injection (`--secret NAME:headers=[Authorization]@HOST,...`)
   * so the real credential stays on the host and never enters the microVM environment.
   */
  secret?: {
    envName: string;
    value: string;
    allowedHosts: string[];
    headers?: string[];
  };
  /** Optional entrypoint executable override (`--entrypoint`). */
  entrypoint?: string;
  /** Optional command override appended after `--`. */
  command?: string[];
}

export interface MsbRunner {
  runSandbox(spec: MsbRunSpec): Promise<string>;
  removeSandbox(name: string): Promise<void>;
}

export function normalizeMsbMemory(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)([kmgKMG])[bB]?$/);
  if (match) {
    return `${match[1]}${match[2]!.toUpperCase()}`;
  }
  return trimmed;
}

export function buildMsbRunArgs(spec: MsbRunSpec): string[] {
  const args: string[] = [
    "run",
    "-d",
    "--name",
    spec.name,
    "--replace",
    "-p",
    `127.0.0.1:${spec.hostPort}:${spec.guestPort}`,
  ];

  if (spec.cpus && spec.cpus.trim().length > 0) {
    args.push("-c", spec.cpus.trim());
  }
  if (spec.memory && spec.memory.trim().length > 0) {
    args.push("-m", normalizeMsbMemory(spec.memory));
  }

  for (const [k, v] of Object.entries(spec.labels)) {
    args.push("--label", `${k}=${v}`);
  }

  if (spec.secret && spec.secret.allowedHosts.length > 0) {
    const hosts = spec.secret.allowedHosts.join(",");
    const headers = spec.secret.headers?.length
      ? `:headers=[${spec.secret.headers.join(",")}]`
      : "";
    args.push("--secret", `${spec.secret.envName}${headers}@${hosts}`);
  }

  for (const [k, v] of Object.entries(spec.env)) {
    args.push("-e", `${k}=${v}`);
  }

  if (spec.entrypoint && spec.entrypoint.trim().length > 0) {
    args.push("--entrypoint", spec.entrypoint.trim());
  }

  args.push(spec.image);

  if (spec.command && spec.command.length > 0) {
    args.push("--", ...spec.command);
  }

  return args;
}

export class CliMsbRunner implements MsbRunner {
  private readonly msbBin: string;

  constructor(msbBin = process.env.MSB_PATH?.trim() || "msb") {
    this.msbBin = msbBin;
  }

  async runSandbox(spec: MsbRunSpec): Promise<string> {
    const args = buildMsbRunArgs(spec);
    const extraEnv: Record<string, string> = {};
    if (spec.secret) {
      // Microsandbox reads the real secret value from the host process environment
      extraEnv[spec.secret.envName] = spec.secret.value;
    }
    const stdout = await this.exec(args, extraEnv);
    const name = stdout.trim().split(/\r?\n/)[0]?.trim();
    return name || spec.name;
  }

  async removeSandbox(name: string): Promise<void> {
    try {
      await this.exec(["rm", "--force", name]);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("not found") || msg.includes("No such sandbox")) {
        return;
      }
      throw err;
    }
  }

  private async exec(
    args: string[],
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const proc = Bun.spawn([this.msbBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...extraEnv },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${this.msbBin} ${args[0] ?? ""} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      );
    }
    return stdout;
  }
}
