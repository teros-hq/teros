# mca.teros.docker-env — Ephemeral Docker Environments

Manages ephemeral Docker environments tied to a workspace. Allows agents to spin up a full `docker-compose` stack directly from a local workspace directory, execute commands inside the environment, stream logs in real time, and destroy it when no longer needed.

The code is mounted directly — any change to the file is reflected in real time in the container (hot reload).

## Use Cases

- **Interactive development**: Nira modifies a file in `/workspace/my-project/`, the dev server detects the change and serves it instantly. The user opens the environment URL and sees the change.
- **Automated QA**: the agent spins up the environment, runs e2e tests with Playwright, parses results and creates tasks on the board with the failures.

## Tools

| Tool | Description |
|---|---|
| `env-create` | Uses a local workspace directory, brings up the docker-compose stack, returns envId and access URLs |
| `env-exec` | Executes a command inside a service of the environment (e.g. `npx playwright test`) |
| `env-logs` | Gets the last N log lines from a service |
| `env-list` | Lists the active environments for the user/workspace |
| `env-destroy` | Stops and removes the environment (does NOT delete the local directory) |
| `-health-check` | Verifies connectivity with the Docker socket |

## Parameters of `env-create`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `localPath` | string | ✅ | Absolute path to the workspace directory with the code. E.g.: `/workspace/teros-landing` |
| `composeFile` | string | ❌ | Path to the docker-compose file relative to `localPath` (default: `docker-compose.yml`) |
| `envVars` | object | ❌ | Additional environment variables to inject into the stack (key-value pairs) |
| `timeout` | number | ❌ | Timeout in seconds for `docker-compose up` (default: 120) |

### Behavior

- `localPath` is validated: it must exist and be a directory.
- The `workdir` of the environment **is** the `localPath` — nothing is copied or cloned.
- Since the code is mounted in the container (via the volumes in the user's `docker-compose.yml`), any file change is reflected in real time.
- No git clone, no credentials, no GitHub dependency.

## Architecture

### Implementation Phases

#### Phase 1 — PoC (current)
Docker socket mounted directly in the MCA container. Suitable for pre-prod (trusted environment). No proxy required.

```
MCA container
  └─ /var/run/docker.sock (volume mount)
     └─ Docker daemon on the host
```

#### Phase 2 — MVP with socket proxy
In production, [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) is used to limit the allowed operations:

```
MCA container
  └─ DOCKER_HOST=tcp://docker-proxy:2375
     └─ docker-socket-proxy (CONTAINERS=1, NETWORKS=1, IMAGES=1, DELETE=0)
        └─ /var/run/docker.sock
```

### User Isolation

Each environment lives in its own Docker network:
```
teros-env-{sanitizedUserId}-{envId}
```

The `userId` comes from the MCA execution context (`context.execution.userId`) — never from the agent. This guarantees that an agent cannot access another user's environments even if it tries.

### Networking

```
[Environment containers]  ←→  network: teros-env-{userId}-{envId}  (isolated)
                                         ↓ exposed web service
                                 network: teros-traefik-public
                                         ↓
                                 Traefik → env-{envId}.teros.ai
```

### State Persistence

Environment records are stored via `context.setData('envs', ...)` — the Teros backend persists this data scoped to the workspace. No external database is used.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Docker daemon socket or TCP |
| `DOCKER_ENV_DOMAIN` | `pre-os.teros.ai` | Base domain for access URLs |

## Deployment — Phase 1 (PoC pre-prod)

### Build

```bash
# From the monorepo root
docker build -f mcas/mca.teros.docker-env/Dockerfile -t mca-docker-env .
```

### Run

```bash
docker run -d \
  --name mca-docker-env \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /workspace:/workspace \
  -e DOCKER_HOST=unix:///var/run/docker.sock \
  -e DOCKER_ENV_DOMAIN=pre-os.teros.ai \
  mca-docker-env
```

> **Important:** the `/workspace` volume must be mounted so the MCA can access users' `localPath` directories.

### With docker-compose (integrated in the Teros stack)

```yaml
# In the server's docker-compose.yml
mca-docker-env:
  image: mca-docker-env:latest
  ports:
    - "3001:3000"
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
    - /workspace:/workspace
  environment:
    - DOCKER_HOST=unix:///var/run/docker.sock
    - DOCKER_ENV_DOMAIN=pre-os.teros.ai
  restart: unless-stopped
```

## Usage Example — Interactive Development

```
Agent: "I'll spin up the teros-landing environment for development"

1. env-create(localPath: "/workspace/teros-landing")
   → { envId: "a1b2c3d4", urls: { app: "https://env-a1b2c3d4.pre-os.teros.ai" } }

[User edits /workspace/teros-landing/src/app/page.tsx]
[The dev server detects the change and reloads automatically]

2. env-logs(envId: "a1b2c3d4", service: "app")
   → { logs: "... ready - started server on 0.0.0.0:3000 ..." }

3. env-destroy(envId: "a1b2c3d4")
   → { success: true, message: "Environment a1b2c3d4 destroyed" }
   [The /workspace/teros-landing directory is NOT deleted]
```

## Usage Example — QA Agent

```
Agent: "I'll run the e2e tests for the project"

1. env-create(localPath: "/workspace/my-app")
   → { envId: "a1b2c3d4", urls: { app: "https://env-a1b2c3d4.pre-os.teros.ai" } }

2. env-exec(envId: "a1b2c3d4", service: "playwright", command: "npx playwright test --reporter=json")
   → { exitCode: 1, stdout: "... 3 tests failed ..." }

3. [Parse results and create tasks on the board]

4. env-destroy(envId: "a1b2c3d4")
   → { success: true, message: "Environment a1b2c3d4 destroyed" }
```

## Roadmap

- [x] **Phase 1**: PoC with direct socket — `env-create`, `env-exec`, `env-logs`, `env-list`, `env-destroy`
- [x] **Refactor**: Removed git clone — workdir is always a workspace `localPath`
- [ ] **Phase 2**: Socket proxy (Tecnativa) + Traefik integration + automatic TTL
- [ ] **Phase 3**: "Environments" window in the UI (list, real-time logs, open button)
- [ ] **Phase 4**: Example QA agent with integrated Playwright
- [ ] **Phase 5**: Per-environment resource limits (CPU, memory, max time)
