import { createHmac } from "node:crypto";
import type { RealtimeEvent, Repository, Task } from "@verft/shared-types";
import type { OperationalLogger } from "../lib/operational-logger.js";
import type { RepositoryStore } from "./repository-store.js";
import type { TaskStore } from "./task-store.js";
import type { WebhookDeliveryStore, WebhookEventType, WebhookJob } from "./webhook-delivery-store.js";

const WEBHOOK_PROCESS_INTERVAL_MS = 1_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 900_000];
const WEBHOOK_BATCH_SIZE = 20;

interface WebhookEnvelope {
  deliveryId: string;
  eventType: WebhookEventType;
  sentAt: string;
  repository: {
    id: string;
    name: string;
    url: string;
    defaultBranch: string;
  };
  payload: Record<string, unknown>;
}

const nowIso = (): string => new Date().toISOString();

export class WebhookDeliveryService {
  private interval: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly webhookDeliveryStore: WebhookDeliveryStore,
    private readonly repositoryStore: RepositoryStore,
    private readonly taskStore: TaskStore,
    private readonly logger?: OperationalLogger
  ) {}

  private selectTaskPayload(task: Task): Record<string, unknown> {
    return {
      id: task.id,
      repoId: task.repoId,
      title: task.title,
      taskType: task.taskType,
      status: task.status,
      branchName: task.branchName,
      baseBranch: task.baseBranch,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      finishedAt: task.finishedAt
    };
  }

  async handleRealtimeEvent(event: RealtimeEvent): Promise<void> {
    if (event.type === "task:run_updated") {
      const run = event.payload;
      if (run.status === "running") {
        return;
      }
      const task = await this.taskStore.getTask(run.taskId);
      if (!task) {
        this.logger?.warn("webhook", "webhook.delivery.dropped", "Webhook delivery dropped", {
          eventType: "run_finished",
          taskId: run.taskId,
          runId: run.id,
          reason: "missing_task"
        });
        return;
      }
      const queued = await this.webhookDeliveryStore.enqueueFinishedRunOnce(run.id, {
        repositoryId: task.repoId,
        eventType: "run_finished",
        payload: {
          run: {
            id: run.id,
            taskId: run.taskId,
            action: run.action,
            status: run.status,
            finishedAt: run.finishedAt,
            branchName: run.branchName,
            finalMessage: run.summary,
            errorMessage: run.errorMessage
          }
        }
      });
      if (queued) {
        this.logger?.info("webhook", "webhook.delivery.queued", "Webhook delivery queued", {
          eventType: "run_finished",
          repositoryId: task.repoId,
          taskId: run.taskId,
          runId: run.id
        });
      }
      return;
    }

    if (event.type === "task:created") {
      await this.webhookDeliveryStore.enqueueJob({
        repositoryId: event.payload.repoId,
        eventType: "created",
        payload: { task: this.selectTaskPayload(event.payload) }
      });
      this.logger?.info("webhook", "webhook.delivery.queued", "Webhook delivery queued", {
        eventType: "created",
        repositoryId: event.payload.repoId,
        taskId: event.payload.id
      });
      await this.webhookDeliveryStore.setLastTaskStatus(event.payload.id, event.payload.status);
      return;
    }

    if (event.type === "task:updated") {
      const lastStatus = await this.webhookDeliveryStore.getLastTaskStatus(event.payload.id);
      if (lastStatus !== event.payload.status) {
        await this.webhookDeliveryStore.enqueueJob({
          repositoryId: event.payload.repoId,
          eventType: "updated",
          payload: {
            previousStatus: lastStatus,
            currentStatus: event.payload.status,
            task: this.selectTaskPayload(event.payload)
          }
        });
        this.logger?.info("webhook", "webhook.delivery.queued", "Webhook delivery queued", {
          eventType: "updated",
          repositoryId: event.payload.repoId,
          taskId: event.payload.id,
          previousStatus: lastStatus,
          currentStatus: event.payload.status
        });
      }
      await this.webhookDeliveryStore.setLastTaskStatus(event.payload.id, event.payload.status);
      return;
    }

    if (event.type === "task:deleted") {
      await this.webhookDeliveryStore.enqueueJob({
        repositoryId: event.payload.repoId,
        eventType: "deleted",
        payload: {
          taskId: event.payload.id,
          repoId: event.payload.repoId
        }
      });
      this.logger?.info("webhook", "webhook.delivery.queued", "Webhook delivery queued", {
        eventType: "deleted",
        repositoryId: event.payload.repoId,
        taskId: event.payload.id
      });
      await this.webhookDeliveryStore.clearLastTaskStatus(event.payload.id);
      return;
    }

    if (event.type === "task:pushed") {
      await this.webhookDeliveryStore.enqueueJob({
        repositoryId: event.payload.repoId,
        eventType: "pushed",
        payload: {
          taskId: event.payload.taskId,
          repoId: event.payload.repoId,
          branchName: event.payload.branchName,
          commitMessage: event.payload.commitMessage,
          triggeredAt: event.payload.triggeredAt
        }
      });
      this.logger?.info("webhook", "webhook.delivery.queued", "Webhook delivery queued", {
        eventType: "pushed",
        repositoryId: event.payload.repoId,
        taskId: event.payload.taskId
      });
      return;
    }

    if (event.type === "task:merged") {
      await this.webhookDeliveryStore.enqueueJob({
        repositoryId: event.payload.repoId,
        eventType: "merged",
        payload: {
          taskId: event.payload.taskId,
          repoId: event.payload.repoId,
          sourceBranch: event.payload.sourceBranch,
          targetBranch: event.payload.targetBranch,
          commitMessage: event.payload.commitMessage,
          triggeredAt: event.payload.triggeredAt
        }
      });
      this.logger?.info("webhook", "webhook.delivery.queued", "Webhook delivery queued", {
        eventType: "merged",
        repositoryId: event.payload.repoId,
        taskId: event.payload.taskId
      });
    }
  }

  start(): void {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      void this.processDueJobs();
    }, WEBHOOK_PROCESS_INTERVAL_MS);
  }

  stop(): void {
    if (!this.interval) {
      return;
    }
    clearInterval(this.interval);
    this.interval = null;
  }

  private buildEnvelope(job: WebhookJob, repository: Repository, sentAt: string): WebhookEnvelope {
    return {
      deliveryId: job.id,
      eventType: job.eventType,
      sentAt,
      repository: {
        id: repository.id,
        name: repository.name,
        url: repository.url,
        defaultBranch: repository.defaultBranch
      },
      payload: job.payload
    };
  }

  private async deliver(job: WebhookJob): Promise<void> {
    const target = await this.repositoryStore.getRepositoryWebhookTarget(job.repositoryId);
    if (!target) {
      this.logger?.warn("webhook", "webhook.delivery.dropped", "Webhook delivery dropped", {
        deliveryId: job.id,
        eventType: job.eventType,
        repositoryId: job.repositoryId,
        reason: "missing_target"
      });
      return;
    }

    const sentAt = nowIso();
    const envelope = this.buildEnvelope(job, target.repository, sentAt);
    const body = JSON.stringify(envelope);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", target.webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    this.logger?.info("webhook", "webhook.delivery.started", "Webhook delivery started", {
      deliveryId: job.id,
      eventType: job.eventType,
      repositoryId: job.repositoryId,
      attempt: job.attempt
    });

    const response = await fetch(target.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-verft-event": job.eventType,
        "x-verft-delivery-id": job.id,
        "x-verft-timestamp": timestamp,
        "x-verft-signature": `sha256=${signature}`
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Webhook responded with HTTP ${response.status}`);
    }

    await this.repositoryStore.recordWebhookDeliveryResult(job.repositoryId, {
      status: "success",
      attemptedAt: sentAt
    });
    this.logger?.info("webhook", "webhook.delivery.succeeded", "Webhook delivery succeeded", {
      deliveryId: job.id,
      eventType: job.eventType,
      repositoryId: job.repositoryId,
      statusCode: response.status,
      attempt: job.attempt
    });
  }

  private async processDueJobs(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      const dueIds = await this.webhookDeliveryStore.listDueJobIds(Date.now(), WEBHOOK_BATCH_SIZE);
      if (dueIds.length === 0) {
        return;
      }

      for (const deliveryId of dueIds) {
        const job = await this.webhookDeliveryStore.getJob(deliveryId);
        if (!job) {
          await this.webhookDeliveryStore.deleteJob(deliveryId);
          continue;
        }

        try {
          await this.deliver(job);
          await this.webhookDeliveryStore.deleteJob(deliveryId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Webhook delivery failed.";
          await this.repositoryStore.recordWebhookDeliveryResult(job.repositoryId, {
            status: "failed",
            attemptedAt: nowIso(),
            errorMessage: detail
          });

          const retryDelay = WEBHOOK_RETRY_DELAYS_MS[job.attempt - 1];
          if (retryDelay === undefined) {
            await this.webhookDeliveryStore.deleteJob(deliveryId);
            this.logger?.error("webhook", "webhook.delivery.failed", "Webhook delivery failed", {
              deliveryId: job.id,
              eventType: job.eventType,
              repositoryId: job.repositoryId,
              attempt: job.attempt,
              errorMessage: detail
            });
            continue;
          }

          await this.webhookDeliveryStore.scheduleRetry(job, retryDelay);
          this.logger?.warn("webhook", "webhook.delivery.retry_scheduled", "Webhook delivery retry scheduled", {
            deliveryId: job.id,
            eventType: job.eventType,
            repositoryId: job.repositoryId,
            attempt: job.attempt,
            retryDelayMs: retryDelay,
            errorMessage: detail
          });
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
