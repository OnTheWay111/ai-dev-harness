import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const webRoot = new URL("../", import.meta.url).pathname;

async function files(directory: string, result: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await files(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function main(): Promise<void> {
  const output = process.env.SUPPLY_CHAIN_OUTPUT_DIR?.trim();
  if (!output || !isAbsolute(output)) {
    throw new Error("SUPPLY_CHAIN_OUTPUT_DIR must be an absolute path");
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sbom = await execFileAsync("npm", ["sbom", "--sbom-format", "cyclonedx"], {
    cwd: webRoot,
    maxBuffer: 50 * 1024 * 1024,
  });
  const parsed = JSON.parse(sbom.stdout);
  await writeFile(join(output, "web-sbom.cdx.json"),
    `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

  const dist = join(webRoot, "dist");
  const entries = [];
  for (const path of (await files(dist)).sort()) {
    const bytes = await readFile(path);
    entries.push({
      path: relative(dist, path),
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (entries.length < 1) throw new Error("Build output is empty");
  await writeFile(join(output, "web-build-manifest.json"), `${JSON.stringify({
    schemaVersion: "harness.build-manifest.v1",
    buildId: randomUUID(),
    generatedAt: new Date().toISOString(),
    root: "prototype/web-ui/dist",
    files: entries,
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Generated Web SBOM and ${entries.length}-file build manifest`);
}

main().catch(() => {
  console.error("Supply-chain artifact generation failed; paths were suppressed");
  process.exitCode = 1;
});
