import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const committedDirectory = join(projectDirectory, "drizzle-postgres");

async function migrationTree(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.set(
          relative(directory, path).replaceAll("\\", "/"),
          createHash("sha256").update(await readFile(path)).digest("hex"),
        );
      }
    }
  }
  await visit(directory);
  return result;
}

export function compareMigrationTrees(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const added = [...after.keys()]
    .filter((path) => !before.has(path))
    .sort();
  const modified = [...after.keys()]
    .filter((path) => before.has(path) && before.get(path) !== after.get(path))
    .sort();
  const removed = [...before.keys()]
    .filter((path) => !after.has(path))
    .sort();
  return [...added, ...modified, ...removed];
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "POSTGRES_TEST_ADMIN_URL",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function main(): Promise<number> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "ai-dev-harness-drift-"),
  );
  try {
    const generatedDirectory = join(
      temporaryDirectory,
      "drizzle-postgres",
    );
    await cp(committedDirectory, generatedDirectory, { recursive: true });
    const configPath = join(temporaryDirectory, "drizzle.config.ts");
    await writeFile(
      configPath,
      `export default ${JSON.stringify({
        dialect: "postgresql",
        schema: join(projectDirectory, "db/postgres-schema.ts"),
        out: generatedDirectory,
      })};\n`,
    );
    const before = await migrationTree(committedDirectory);
    await execFileAsync(
      join(projectDirectory, "node_modules/.bin/drizzle-kit"),
      ["generate", "--config", configPath],
      {
        cwd: projectDirectory,
        env: sanitizedEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const changes = compareMigrationTrees(
      before,
      await migrationTree(generatedDirectory),
    );
    if (changes.length > 0) {
      console.error(`PostgreSQL migration drift: ${changes.join(", ")}`);
      return 1;
    }
    console.log("PostgreSQL schema and committed migrations have no drift");
    return 0;
  } catch {
    console.error(
      "PostgreSQL migration drift check failed; configuration and environment details were suppressed",
    );
    return 1;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
