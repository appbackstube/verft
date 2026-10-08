<p align="center">
  <img src="apps/web/public/logo.svg" width="320" alt="Verft logo"/>
</p>

# Verft

Self-hosted control plane for parallel AI coding agents.

Verft helps engineering teams delegate coding work to Codex and Claude across existing Git repositories. Create isolated tasks, watch each agent's logs and diffs, then decide what gets applied, pushed, or merged.

It is built for teams that want the speed of AI coding agents without giving up Git discipline, review boundaries, credential control, or visibility into what changed.

## Why Verft

- Run multiple AI coding tasks against the same codebase in parallel.
- Keep each agent in an isolated Docker workspace with its own branch and runtime context.
- Review logs, checkpoints, diffs, and Git operations before changes move forward.
- Use Codex and Claude from one web UI with shared repository, credential, and model settings.
- Let agents ask questions, implement work, react to GitHub feedback, and create follow-up subtasks.
- Self-host the app, runtime containers, credentials, database, queue, and review workflow in your own infrastructure.

## How It Works

1. **Connect**: Add repositories, GitHub credentials, provider credentials, repository env, MCP tools, Ask Templates, and defaults.
2. **Create**: Start build or ask tasks from prompts, GitHub feedback, or agent-created subtasks.
3. **Observe**: Follow task status, streamed logs, messages, terminal output, checkpoints, and pending diffs from the browser.
4. **Decide**: Apply, reject, revert, push, or merge each result from Verft's review UI.

## What You Can Do

### Split Work Across Agents

Create separate tasks for bugs, refactors, tests, migrations, documentation, and review feedback. Verft prepares isolated workspaces so agents can make progress independently while the server tracks state, branches, and task history.

### Review Before Anything Lands

Build tasks produce reviewable output instead of silently changing your main codebase. Inspect diffs, logs, checkpoints, and Git sync state before applying, reverting, pushing, or merging.

### Use Ask Mode For Repository Questions

Ask tasks let Codex or Claude inspect a codebase and answer without writing files. Use them for code discovery, implementation planning, debugging context, or risk analysis before starting a build task.

### Standardize Repeated Work

Use Ask Templates for reusable Ask prompts with named inputs and Markdown answer formats. Templates can stay private, be shared with selected teams, or be made global for authorized users. Use repository defaults for provider/model choices and repository-local postflight checks for validation.

### Integrate With GitHub Feedback

Repository GitHub integration can create or continue tasks from issues, pull request comments, edited comments, and review requests when configured. Verft can link tasks to pull requests and archive linked tasks after merge.

## Requirements

| Requirement | Notes |
| --- | --- |
| Docker | Required for the app stack and agent runtime containers. |
| Docker Compose | `docker compose` is preferred; `docker-compose` is also supported. |
| Bash | Required by helper and harness scripts. |
| Node.js 20+ and npm | Required for local development, checks, tests, and builds. |
| Python 3 | Required when installing local npm dependencies because native modules such as `node-pty` may build from source. |

## Get Started

Clone the repository:

```bash
git clone git@github.com:coretracker/verft.git
cd verft
```

Create a local environment file:

```bash
cp .env.example .env
```

Initialize the Docker stack and agent runtime image:

```bash
./verft init
```

Start the app:

```bash
./verft start
```

Open the UI:

```text
http://localhost:3217/login
```

Bootstrap credentials come from `.env.example` and are used only when the first admin user is created. Review and change them before exposing the app outside a local development environment.

After signing in:

1. Open **Settings** and add GitHub, OpenAI/Codex, and/or Anthropic/Claude credentials.
2. Open **Repositories** and add a Git repository.
3. Open **Tasks** and create a build or ask task.
4. Review task output, logs, diffs, and checkpoints from the task detail page.

Stop the app:

```bash
./verft stop
```

## Core Concepts

### Tasks

Tasks are the main unit of work in Verft.

- **Build tasks** ask an agent to modify a repository in an isolated workspace.
- **Ask tasks** ask an agent to inspect and answer without writing files.
Task definitions include title, repository, prompt, provider/model settings, branch settings, and optional prompt attachments. Task workspaces are isolated under `task-workspaces/`; persistent agent homes use the Docker-managed `verft_task_homes` volume.

Each task home is mounted at `/home/agent` for autonomous runs and interactive terminals. It keeps Codex and Claude sessions, history, plugins, and task-local settings across runs and workspace rebuilds. **New Session** clears only the current provider’s resumable session marker. **Rebuild task home** replaces the entire home from configured host state and permanently loses all task-local agent state.

On first startup after upgrading from the former bind-mounted layout, Compose copies `./task-homes` into the named volume only when the volume is empty. The source directory is left unchanged as a rollback copy.

### Checkpoints And Git Actions

Verft tracks task status, messages, runs, logs, diffs, checkpoints, and Git operations from the web UI. Pending change proposals can be applied, rejected, reverted, pushed, or merged after review.

