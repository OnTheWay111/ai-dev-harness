import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Vite exposes server runtime variables without enabling TLS in local HTTP mode", async () => {
  const config = await readFile(
    new URL("../vite.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(config, /HARNESS_LOCAL_HTTP/);
  assert.match(config, /injectRuntimeVariables\s*=\s*e2eHttps\s*\|\|\s*localHttp/);
  assert.match(config, /basicSsl\s*=\s*e2eHttps/);
  assert.match(config, /injectRuntimeVariables\s*\?\s*\{/);
});
