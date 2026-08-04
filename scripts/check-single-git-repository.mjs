import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([
  ".next",
  ".vinext",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const scriptPath = fileURLToPath(import.meta.url);
export const repositoryRoot = dirname(dirname(scriptPath));

export function findNestedGitRepositories(root) {
  const absoluteRoot = resolve(root);
  const rootGitMetadata = join(absoluteRoot, ".git");
  const nestedGitMetadata = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.name === ".git") {
        if (entryPath !== rootGitMetadata) nestedGitMetadata.push(entryPath);
        continue;
      }
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !ignoredDirectories.has(entry.name)
      ) {
        visit(entryPath);
      }
    }
  }

  visit(absoluteRoot);
  return nestedGitMetadata.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const nestedGitMetadata = findNestedGitRepositories(repositoryRoot);
  if (nestedGitMetadata.length > 0) {
    console.error("Nested Git repository metadata is forbidden:");
    for (const path of nestedGitMetadata) console.error(`- ${path}`);
    process.exitCode = 1;
  } else {
    console.log("Repository layout check passed: no nested Git metadata");
  }
}