### Repository Configuration

Repositories can define environment variables, write-only environment secrets, default agent provider/model/effort settings, GitHub integration settings, host commands, and postflight checks.

### Postflight Checks

Repositories can define post-build automation in `.verft/postflight.yml`. Postflight runs after a successful build task and before the final checkpoint is created.

Example:

```yaml
version: 1
enabled: true

when:
  task_types: ["build"]
  providers: ["codex", "claude"]

runner:
  image: "mcr.microsoft.com/playwright:v1.52.0-jammy"
  timeout_seconds: 1800

steps:
  - run: "npm ci"
  - run: "npx playwright test tests/mobile-screenshots.spec.ts --project=mobile-web --update-snapshots"

on_failure: "fail_task"
```

### Hostexec Bridge

Hostexec lets a manually started host daemon expose selected host commands, such as macOS `xcodebuild`, to agent containers through bridge shims.

1. Start the daemon on the host with `npm run hostexec`.
2. Open a repository and add simple command names to **Host Commands**, for example `xcodebuild`, `xcrun`, or `gradlew`.

Verft autodetects the daemon at the default host URLs. Repository **Host Commands** decide which command shims Verft mounts for each repository. See `hostexec/README.md` for daemon details.

## Configuration

Most runtime configuration starts in `.env`. Provider API keys and GitHub credentials are configured in the Verft Settings UI, not in `.env`.

### Core Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PUBLIC_PORT` | Public port exposed by nginx. | `3217` |
| `CORS_ORIGIN` | Allowed web origin for the API. | `http://localhost:3217` |
| `DEFAULT_ADMIN_NAME` | Bootstrap admin display name. | `Administrator` |
| `DEFAULT_ADMIN_EMAIL` | Bootstrap admin email. | `admin@verft.local` |
| `DEFAULT_ADMIN_PASSWORD` | Bootstrap admin password. | see `.env.example` |
| `AUTH_COOKIE_NAME` | Session cookie name. | `verft_session` |
| `AUTH_SESSION_TTL_DAYS` | Session lifetime in days. | `7` |

### Storage

Durable application data is stored in Postgres. Redis is required for sessions, queues, webhook jobs, and realtime pub/sub. In the Docker stack, only the nginx proxy publishes a host port; Redis, Postgres, server, and web stay on the internal Compose network.

### Runtime Images

| Variable | Description | Default |
| --- | --- | --- |
| `AGENT_RUNTIME_IMAGE` | Unified toolbox image for automated Codex/Claude runs, interactive terminals, utility runs, and Git worker containers. | `verft-agent-toolbox:latest` |
| `TASK_HOME_ROOT` | Server path containing persistent per-task agent homes. | `/task-homes` |
| `TASK_HOME_DOCKER_SOURCE` | Optional Docker-host path or named volume corresponding to `TASK_HOME_ROOT`; auto-detected from the server mount when unset. | `verft_task_homes` in the local harness |
| `VERFT_AI_STATE_HOST_ROOT` | Host home root used to initially seed `.codex`, `.claude`, and `.claude.json` into newly created or explicitly rebuilt task homes. | `$HOME` |
| `VERFT_CODEX_STATE_HOST_PATH` | Optional host path override for Codex state. | unset |
| `VERFT_CLAUDE_STATE_HOST_PATH` | Optional host path override for Claude state. | unset |
| `VERFT_CLAUDE_CONFIG_HOST_PATH` | Optional host path override for `.claude.json`. | unset |

The toolbox image includes Codex CLI, Claude Code, Git, GitHub CLI (`gh`), Docker CLI, Python, Node/npm, shell tools, and common build dependencies. Runtime image contents and mounted capabilities are part of the operator security boundary. GitHub CLI authentication is supplied at runtime from configured GitHub credentials; credentials are not baked into the image.

### Docker Socket Access

Docker socket access is enabled by default in the local Docker Compose setup so toolbox containers can run Docker-backed checks and nested containers. Set `DOCKER_SOCKET_ACCESS_ENABLED=false` to opt out.

| Variable | Description | Default |
| --- | --- | --- |
| `DOCKER_SOCKET_ACCESS_ENABLED` | Mount Docker socket into toolbox runtime containers. | `true` |
| `DOCKER_SOCKET_HOST_PATH` | Host Docker socket path. | `/var/run/docker.sock` |
| `DOCKER_SOCKET_CONTAINER_PATH_CODEX` | In-container socket path for Codex runtimes. | `/var/run/docker.sock` |
| `DOCKER_SOCKET_CONTAINER_PATH_CLAUDE` | In-container socket path for Claude runtimes. | `/var/run/docker.sock` |

Mounting `docker.sock` is highly privileged and can effectively grant host-level control from inside the runtime container.

## MCP Server

Verft exposes an MCP-compatible HTTP JSON-RPC endpoint at `/mcp`.

Authentication uses user personal access tokens:

