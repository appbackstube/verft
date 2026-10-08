import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { RealtimeEvent, Repository, Task, TaskRun } from "@verft/shared-types";
import { RedisWebhookDeliveryStore } from "./webhook-delivery-store.js";
import { WebhookDeliveryService } from "./webhook-delivery-service.js";

class FakeRedis {
  private readonly kv = new Map<string, string>();
  private readonly zsets = new Map<string, Map<string, number>>();

  private getZset(key: string): Map<string, number> {
    let current = this.zsets.get(key);
    if (!current) {
      current = new Map<string, number>();
      this.zsets.set(key, current);
    }
    return current;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.kv.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async eval(
    _script: string,
    _keyCount: number,
    markerKey: string,
    jobKey: string,
    queueKey: string,
    deliveryId: string,
    jobJson: string,
    dueAt: number
  ): Promise<number> {
    if (this.kv.has(markerKey)) {
      return 0;
    }
    this.kv.set(markerKey, deliveryId);
    this.kv.set(jobKey, jobJson);
    this.getZset(queueKey).set(deliveryId, dueAt);
    return 1;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.kv.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.getZset(key).set(member, score);
    return 1;
  }

  async zrem(key: string, member: string): Promise<number> {
    const zset = this.getZset(key);
    const existed = zset.delete(member);
    return existed ? 1 : 0;
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
    _limitKeyword?: string,
    offset?: number,
    count?: number
  ): Promise<string[]> {
    const parsedOffset = Number.isFinite(offset) ? Number(offset) : 0;
    const parsedCount = Number.isFinite(count) ? Number(count) : Number.MAX_SAFE_INTEGER;
    return [...this.getZset(key).entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(parsedOffset, parsedOffset + parsedCount)
      .map(([member]) => member);
  }

  multi(): {
    set: (key: string, value: string) => unknown;
    zadd: (key: string, score: number, member: string) => unknown;
    zrem: (key: string, member: string) => unknown;
    del: (...keys: string[]) => unknown;
    exec: () => Promise<unknown[]>;
  } {
    const operations: Array<() => void> = [];
    const chain = {
      set: (key: string, value: string) => {
        operations.push(() => {
          this.kv.set(key, value);
        });
        return chain;
      },
      zadd: (key: string, score: number, member: string) => {
        operations.push(() => {
          this.getZset(key).set(member, score);
        });
        return chain;
      },
      zrem: (key: string, member: string) => {
        operations.push(() => {
          this.getZset(key).delete(member);
        });
        return chain;
      },
      del: (...keys: string[]) => {
        operations.push(() => {
          for (const key of keys) {
            this.kv.delete(key);
          }
        });
        return chain;
      },
      exec: async () => {
        for (const operation of operations) {
          operation();
        }
        return [] as unknown[];
      }
    };
    return chain;
  }
}

const baseTask = (): Task => ({
  id: "task-1",
  title: "Example task",
  pinned: false,
  hasPendingCheckpoint: false,
  autoApplyCheckpoints: false,
  shareWithTeam: false,
  ownerUserId: "user-1",
  repoId: "repo-1",
  repoName: "Repo",
  repoUrl: "https://github.com/example/repo.git",
  repoDefaultBranch: "main",
  taskType: "build",
  provider: "codex",
  providerProfile: "medium",
  modelOverride: null,
  baseBranch: "main",
  branchStrategy: "feature_branch",
  complexity: "normal",
  branchName: "verft/task-1",
  workspaceBaseRef: null,
  prompt: "Do it",
  resultMarkdown: null,
  executionSummary: "Do it",
  branchDiff: null,
  lastAction: "build",
  status: "build_queued",
  workflowStatus: "ready",
  executionStatus: "queued",
  executionAction: "build",
  reviewReason: null,
  logs: [],
  enqueued: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  errorMessage: null
});

const baseRepository = (): Repository => ({
  id: "repo-1",
  name: "Repo",
  url: "https://github.com/example/repo.git",
  defaultBranch: "main",
  envVars: [],
  mcpServers: [],
  hostCommands: [],
  webhookUrl: "https://example.com/webhook",
  webhookEnabled: true,
  webhookSecretConfigured: true,
  webhookLastAttemptAt: null,
  webhookLastStatus: null,
  webhookLastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
});

const baseRun = (overrides: Partial<TaskRun> = {}): TaskRun => ({
  id: "run-1",
  taskId: "task-1",
  action: "build",
  provider: "codex",
  providerProfile: "medium",
  modelOverride: null,
  branchName: "verft/task-1",
  status: "succeeded",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  summary: "Final answer",
  errorMessage: null,
  logs: [],
  ...overrides
});

describe("WebhookDeliveryService", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("delivers created events and records successful delivery", async () => {
    const redis = new FakeRedis();
    const deliveryResults: Array<{ status: "success" | "failed"; attemptedAt: string; errorMessage?: string | null }> = [];
    const repositoryStore = {
      getRepositoryWebhookTarget: async () => ({
        repository: baseRepository(),
        webhookUrl: "https://example.com/webhook",
        webhookSecret: "super-secret"
      }),
      recordWebhookDeliveryResult: async (
        _repoId: string,
        input: { status: "success" | "failed"; attemptedAt: string; errorMessage?: string | null }
      ) => {
        deliveryResults.push(input);
        return baseRepository();
      }
    };
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const store = new RedisWebhookDeliveryStore(redis as never);
    const event: RealtimeEvent = { type: "task:created", payload: baseTask() };
    const service = new WebhookDeliveryService(store, repositoryStore as never, {} as never);
    await service.handleRealtimeEvent(event);
    await (service as unknown as { processDueJobs: () => Promise<void> }).processDueJobs();

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, "https://example.com/webhook");
    const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers["x-verft-event"], "created");
    assert.equal(typeof headers["x-verft-signature"], "string");
    assert.equal(deliveryResults.length, 1);
    assert.equal(deliveryResults[0]?.status, "success");
  });

