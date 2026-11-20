export interface ContainerRunSpec {
  name: string;
  image: string;
  runtime?: string;
  containerPort: number;
  memoryLimit?: string;
  cpuLimit?: string;
  pidsLimit?: number;
  network?: string;
  labels: Record<string, string>;
  env: Record<string, string>;
}

export interface PublishedPort {
  host: string;
  port: number;
}

export interface DockerRunner {
  runContainer(spec: ContainerRunSpec): Promise<string>;
  getPublishedPort(containerId: string, containerPort: number): Promise<PublishedPort>;
  stopContainer(containerId: string): Promise<void>;
  listManagedContainers(labelFilter: string): Promise<string[]>;
}

export function buildDockerRunArgs(spec: ContainerRunSpec): string[] {
  const args: string[] = ["run", "-d", "--rm", "--name", spec.name];

  if (spec.runtime && spec.runtime.trim().length > 0) {
    args.push("--runtime", spec.runtime.trim());
  }

  // Bind container port to an ephemeral loopback port on the host
  args.push("-p", `127.0.0.1::${spec.containerPort}`);

  // Defense-in-depth hardening
  args.push("--cap-drop=ALL", "--security-opt=no-new-privileges");

  if (spec.memoryLimit) {
    args.push("--memory", spec.memoryLimit);
  }
  if (spec.cpuLimit) {
    args.push("--cpus", spec.cpuLimit);
  }
  if (spec.pidsLimit !== undefined) {
    args.push("--pids-limit", String(spec.pidsLimit));
  }
  if (spec.network) {
    args.push("--network", spec.network);
  }

  for (const [k, v] of Object.entries(spec.labels)) {
    args.push("--label", `${k}=${v}`);
  }
  for (const [k, v] of Object.entries(spec.env)) {
    args.push("-e", `${k}=${v}`);
  }

  args.push(spec.image);
  return args;
}

export function parseDockerPortOutput(output: string): PublishedPort {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines) {
    // Matches "127.0.0.1:49153" or "[::1]:49153" or "0.0.0.0:49153"
    const match = line.match(/^(\[[^\]]+\]|[^:\s]+):(\d+)$/);
    if (match) {
      const host = match[1]!;
      const port = Number.parseInt(match[2]!, 10);
      if (Number.isFinite(port) && port > 0) {
        return { host, port };
      }
    }
  }

  throw new Error(`Unable to parse docker port output: ${JSON.stringify(output)}`);
}

export class CliDockerRunner implements DockerRunner {
  private readonly dockerBin: string;

  constructor(dockerBin = "docker") {
    this.dockerBin = dockerBin;
  }

  async runContainer(spec: ContainerRunSpec): Promise<string> {
    const args = buildDockerRunArgs(spec);
    const stdout = await this.exec(args);
    const containerId = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (!containerId) {
      throw new Error(`docker run returned empty container ID`);
    }
    return containerId;
  }

  async getPublishedPort(containerId: string, containerPort: number): Promise<PublishedPort> {
    const stdout = await this.exec(["port", containerId, `${containerPort}/tcp`]);
    return parseDockerPortOutput(stdout);
  }

  async stopContainer(containerId: string): Promise<void> {
    try {
      await this.exec(["rm", "-f", containerId]);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("No such container") || msg.includes("is already in progress")) {
        return;
      }
      throw err;
    }
  }

  async listManagedContainers(labelFilter: string): Promise<string[]> {
    const stdout = await this.exec(["ps", "-aq", "--filter", `label=${labelFilter}`]);
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  private async exec(args: string[]): Promise<string> {
    const proc = Bun.spawn([this.dockerBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${this.dockerBin} ${args[0] ?? ""} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      );
    }
    return stdout;
  }
}