1. Create a token with `POST /auth/personal-access-tokens` while signed in.
2. Store the returned `token` securely; it is only returned once.
3. Call `/mcp` with `Authorization: Bearer <token>`.
4. Revoke tokens with `DELETE /auth/personal-access-tokens/:id`.

Supported MCP methods:

- `initialize`
- `tools/list`
- `tools/call`

Available tools include repository and task listing, task creation, subtask creation, draft updates, task starts, task messages, pull request linking, and task configuration updates.

Task agents receive the Verft MCP server automatically at runtime through an internal stdio bridge and a short-lived run token. Runtime task agents can call `verft_create_subtask` to create child tasks for the repository of the currently running parent task.

Checkpoint mutation, push/merge, attachments, terminal control, and summarization are intentionally deferred to later MCP phases.

## Automation API

External automation can create or continue a task with `POST /api/tasks/create-or-queue` using a Verft personal access token. See [Create-or-Queue Task API](docs/development/create-or-queue-api.md) for request shape, scopes, curl examples, and a GitHub Actions example.

Repositories can send signed outbound webhooks, including a `run_finished` event with each run's final message. See [Outbound Webhooks](docs/development/outbound-webhooks.md) for the payload and signature format.

## Common Commands

| Command | Description |
| --- | --- |
| `./verft init` | Build the agent toolbox runtime image, rebuild compose images, and start the stack. |
| `./verft start` | Start the Docker Compose stack in the background. |
| `./verft rebuild` | Rebuild the agent toolbox runtime and compose images using the build cache, then restart the stack. |
| `./verft rebuild --clean` | Pull base images, rebuild runtime and compose images without the build cache, then restart the stack. |
| `./verft update` | Fast-forward the current Git branch, rebuild using the build cache, and restart the stack. |
| `./verft stop` | Stop the Docker Compose stack. |
| `./scripts/harness/start.sh` | Start the development stack and wait for health. |

The health endpoint is available at:

```bash
curl -fsS http://localhost:3217/api/health
```

## Project Structure

```text
.
+-- apps/
|   +-- server/          # Backend API, orchestration, stores, routes, schedulers
|   +-- web/             # Next.js web app
+-- packages/
|   +-- shared-types/    # Shared TypeScript types used by server and web
+-- agent-runtime/       # Unified agent toolbox runtime
+-- tools/               # Supporting runtime and terminal tooling
+-- docs/                # Architecture, development, product, and quality docs
+-- scripts/harness/     # Canonical setup, check, test, and PR scripts
+-- task-workspaces/     # Runtime task workspaces; do not commit
+-- task-homes/          # Legacy task-home migration source; do not commit
+-- docker-compose.yml   # Local Docker stack
+-- verft                # Main stack helper script
```

## Development

For a clean developer checkout, initialize the stack and install npm dependencies:

```bash
HARNESS_INSTALL_NPM_DEPS=1 ./scripts/harness/setup.sh
```

Useful development commands:

| Command | Description |
| --- | --- |
| `./scripts/harness/doctor.sh` | Verify required tooling and harness availability. |
| `./scripts/harness/setup.sh` | Initialize the Docker stack and runtime folders. |
| `./scripts/harness/check.sh` | Run docs checks, boundary checks, lint, and build. |
| `./scripts/harness/test.sh` | Run the canonical test suite. |
| `./scripts/harness/pr-ready.sh` | Run pull request readiness checks. |
| `npm run dev` | Run server and web dev processes together. |
| `npm run lint` | Run TypeScript no-emit checks for server and web. |
| `npm run build` | Build shared types, server, and web. |
| `npm run test` | Run server and web tests. |

Workspace-specific commands:

```bash
npm run dev -w @verft/server
npm run dev -w @verft/web
npm run build -w @verft/shared-types
```

Before opening a pull request, run:

```bash
npm run ci
```

The repository uses execution-plan and human-gated-flow checks for non-trivial changes. Useful references:

- `docs/development/setup.md`
- `docs/development/commands.md`
- `docs/development/testing.md`
- `docs/development/pr-workflow.md`
- `docs/development/agent-review.md`

## FAQ

### Where do I configure API keys?

Configure GitHub, OpenAI, and Anthropic credentials in the Verft Settings UI. Credentials are write-only from the UI and are not returned by the API.

### Can I run without Docker?

The documented and supported path is Docker-based. Some server and web commands can run locally with Node.js, but the full task execution flow depends on Docker runtime containers.

### How do I reset local data?

Run setup with a database reset:

```bash
HARNESS_DB_RESET=1 ./scripts/harness/setup.sh
```

## Contributing

1. Read the relevant docs in `docs/index.md`.
2. Keep changes scoped and update docs when behavior changes.
3. Run the canonical checks before opening a pull request:

   ```bash
   npm run ci
   ```

4. Use the pull request template in `.github/pull_request_template.md`.

## License

No license file is currently present in this repository. Treat the code as private/proprietary unless a license is added by the project owner.
