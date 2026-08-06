# 🏠 Homey MCA

> Control your smart home via Athom Cloud API

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Type](https://img.shields.io/badge/type-integration-green)
![Auth](https://img.shields.io/badge/auth-OAuth2-orange)

---

## Features

- **Device Control** — List, inspect, and control all devices connected to your Homey hub (on/off, brightness, temperature, etc.)
- **Flow Management** — List and trigger Homey flows (automations) remotely
- **Zone Discovery** — Browse all configured zones (rooms/areas) in your home
- **Device Renaming** — Rename devices directly from the agent
- **User Info** — Retrieve authenticated user details from Homey
- **OAuth2 Authentication** — Secure connection to Athom Cloud using industry-standard OAuth2

---

## Setup / Configuration

### Prerequisites

1. A **Homey** hub (any model supported by Athom Cloud)
2. An **Athom Developer** account with a registered OAuth2 application

### 1. Register an OAuth2 App

Go to [Athom Developer Tools](https://tools.developer.athom.com/) and create a new OAuth2 application:

- Set the **Redirect URI** to the Teros OAuth2 callback URL (provided in the Teros admin panel)
- Note down the **Client ID** and **Client Secret**

### 2. Configure System Secrets

A Teros platform administrator must configure the following **system secrets** for this MCA:

| Secret          | Description                                  |
| --------------- | -------------------------------------------- |
| `CLIENT_ID`     | OAuth2 Client ID from Athom Developer Tools  |
| `CLIENT_SECRET` | OAuth2 Client Secret from Athom Developer Tools |

### 3. Connect Your Account

End users connect their Homey account through the Teros UI via the standard OAuth2 flow. This automatically stores the following **user secrets**:

| Secret          | Description                          |
| --------------- | ------------------------------------ |
| `ACCESS_TOKEN`  | OAuth2 access token                  |
| `REFRESH_TOKEN` | OAuth2 refresh token                 |
| `TOKEN_TYPE`    | Token type (defaults to `bearer`)    |
| `EXPIRES_IN`    | Token expiration time in seconds     |

### 4. Required Scopes

The OAuth2 application must request the following scopes:

| Scope                    | Purpose                              |
| ------------------------ | ------------------------------------ |
| `homey.app`              | App access                           |
| `homey.app.control`      | App control                          |
| `homey.dashboard`        | Dashboard access                     |
| `homey.device`           | Device read access                   |
| `homey.device.control`   | Device control (on/off, dim, etc.)   |
| `homey.energy`           | Energy monitoring                    |
| `homey.flow`             | Flow read access                     |
| `homey.flow.start`       | Flow triggering                      |
| `homey.geolocation`      | Geolocation access                   |
| `homey.insights`         | Insights data                        |
| `homey.logic`            | Logic variables                      |
| `homey.mood`             | Mood read access                     |
| `homey.mood.set`         | Mood control                         |
| `homey.notifications`    | Notifications access                 |
| `homey.presence`         | Presence detection                   |
| `homey.presence.self`    | Self presence                        |
| `homey.system`           | System information                   |
| `homey.user`             | User access                          |
| `homey.user.self`        | Self user info                       |
| `homey.zone`             | Zone (room) access                   |

---

## Available Tools

### `-health-check`

Internal health check tool. Verifies Homey API credentials and connectivity.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

**Example:**
```
→ -health-check
← { status: "healthy", version: "1.0.0", metadata: { connected: true, userCount: 2 } }
```

---

### `homey-get-user`

Get authenticated user information from Homey.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

**Example:**
```
→ homey-get-user
← { "user_id_1": { "name": "John", "role": "owner", ... }, ... }
```

---

### `homey-list-devices`

List all devices connected to Homey with their zone, class, capabilities, and availability status.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

**Example:**
```
→ homey-list-devices
← [
    {
      "id": "abc123",
      "name": "Living Room Light",
      "zoneName": "Living Room",
      "class": "light",
      "capabilities": ["onoff", "dim"],
      "available": true
    },
    ...
  ]
```

---

### `homey-get-device`

Get detailed information and current state of a specific Homey device by ID.

| Parameter   | Type   | Required | Description |
| ----------- | ------ | -------- | ----------- |
| `device_id` | string | ✅       | Device ID   |

**Example:**
```
→ homey-get-device { "device_id": "abc123" }
← { "id": "abc123", "name": "Living Room Light", "zoneName": "Living Room", "capabilitiesObj": { "onoff": { "value": true }, "dim": { "value": 0.75 } }, ... }
```

---

### `homey-set-capability`

Set a device capability value (e.g., turn on/off, set brightness, temperature). Use `homey-list-devices` to find device IDs and capabilities.

| Parameter    | Type   | Required | Description                                                                    |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------ |
| `device_id`  | string | ✅       | Device ID                                                                      |
| `capability` | string | ✅       | Capability name (e.g., `onoff`, `dim`, `target_temperature`)                   |
| `value`      | any    | ✅       | Value to set (`boolean` for onoff, `number` 0–1 for dim, `number` for temperature) |

**Example — Turn off a light:**
```
→ homey-set-capability { "device_id": "abc123", "capability": "onoff", "value": false }
← { "success": true, "device_id": "abc123", "capability": "onoff", "value": false, "message": "Capability 'onoff' set to 'false' on device 'Living Room Light'" }
```

**Example — Set brightness to 50%:**
```
→ homey-set-capability { "device_id": "abc123", "capability": "dim", "value": 0.5 }
← { "success": true, ... }
```

---

### `homey-list-flows`

List all flows (automations) configured in Homey.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

**Example:**
```
→ homey-list-flows
← [
    { "id": "flow_1", "name": "Good Morning", "enabled": true, "folder": null },
    { "id": "flow_2", "name": "Away Mode", "enabled": true, "folder": "Security" },
    ...
  ]
```

---

### `homey-trigger-flow`

Trigger (run) a Homey flow by its ID.

| Parameter | Type   | Required | Description        |
| --------- | ------ | -------- | ------------------ |
| `flow_id` | string | ✅       | Flow ID to trigger |

**Example:**
```
→ homey-trigger-flow { "flow_id": "flow_1" }
← { "success": true, "flow_id": "flow_1", "flow_name": "Good Morning", "message": "Flow triggered successfully" }
```

---

### `homey-list-zones`

List all zones (rooms/areas) configured in Homey.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

**Example:**
```
→ homey-list-zones
← [
    { "id": "zone_1", "name": "Living Room", "parent": null, "icon": "living_room" },
    { "id": "zone_2", "name": "Bedroom", "parent": null, "icon": "bedroom" },
    ...
  ]
```

---

### `homey-rename-device`

Rename a Homey device.

| Parameter   | Type   | Required | Description              |
| ----------- | ------ | -------- | ------------------------ |
| `device_id` | string | ✅       | Device ID                |
| `name`      | string | ✅       | New name for the device  |

**Example:**
```
→ homey-rename-device { "device_id": "abc123", "name": "Desk Lamp" }
← { "success": true, "device_id": "abc123", "old_name": "Living Room Light", "new_name": "Desk Lamp", ... }
```

---

## Architecture

### Request Flow

```
┌──────────────┐     ┌──────────────┐     ┌───────────────────┐     ┌────────────┐
│  Teros Agent │────▶│  Homey MCA   │────▶│  Athom Cloud API  │────▶│  Homey Hub │
│  (LLM call)  │     │  (per-app)   │     │  (api.athom.com)  │     │  (local)   │
└──────────────┘     └──────────────┘     └───────────────────┘     └────────────┘
```

1. **Teros Agent** receives a user request (e.g., "turn off the living room light")
2. **Homey MCA** translates the tool call into Athom Cloud API requests using the `homey-api` SDK
3. **Athom Cloud API** relays the command to the user's Homey hub
4. **Homey Hub** executes the action on the physical device

### Runtime Model

- **Container mode:** `per-app` — each installed app instance gets its own isolated process
- **Transport:** HTTP on port 3000
- **Health endpoint:** `/health`

### Caching Strategy

The MCA implements two levels of in-memory caching to reduce API calls:

| Cache            | Scope           | Invalidation                          |
| ---------------- | --------------- | ------------------------------------- |
| **API instance** | Homey API client | Cached until process restart or health check (which forces re-init) |
| **Zones**        | Zone list data   | Reset on API re-initialization        |

Both caches are **in-memory only** and live for the lifetime of the MCA process. There is no TTL-based expiration or real-time invalidation.

### Secrets Model

Secrets are fetched on-demand from the Teros backend via the MCA SDK's `context` object:

| Type              | Secrets                                                  | Managed By     |
| ----------------- | -------------------------------------------------------- | -------------- |
| **System secrets** | `CLIENT_ID`, `CLIENT_SECRET`                            | Platform admin |
| **User secrets**   | `ACCESS_TOKEN`, `REFRESH_TOKEN`, `TOKEN_TYPE`, `EXPIRES_IN` | OAuth2 flow    |

System secrets are shared across all installations of this MCA. User secrets are unique per installed app instance.

---

## Limitations / Known Issues

| Issue | Description |
| ----- | ----------- |
| **Manual token refresh** | The MCA does not automatically refresh expired OAuth2 tokens. If the access token expires, the user may need to re-authenticate via the Teros UI. |
| **No real-time cache invalidation** | The API instance and zone caches are only invalidated on process restart or explicit health check. Changes made outside the MCA (e.g., adding a new zone in the Homey app) won't be reflected until the cache is cleared. |
| **Direct API for rename** | `homey-rename-device` uses a direct HTTP `PUT` request to the Homey local API instead of the `homey-api` SDK, because the SDK does not expose an `updateDevice` method. This bypasses the SDK's abstraction layer. |

---

## Development

### Project Structure

```
mcas/mca.homey/
├── manifest.json       # MCA metadata, auth config, scopes
├── tools.json          # Auto-generated tool definitions (do NOT edit manually)
├── package.json        # Dependencies (homey-api, @teros/mca-sdk)
├── src/
│   └── index.ts        # Main source — all tools defined here
└── static/
    └── icon.png        # MCA icon
```

### Making Changes

1. Edit `src/index.ts` to add or modify tools
2. Run `npm run sync` from the monorepo root to regenerate `tools.json` from the source
3. Restart the MCA process for changes to take effect

### Testing

Use the `-health-check` tool to verify:
- System secrets are configured (`CLIENT_ID`, `CLIENT_SECRET`)
- User has connected their Homey account (`ACCESS_TOKEN`, `REFRESH_TOKEN`)
- API connectivity to Athom Cloud and the Homey hub is working

```
→ -health-check
← { status: "healthy", version: "1.0.0", issues: [], metadata: { connected: true } }
```

### Dependencies

| Package                      | Purpose                          |
| ---------------------------- | -------------------------------- |
| `homey-api` (^3.5.0)        | Athom Cloud / Homey SDK          |
| `@teros/mca-sdk` (0.1.0)    | Teros MCA framework              |
| `@modelcontextprotocol/sdk`  | MCP protocol support             |

---

## License

Internal — Teros Platform
