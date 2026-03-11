# ⚠️ IMPORTANT — Security Concerns & Production Status

## Current Status: NOT SAFE FOR PRODUCTION

This MCA **must remain disabled in production** until the security issues described below are resolved.

---

## Security Vulnerabilities

### 1. Container Name Conflicts (`container_name`)
A user's `docker-compose.yml` can declare `container_name: teros-mongodb` (or any other existing container name), which causes Docker to **stop and replace the production container** with the user's version. This can take down the entire platform.

### 2. Port Binding Conflicts (`ports`)
Services declaring `ports: - "127.0.0.1:27017:27017"` will fail if the port is already in use — or worse, succeed and expose internal services externally.

### 3. Privileged Containers (`privileged: true`)
A container running with `privileged: true` has full access to the host kernel. A user could escape the container and compromise the entire host.

### 4. Host Network Access (`network_mode: host`)
Gives the container direct access to the host's network stack, bypassing all Docker network isolation. The container can reach any service on the host or local network.

### 5. Host PID Namespace (`pid: host`)
Allows the container to see and signal all processes on the host.

### 6. Absolute Volume Mounts
A `docker-compose.yml` with `volumes: - /etc:/etc` or `volumes: - /data/volumes:/data/volumes` gives the container read/write access to arbitrary host paths, including production data.

### 7. Shared Docker Daemon
All user environments share the **same Docker daemon** as production. There is no isolation boundary between a user's containers and the platform's own containers (MongoDB, backend, Caddy, etc.).

---

## Proposed Solution: Firecracker MicroVMs

The correct long-term fix is to run each user environment inside a **Firecracker microVM**. This provides true isolation at the kernel level.

### Why Firecracker
- Each env gets its own Linux kernel — no shared kernel with the host
- Each env gets its own Docker daemon — users can use `privileged`, `ports`, `volumes` freely without affecting anyone else
- VMs boot in ~125ms (used by AWS Lambda and Fargate)
- Networking via TAP devices + host routing, compatible with the existing Caddy setup

### Implementation Outline

1. **Install Firecracker** on the host (`/usr/bin/firecracker`)
2. **Build a minimal rootfs** (Alpine-based) with Docker daemon pre-installed
3. **VM lifecycle service** — a new backend service that:
   - Allocates a TAP network interface per VM
   - Assigns an internal IP (e.g. `10.env.x.x`)
   - Boots a Firecracker VM with the user's workspace volume mounted
   - Returns the VM's IP for Caddy routing
4. **Replace `runBuildInBackground()`** in this MCA to SSH into the VM and run `docker compose up` there instead of on the host
5. **Caddy routing** — same as today, but pointing to the VM's IP instead of a container IP

### Short-term Mitigation (before Firecracker)

If Firecracker is not yet ready, a partial mitigation can be applied by sanitizing the compose file before execution:
- Strip `container_name` from all services
- Strip `ports` (access via internal IP only, routed by Caddy)
- Block `privileged: true`
- Block `network_mode: host` and `pid: host`
- Block absolute path volume mounts (only named volumes allowed)

This breaks some legitimate use cases but prevents the most critical attacks.

---

## How to Disable in Production

In the MCA manifest (`manifest.json`), set:

```json
{
  "availability": "admin_only"
}
```

Or remove agent access grants to `mca.teros.docker-env` for all non-admin users until the Firecracker implementation is complete.

---

*Last updated: 2026-03-04 — Alice Evergreen*
