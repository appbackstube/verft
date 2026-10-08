# Outbound Webhooks

Configure a webhook URL and secret in a repository's **Webhooks** settings, then enable webhooks. The same settings can be updated through `PATCH /api/repositories/:id` with `webhookUrl`, `webhookSecret`, and `webhookEnabled` (requires `repo:edit`). Verft sends an HTTP `POST` to that URL for events in the repository.

## Run finished

`run_finished` is sent once for each run that succeeds, fails, or is cancelled. This includes later runs on an existing task. `payload.run.finalMessage` contains the run's stored final summary, or `null` when the run produced no final message. Failures also expose `payload.run.errorMessage`. Existing runs are not replayed when a webhook is enabled.

```json
{
  "deliveryId": "delivery-id",
  "eventType": "run_finished",
  "sentAt": "2026-10-08T12:00:00.000Z",
  "repository": {
    "id": "repo-id",
    "name": "Example",
    "url": "https://github.com/example/repo.git",
    "defaultBranch": "main"
  },
  "payload": {
    "run": {
      "id": "run-id",
      "taskId": "task-id",
      "action": "ask",
      "status": "succeeded",
      "finishedAt": "2026-10-08T11:59:59.000Z",
      "branchName": "verft/task-id",
      "finalMessage": "The agent's final answer in Markdown.",
      "errorMessage": null
    }
  }
}
```

`action` is `build` or `ask`; `status` is `succeeded`, `failed`, or `cancelled`. `branchName` and `finalMessage` can be `null`. A configured postflight check is also stored as a run, so it sends its postflight summary through this event.

## Delivery and verification

The request headers are `X-Verft-Event`, `X-Verft-Delivery-Id`, `X-Verft-Timestamp`, and `X-Verft-Signature`. Verify `X-Verft-Signature` as `sha256=` followed by the hex HMAC-SHA256 of `<timestamp>.<raw request body>` using the repository's webhook secret. Compare signatures using a constant-time comparison and reject stale timestamps.

Verft retries failed deliveries. A receiver should deduplicate by `deliveryId` and return a 2xx response after accepting an event.
