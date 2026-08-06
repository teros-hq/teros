# Teros Admin MCA

Administrative tools for managing the Teros backend server.

## Features

- ⚙️ **Backend Status**: Get real-time server status, uptime, and resource usage
- 🔄 **Restart Backend**: Gracefully restart the backend server
- 📊 **System Monitoring**: Monitor MCA processes and backend health

## Tools

### `admin_backend_status`

Get current status of the Teros backend.

**Returns:**
```json
{
  "status": "running",
  "uptime": 12345.67,
  "memory": {
    "rss": 123456789,
    "heapTotal": 98765432,
    "heapUsed": 87654321,
    "external": 1234567
  },
  "pid": 12345,
  "nodeVersion": "v20.x.x",
  "platform": "linux",
  "mcaCount": 5,
  "timestamp": "2024-12-17T15:30:00.000Z"
}
```

### `admin_restart_backend`

Restart the Teros backend server gracefully.

**Parameters:**
- `confirm` (boolean, required): Must be `true` to proceed with restart

**Example:**
```json
{
  "confirm": true
}
```

**⚠️ Warning**: This will temporarily interrupt service while the backend restarts.

## Configuration

This MCA requires admin API access. The following environment variables are automatically injected:

- `MCA_ADMIN_API_URL`: Admin API endpoint URL
- `MCA_SECRET_ADMIN_API_KEY`: Admin API authentication key

## System App

This is a **system app** (`availability.system: true`), which means it's automatically provisioned for all agents.

## Security

- Requires admin API key for authentication
- All operations are logged
- Restart requires explicit confirmation

## Usage Examples

### Check Backend Status

```typescript
const status = await admin_backend_status({});
console.log(`Backend uptime: ${status.uptime} seconds`);
console.log(`Running MCAs: ${status.mcaCount}`);
```

### Restart Backend

```typescript
const result = await admin_restart_backend({ confirm: true });
console.log(result.message); // "Backend restart initiated"
```

## Development

### Testing Locally

```bash
cd mcas/mca.teros.admin
bun install
bun run src/index.ts
```

### Environment Setup

Ensure these environment variables are set:

```bash
export MCA_ADMIN_API_URL="http://localhost:3000"
export MCA_SECRET_ADMIN_API_KEY="your-admin-api-key"
```