  it("queues updated events only when status changes", async () => {
    const redis = new FakeRedis();
    const repositoryStore = {
      getRepositoryWebhookTarget: async () => null,
      recordWebhookDeliveryResult: async () => null
    };
    const store = new RedisWebhookDeliveryStore(redis as never);
    const service = new WebhookDeliveryService(store, repositoryStore as never, {} as never);
    const task = baseTask();

    await service.handleRealtimeEvent({ type: "task:created", payload: task });
    await service.handleRealtimeEvent({ type: "task:updated", payload: { ...task, updatedAt: "2026-01-01T00:01:00.000Z" } });
    await service.handleRealtimeEvent({
      type: "task:updated",
      payload: {
        ...task,
        status: "building",
        updatedAt: "2026-01-01T00:02:00.000Z"
      }
    });

    const queued = await redis.zrangebyscore("verft:webhook_delivery_queue", 0, Number.MAX_SAFE_INTEGER);
    assert.equal(queued.length, 2);
  });

  it("queues one run_finished event per terminal run, including later runs on the same task", async () => {
    const redis = new FakeRedis();
    const store = new RedisWebhookDeliveryStore(redis as never);
    const service = new WebhookDeliveryService(
      store,
      {} as never,
      { getTask: async () => baseTask() } as never
    );

    await service.handleRealtimeEvent({ type: "task:run_updated", payload: baseRun({ status: "running", finishedAt: null, summary: null }) });
    const runs = [
      baseRun(),
      baseRun({ id: "run-2", action: "ask", summary: "The answer is 42." }),
      baseRun({ id: "run-3", status: "failed", summary: null, errorMessage: "Agent failed" }),
      baseRun({ id: "run-4", status: "cancelled", summary: "Task cancelled by user." })
    ];
    for (const run of runs) {
      await service.handleRealtimeEvent({ type: "task:run_updated", payload: run });
      await service.handleRealtimeEvent({ type: "task:run_updated", payload: { ...run, hasRawJson: true } });
    }

    const queuedIds = await redis.zrangebyscore("verft:webhook_delivery_queue", 0, Number.MAX_SAFE_INTEGER);
    assert.equal(queuedIds.length, 4);
    const jobs = await Promise.all(queuedIds.map((id) => store.getJob(id)));
    assert.deepEqual(jobs.map((job) => job?.eventType), ["run_finished", "run_finished", "run_finished", "run_finished"]);
    assert.deepEqual(jobs.map((job) => job?.repositoryId), ["repo-1", "repo-1", "repo-1", "repo-1"]);
    assert.deepEqual(jobs.map((job) => job?.payload.run), runs.map((run) => ({
      id: run.id,
      taskId: run.taskId,
      action: run.action,
      status: run.status,
      finishedAt: run.finishedAt,
      branchName: run.branchName,
      finalMessage: run.summary,
      errorMessage: run.errorMessage
    })));
  });

  it("signs and retries run_finished deliveries", async () => {
    const redis = new FakeRedis();
    const store = new RedisWebhookDeliveryStore(redis as never);
    const repositoryStore = {
      getRepositoryWebhookTarget: async () => ({
        repository: baseRepository(),
        webhookUrl: "https://example.com/webhook",
        webhookSecret: "super-secret"
      }),
      recordWebhookDeliveryResult: async () => baseRepository()
    };
    const service = new WebhookDeliveryService(
      store,
      repositoryStore as never,
      { getTask: async () => baseTask() } as never
    );
    const fetchCalls: Array<{ headers: Record<string, string>; body: string }> = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ headers: init?.headers as Record<string, string>, body: init?.body as string });
      return new Response("ok", { status: fetchCalls.length === 1 ? 503 : 200 });
    }) as typeof fetch;

    await service.handleRealtimeEvent({ type: "task:run_updated", payload: baseRun() });
    await (service as unknown as { processDueJobs: () => Promise<void> }).processDueJobs();
    const [deliveryId] = await redis.zrangebyscore("verft:webhook_delivery_queue", 0, Number.MAX_SAFE_INTEGER);
    assert.ok(deliveryId);
    assert.equal((await store.getJob(deliveryId))?.attempt, 2);
    await redis.zadd("verft:webhook_delivery_queue", Date.now() - 1, deliveryId);
    await (service as unknown as { processDueJobs: () => Promise<void> }).processDueJobs();

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0]?.headers["x-verft-event"], "run_finished");
    assert.equal(fetchCalls[0]?.headers["x-verft-delivery-id"], deliveryId);
    assert.equal(fetchCalls[1]?.headers["x-verft-delivery-id"], deliveryId);
    for (const call of fetchCalls) {
      const timestamp = call.headers["x-verft-timestamp"];
      const expectedSignature = createHmac("sha256", "super-secret")
        .update(`${timestamp}.${call.body}`)
        .digest("hex");
      assert.equal(call.headers["x-verft-signature"], `sha256=${expectedSignature}`);
      assert.equal((JSON.parse(call.body) as { payload: { run: { finalMessage: string } } }).payload.run.finalMessage, "Final answer");
    }
    assert.deepEqual(await redis.zrangebyscore("verft:webhook_delivery_queue", 0, Number.MAX_SAFE_INTEGER), []);
  });
});
