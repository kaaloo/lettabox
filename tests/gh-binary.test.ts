import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureGhBinaryCached,
  GH_CLI_VERSION,
  GH_RELEASE_ASSETS,
  getGhBinaryCachePath,
  resolveGhLinuxArch,
} from "../src/gh-binary.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lettabox-gh-bin-test-"));
  tempDirs.push(dir);
  return dir;
}

async function buildGhTarGz(
  entryPath: string,
  payload: Uint8Array,
): Promise<{
  tarball: Uint8Array;
  sha256: string;
}> {
  const archive = new Bun.Archive(
    {
      [entryPath]: payload,
      "gh_test/README.md": "GitHub CLI fixture",
    },
    { compress: "gzip" },
  );
  const tarball = await archive.bytes();
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  return { tarball, sha256 };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("gh binary release metadata & caching", () => {
  test("resolveGhLinuxArch maps Node/Bun host architectures and rejects unsupported ones", () => {
    expect(resolveGhLinuxArch("arm64")).toBe("arm64");
    expect(resolveGhLinuxArch("x64")).toBe("amd64");
    expect(() => resolveGhLinuxArch("ia32")).toThrow("Unsupported architecture");
  });

  test("getGhBinaryCachePath places binary under msbHome/cache/gh/<version>/linux-<arch>/gh", () => {
    expect(getGhBinaryCachePath("/tmp/msb-home", "arm64", GH_CLI_VERSION)).toBe(
      `/tmp/msb-home/cache/gh/${GH_CLI_VERSION}/linux-arm64/gh`,
    );
    expect(getGhBinaryCachePath("/tmp/msb-home", "amd64", "2.104.0")).toBe(
      "/tmp/msb-home/cache/gh/2.104.0/linux-amd64/gh",
    );
  });

  test("pinned release assets specify matching version, archive entries, and 64-hex sha256 digests", () => {
    for (const arch of ["amd64", "arm64"] as const) {
      const asset = GH_RELEASE_ASSETS[arch];
      expect(asset.url).toContain(`v${GH_CLI_VERSION}`);
      expect(asset.archiveEntry).toBe(`gh_${GH_CLI_VERSION}_linux_${arch}/bin/gh`);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("ensureGhBinaryCached downloads, verifies sha256, extracts binary with 0755 mode, and reuses cache", async () => {
    const msbHome = makeTempDir();
    const binaryPayload = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const entry = `gh_${GH_CLI_VERSION}_linux_arm64/bin/gh`;
    const { tarball, sha256 } = await buildGhTarGz(entry, binaryPayload);

    let fetchCount = 0;
    const logs: string[] = [];
    const fetchImpl = (async () => {
      fetchCount += 1;
      return new Response(tarball, { status: 200 });
    }) as unknown as typeof fetch;

    const firstPath = await ensureGhBinaryCached({
      msbHome,
      arch: "arm64",
      asset: { url: "https://example.test/gh.tar.gz", archiveEntry: entry, sha256 },
      fetchImpl,
      logger: { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) },
    });

    const expectedPath = getGhBinaryCachePath(msbHome, "arm64");
    expect(firstPath).toBe(expectedPath);
    expect(fetchCount).toBe(1);
    expect(new Uint8Array(readFileSync(firstPath))).toEqual(binaryPayload);
    expect(lstatSync(firstPath).mode & 0o777).toBe(0o755);
    expect(readdirSync(dirname(firstPath))).toEqual(["gh"]);

    // Second call reuses the cached file without calling fetchImpl again
    const secondPath = await ensureGhBinaryCached({
      msbHome,
      arch: "arm64",
      asset: { url: "https://example.test/gh.tar.gz", archiveEntry: entry, sha256 },
      fetchImpl,
      logger: { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) },
    });

    expect(secondPath).toBe(expectedPath);
    expect(fetchCount).toBe(1);
    expect(logs.some((line) => line.includes("cached"))).toBe(true);
  });

  test("ensureGhBinaryCached rejects on SHA-256 mismatch without writing to cache", async () => {
    const msbHome = makeTempDir();
    const entry = `gh_${GH_CLI_VERSION}_linux_amd64/bin/gh`;
    const { tarball } = await buildGhTarGz(entry, new Uint8Array([1, 2, 3, 4]));

    const fetchImpl = (async () =>
      new Response(tarball, { status: 200 })) as unknown as typeof fetch;

    await expect(
      ensureGhBinaryCached({
        msbHome,
        arch: "amd64",
        asset: {
          url: "https://example.test/gh.tar.gz",
          archiveEntry: entry,
          sha256: "0".repeat(64),
        },
        fetchImpl,
      }),
    ).rejects.toThrow("SHA-256 mismatch");

    const cachePath = getGhBinaryCachePath(msbHome, "amd64");
    expect(() => lstatSync(cachePath)).toThrow();
  });

  test("ensureGhBinaryCached rejects on non-2xx HTTP status", async () => {
    const msbHome = makeTempDir();
    const fetchImpl = (async () =>
      new Response("not found", {
        status: 404,
        statusText: "Not Found",
      })) as unknown as typeof fetch;

    await expect(
      ensureGhBinaryCached({
        msbHome,
        arch: "arm64",
        asset: {
          url: "https://example.test/missing.tar.gz",
          archiveEntry: "gh/bin/gh",
          sha256: "a".repeat(64),
        },
        fetchImpl,
      }),
    ).rejects.toThrow("404");
  });

  test("ensureGhBinaryCached rejects when expected archive entry is missing", async () => {
    const msbHome = makeTempDir();
    const { tarball, sha256 } = await buildGhTarGz("other-dir/bin/gh", new Uint8Array([1, 2, 3]));
    const fetchImpl = (async () =>
      new Response(tarball, { status: 200 })) as unknown as typeof fetch;

    await expect(
      ensureGhBinaryCached({
        msbHome,
        arch: "arm64",
        asset: {
          url: "https://example.test/gh.tar.gz",
          archiveEntry: `gh_${GH_CLI_VERSION}_linux_arm64/bin/gh`,
          sha256,
        },
        fetchImpl,
      }),
    ).rejects.toThrow("missing or empty");
  });

  test("ensureGhBinaryCached ignores and atomically replaces a pre-existing symlink without touching target", async () => {
    const msbHome = makeTempDir();
    const outsideDir = makeTempDir();
    const targetFile = join(outsideDir, "sentinel.txt");
    writeFileSync(targetFile, "do-not-overwrite", "utf8");

    const cachePath = getGhBinaryCachePath(msbHome, "arm64");
    mkdirSync(dirname(cachePath), { recursive: true });
    symlinkSync(targetFile, cachePath);

    const binaryPayload = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x99]);
    const entry = `gh_${GH_CLI_VERSION}_linux_arm64/bin/gh`;
    const { tarball, sha256 } = await buildGhTarGz(entry, binaryPayload);

    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount += 1;
      return new Response(tarball, { status: 200 });
    }) as unknown as typeof fetch;

    const resolved = await ensureGhBinaryCached({
      msbHome,
      arch: "arm64",
      asset: { url: "https://example.test/gh.tar.gz", archiveEntry: entry, sha256 },
      fetchImpl,
    });

    expect(resolved).toBe(cachePath);
    expect(fetchCount).toBe(1);
    const st = lstatSync(cachePath);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(new Uint8Array(readFileSync(cachePath))).toEqual(binaryPayload);
    expect(readFileSync(targetFile, "utf8")).toBe("do-not-overwrite");
  });
});
