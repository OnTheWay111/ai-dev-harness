import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileSystemObjectStore,
} from "../app/control-plane/adapters/filesystem-object-store.ts";
import {
  MemoryObjectStore,
} from "../app/control-plane/adapters/memory-object-store.ts";
import {
  ObjectDigestMismatchError,
  ObjectScopeViolationError,
} from "../app/control-plane/ports/object-store-port.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
};
const otherScope = {
  organizationId: "00000000-0000-4000-8000-000000000003",
  projectId: "00000000-0000-4000-8000-000000000004",
};

async function* bytes(value) {
  yield new TextEncoder().encode(value);
}

function put(store, body = bytes("immutable evidence"), extra = {}) {
  return store.putImmutable({
    scope,
    body,
    mediaType: "text/plain; charset=utf-8",
    createdAt: "2026-08-05T03:00:00.000Z",
    createdBy: "worker-1",
    retentionPolicy: "standard_180d",
    retentionUntil: "2027-02-01T03:00:00.000Z",
    maxBytes: 1024,
    ...extra,
  });
}

async function objectStoreContract(createStore) {
  const store = await createStore();
  try {
    const first = await put(store);
    assert.match(first.digest, /^[0-9a-f]{64}$/);
    assert.match(first.objectKey, new RegExp(`${scope.organizationId}/${scope.projectId}/sha256/`));
    assert.equal(first.sizeBytes, 18);
    assert.equal(first.deduplicated, false);

    const duplicate = await put(store);
    assert.equal(duplicate.objectKey, first.objectKey);
    assert.equal(duplicate.digest, first.digest);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(new TextDecoder().decode(await store.read({ scope, objectKey: first.objectKey })), "immutable evidence");

    await assert.rejects(
      () => put(store, bytes("tampered"), { expectedDigest: first.digest }),
      ObjectDigestMismatchError,
    );
    await assert.rejects(
      () => store.read({ scope: otherScope, objectKey: first.objectKey }),
      ObjectScopeViolationError,
    );
    await assert.rejects(
      () => store.createDownloadGrant({
        scope: otherScope,
        objectKey: first.objectKey,
        actorId: "viewer-2",
        expiresInSeconds: 60,
      }),
      ObjectScopeViolationError,
    );
    const grant = await store.createDownloadGrant({
      scope,
      objectKey: first.objectKey,
      actorId: "viewer-1",
      expiresInSeconds: 60,
    });
    assert.ok(grant.url);
    assert.equal(grant.expiresAt, "2026-08-05T03:01:00.000Z");
  } finally {
    await store.dispose?.();
  }
}

test("P9 memory object store enforces immutable digest and tenant scope", async () => {
  await objectStoreContract(async () => new MemoryObjectStore({
    clock: () => new Date("2026-08-05T03:00:00.000Z"),
  }));
});

test("P9 filesystem-compatible store passes the production object contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "p9-object-store-"));
  await objectStoreContract(async () => {
    const store = new FileSystemObjectStore({
      root,
      clock: () => new Date("2026-08-05T03:00:00.000Z"),
      downloadBaseUrl: "https://artifacts.harness.test/download",
      signingSecret: "synthetic-test-signing-key-not-a-real-secret",
    });
    return Object.assign(store, { dispose: async () => await rm(root, { recursive: true, force: true }) });
  });
});

test("interrupted uploads never publish partial immutable objects", async () => {
  const store = new MemoryObjectStore();
  async function* interrupted() {
    yield new TextEncoder().encode("partial");
    throw new Error("source interrupted");
  }
  await assert.rejects(() => put(store, interrupted()), /interrupted/);
  assert.equal(store.objectCount(), 0);
});

test("filesystem store rejects a same-size object corrupted outside the adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "p9-object-integrity-"));
  try {
    const store = new FileSystemObjectStore({
      root,
      downloadBaseUrl: "https://artifacts.harness.test/download",
      signingSecret: "synthetic-test-signing-key-not-a-real-secret",
    });
    const object = await put(store);
    await writeFile(join(root, ...object.objectKey.split("/")), "x".repeat(18));
    await assert.rejects(() => put(store), /digest metadata/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
