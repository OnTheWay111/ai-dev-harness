import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface LeakRule {
  label: string;
  pattern: RegExp;
}

export interface ClientArtifactLeak {
  path: string;
  label: string;
}

export interface ClientArtifactScan {
  filesScanned: number;
  leaks: ClientArtifactLeak[];
}

const leakRules: LeakRule[] = [
  {
    label: "database connection URL",
    pattern: /\bpostgres(?:ql)?:\/\//i,
  },
  {
    label: "database Secret name",
    pattern:
      /\b(?:AI_DEV_HARNESS_[A-Z0-9_]*(?:DATABASE|MIGRATION_DATABASE)_URL|DATABASE_URL|MIGRATION_DATABASE_URL|HARNESS_POSTGRES_ENDPOINT_ID)\b/,
  },
  {
    label: "server database driver",
    pattern:
      /@neondatabase\/serverless|drizzle-orm\/(?:neon-http|node-postgres|pg-core)|\b(?:pg-protocol|pg-pool|createNeonWorkbenchDatabase|NeonWorkbenchReadStore)\b/,
  },
  {
    label: "OIDC server Secret name",
    pattern: /\b(?:OIDC_CLIENT_SECRET|OIDC_COOKIE_SECRET)\b/,
  },
  {
    label: "OIDC token material",
    pattern: /\b(?:access_token|refresh_token|id_token)\b/,
  },
];

async function artifactFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await artifactFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export async function scanClientArtifacts(
  root: string | URL,
): Promise<ClientArtifactScan> {
  const rootPath = root instanceof URL ? fileURLToPath(root) : resolve(root);
  const files = await artifactFiles(rootPath);
  const leaks: ClientArtifactLeak[] = [];
  for (const path of files) {
    const contents = await readFile(path, "utf8");
    for (const rule of leakRules) {
      if (rule.pattern.test(contents)) {
        leaks.push({
          path: relative(rootPath, path).replaceAll("\\", "/"),
          label: rule.label,
        });
      }
    }
  }
  return { filesScanned: files.length, leaks };
}

async function main(): Promise<number> {
  try {
    const root = process.argv[2]
      ? resolve(process.argv[2])
      : new URL("../dist/client", import.meta.url);
    const result = await scanClientArtifacts(root);
    if (result.filesScanned === 0) {
      console.error("Client artifact scan failed: no build files were found");
      return 1;
    }
    if (result.leaks.length > 0) {
      for (const leak of result.leaks) {
        console.error(`Client artifact blocked: ${leak.label} in ${leak.path}`);
      }
      return 1;
    }
    console.log(
      `Client artifact scan passed for ${result.filesScanned} files`,
    );
    return 0;
  } catch {
    console.error(
      "Client artifact scan failed; file contents and environment details were suppressed",
    );
    return 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
