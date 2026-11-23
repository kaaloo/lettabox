import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const GH_CLI_VERSION = "2.104.0";
export const GH_GUEST_BIN_PATH = "/usr/local/bin/gh";

export type GhLinuxArch = "amd64" | "arm64";

export interface GhReleaseAsset {
  readonly url: string;
  readonly archiveEntry: string;
  readonly sha256: string;
}

export const GH_RELEASE_ASSETS: Record<GhLinuxArch, GhReleaseAsset> = {
  amd64: {
    url: `https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz`,
    archiveEntry: `gh_${GH_CLI_VERSION}_linux_amd64/bin/gh`,
    sha256: "98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e",
  },
  arm64: {
    url: `https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_arm64.tar.gz`,
    archiveEntry: `gh_${GH_CLI_VERSION}_linux_arm64/bin/gh`,
    sha256: "cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3",
  },
};

export interface GhBinaryLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface EnsureGhBinaryOptions {
  msbHome: string;
  arch?: GhLinuxArch;
  version?: string;
  asset?: GhReleaseAsset;
  fetchImpl?: typeof fetch;
  logger?: GhBinaryLogger;
}

export function resolveGhLinuxArch(hostArch: string = process.arch): GhLinuxArch {
  if (hostArch === "arm64") return "arm64";
  if (hostArch === "x64") return "amd64";
  throw new Error(`Unsupported architecture for Linux gh CLI binary: ${hostArch}`);
}

export function getGhBinaryCachePath(
  msbHome: string,
  arch: GhLinuxArch = resolveGhLinuxArch(),
  version: string = GH_CLI_VERSION,
): string {
  return join(msbHome, "cache", "gh", version, `linux-${arch}`, "gh");
}

function isUsableCachedBinary(cachePath: string): boolean {
  try {
    const st = lstatSync(cachePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export async function ensureGhBinaryCached(options: EnsureGhBinaryOptions): Promise<string> {
  const arch = options.arch ?? resolveGhLinuxArch();
  const version = options.version ?? GH_CLI_VERSION;
  const asset = options.asset ?? GH_RELEASE_ASSETS[arch];
  const cachePath = getGhBinaryCachePath(options.msbHome, arch, version);
  const fetchImpl = options.fetchImpl ?? fetch;

  if (isUsableCachedBinary(cachePath)) {
    options.logger?.info(`gh CLI ${version} (linux/${arch}) cached`);
    return cachePath;
  }

  options.logger?.info(`Downloading gh CLI ${version} (linux/${arch}) into ${options.msbHome}...`);

  const response = await fetchImpl(asset.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Failed to download gh CLI ${version} (${response.status} ${response.statusText}) from ${asset.url}`,
    );
  }

  const tarballBytes = new Uint8Array(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(tarballBytes).digest("hex");
  const expectedSha256 = asset.sha256.toLowerCase();
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for gh CLI ${version} (${arch}): expected ${expectedSha256}, got ${actualSha256}`,
    );
  }

  const archive = new Bun.Archive(tarballBytes);
  const files = await archive.files([asset.archiveEntry, `./${asset.archiveEntry}`]);
  const ghFile = files.get(asset.archiveEntry) ?? files.get(`./${asset.archiveEntry}`);
  if (!ghFile || ghFile.size === 0) {
    throw new Error(
      `Expected entry ${asset.archiveEntry} was missing or empty in gh CLI ${version} archive`,
    );
  }

  const binaryBytes = new Uint8Array(await ghFile.arrayBuffer());
  const cacheDir = dirname(cachePath);
  mkdirSync(cacheDir, { recursive: true });

  const tmpPath = join(cacheDir, `.gh.tmp.${process.pid}.${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmpPath, binaryBytes, { mode: 0o755 });
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, cachePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }

  options.logger?.info(`gh CLI ${version} (linux/${arch}) ready`);
  return cachePath;
}
