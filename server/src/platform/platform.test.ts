import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "../engine/engine";
import { Store, type RunSummary } from "../engine/store";
import { FakeProvider } from "../llm/fake";
import { testDb } from "../test/helpers";
import { createPlatformApi } from "./api";
import { Connections, type PublicConnection } from "./connections";
import { seal, unseal } from "./crypto";
import { RuntimeRegistry } from "./runtime";

const secret = "a".repeat(64);
const alice = "1".repeat(64);
const bob = "2".repeat(64);
let engine: Engine;
let store: Store;
let connections: Connections;
let api: (req: Request) => Promise<Response>;
const key = "private-test-key-never-return";
const graph = {
  steps: [{ id: "answer", prompt: "Explain orchestration", final: true }],
};

beforeEach(async () => {
  const db = await testDb();
  store = await Store.open(db);
  connections = await Connections.open(
    db,
    secret,
    (config) =>
      new FakeProvider(
        () => {
          if (config.apiKey === "invalid")
            throw new Error("Invalid credentials");
          return { text: `Reply from ${config.model}` };
        },
        { model: config.model },
      ),
  );
  await db.exec("TRUNCATE connections");
  const demo = new FakeProvider(() => ({ text: "Simulated answer" }), {
    delayMs: (request) => (request.prompt === "slow" ? 5_000 : 0),
  });
  const registry = new RuntimeRegistry({
    store,
    connections,
    demo,
    demoDelayMs: 0,
  });
  engine = new Engine({
    store,
    provider: demo,
    pricing: { inputPerM: 0, outputPerM: 0, searchPerK: 0 },
    rpm: 60_000,
    resolveRuntime: registry.resolve,
  });
  api = createPlatformApi({ store, engine, connections, basePath: "/api" });
});
afterEach(async () => {
  await engine?.stop({ graceful: false });
});

function call(
  owner: string | null,
  method: string,
  path: string,
  body?: unknown,
  origin?: string,
) {
  return api(
    new Request(`http://relay.test/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(owner ? { cookie: `relay_workspace=${owner}` } : {}),
        ...(origin ? { origin } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe("private workspaces", () => {
  test("issues an HttpOnly workspace capability and rejects cross-origin writes", async () => {
    const res = await call(null, "GET", "/session");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(
      /relay_workspace=[a-f0-9]{64};.*HttpOnly.*SameSite=Lax/,
    );
    expect(await res.text()).not.toContain("relay_workspace");
    expect(
      (await call(alice, "POST", "/runs", { graph }, "https://foreign.test"))
        .status,
    ).toBe(403);
  });

  test("isolates list, snapshots, events, cancellation, retry and deletion", async () => {
    const created = await call(alice, "POST", "/runs", { graph });
    expect(created.status).toBe(201);
    const { runId } = (await created.json()) as { runId: string };
    await engine.whenSettled(runId);
    expect(
      (
        (await (await call(alice, "GET", "/runs")).json()) as {
          runs: RunSummary[];
        }
      ).runs,
    ).toHaveLength(1);
    expect(
      (
        (await (await call(bob, "GET", "/runs")).json()) as {
          runs: RunSummary[];
        }
      ).runs,
    ).toHaveLength(0);
    for (const [method, suffix] of [
      ["GET", ""],
      ["GET", "/events"],
      ["POST", "/cancel"],
      ["POST", "/retry"],
      ["DELETE", ""],
    ]) {
      expect((await call(bob, method!, `/runs/${runId}${suffix}`)).status).toBe(
        404,
      );
    }
    expect((await call(alice, "GET", `/runs/${runId}`)).status).toBe(200);
  });
});

describe("provider connections", () => {
  const input = {
    name: "My OpenAI",
    provider: "openai",
    model: "test-model",
    apiKey: key,
    rpm: 60_000,
  };
  test("validates before saving and never returns plaintext or ciphertext", async () => {
    const saved = await call(alice, "POST", "/connections", input);
    expect(saved.status).toBe(201);
    const body = await saved.text();
    expect(body).not.toContain(key);
    expect(body).not.toContain("ciphertext");
    const listed = (await (
      await call(alice, "GET", "/connections")
    ).json()) as { connections: PublicConnection[] };
    expect(listed.connections).toHaveLength(1);
    expect(
      (
        (await (await call(bob, "GET", "/connections")).json()) as {
          connections: PublicConnection[];
        }
      ).connections,
    ).toHaveLength(0);
    const bad = await call(alice, "POST", "/connections", {
      ...input,
      apiKey: "invalid",
    });
    expect(bad.status).toBe(400);
    expect(
      (
        (await (await call(alice, "GET", "/connections")).json()) as {
          connections: PublicConnection[];
        }
      ).connections,
    ).toHaveLength(1);
  });

  test("persists runtime identity and uses the saved provider for a run", async () => {
    const { connection } = (await (
      await call(alice, "POST", "/connections", input)
    ).json()) as { connection: PublicConnection };
    expect(
      (await call(bob, "POST", "/runs", { graph, connectionId: connection.id }))
        .status,
    ).toBe(404);
    const created = await call(alice, "POST", "/runs", {
      graph,
      connectionId: connection.id,
    });
    const { runId } = (await created.json()) as { runId: string };
    await engine.whenSettled(runId);
    const snapshot = (await (
      await call(alice, "GET", `/runs/${runId}`)
    ).json()) as NonNullable<Awaited<ReturnType<Store["snapshot"]>>>;
    expect(snapshot.run.status).toBe("succeeded");
    expect(snapshot.steps[0]!.output).toBe("Reply from test-model");
    expect(snapshot.run.execution).toMatchObject({
      provider: "openai",
      model: "test-model",
      simulated: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain(key);
    expect(
      (await connections.runtimeFor(connection.id, alice)).provider.model,
    ).toBe("test-model");
    expect(
      (await call(bob, "DELETE", `/connections/${connection.id}`)).status,
    ).toBe(404);
    expect(
      (await call(alice, "DELETE", `/connections/${connection.id}`)).status,
    ).toBe(200);
  });

  test("does not allow provider URLs or unbounded public execution", async () => {
    expect(
      (
        await call(alice, "POST", "/connections", {
          ...input,
          provider: "http://localhost:5432",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(alice, "POST", "/runs", { graph, concurrency: 1000 })).status,
    ).toBe(400);
  });

  test("concurrent submissions cannot exceed the workspace's active-run limit", async () => {
    const replies = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(alice, "POST", "/runs", {
          graph: { steps: [{ id: "one", prompt: "slow" }] },
        }),
      ),
    );
    expect(
      replies.filter((response) => response.status === 201).length,
    ).toBeLessThanOrEqual(3);
    expect(replies.some((response) => response.status === 409)).toBe(true);
  });
});

test("credential encryption authenticates the owner and detects tampering", () => {
  const encrypted = seal(key, secret, `${alice}:connection`);
  expect(encrypted).not.toContain(key);
  expect(unseal(encrypted, secret, `${alice}:connection`)).toBe(key);
  expect(() => unseal(encrypted, secret, `${bob}:connection`)).toThrow();
  expect(() =>
    unseal(encrypted.slice(0, -6) + "xxxxxx", secret, `${alice}:connection`),
  ).toThrow();
});
