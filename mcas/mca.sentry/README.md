# Sentry MCA

Monitor errors, issues, and performance in your applications using the Sentry API.

## Features

- 🏢 List organizations and projects
- 🐛 List and search issues (errors/problems)
- 📋 Get detailed issue information
- 📊 List and view events (individual error occurrences)
- 🔍 Get full stack traces
- ✅ Resolve issues
- 🔕 Ignore issues

## Setup

### 1. Get your Sentry Auth Token

1. Go to [Sentry Auth Tokens](https://sentry.io/settings/account/api/auth-tokens/)
2. Click "Create New Token"
3. Select the following scopes:
   - `org:read` - To list organizations and projects
   - `project:read` - To read project data
   - `event:read` - To read events and issues
   - `event:write` - To resolve/ignore issues
4. Copy the token

### 2. Configure credentials

Create the credentials file at `.secrets/mcas/mca.teros.sentry/credentials.json`:

```json
{
  "apiKey": "sntryu_xxxxx..."
}
```

### 3. Self-hosted Sentry (optional)

If using a self-hosted Sentry instance, set the `SENTRY_BASE_URL` environment variable:

```bash
export SENTRY_BASE_URL="https://your-sentry-instance.com"
```

## Tools

| Tool | Description |
|------|-------------|
| `sentry_list-organizations` | List all organizations you have access to |
| `sentry_list-projects` | List all projects in an organization |
| `sentry_list-issues` | List issues with optional filters (status, query) |
| `sentry_get-issue` | Get detailed information about a specific issue |
| `sentry_list-events` | List events for an issue |
| `sentry_get-event` | Get full event details including stack trace |
| `sentry_resolve-issue` | Mark an issue as resolved |
| `sentry_ignore-issue` | Ignore an issue (stop notifications) |

## Usage Examples

### List unresolved issues
```
sentry_list-issues(organization: "my-org", query: "is:unresolved")
```

### Get issue details
```
sentry_get-issue(issueId: "12345")
```

### Get event with stack trace
```
sentry_get-event(organization: "my-org", project: "my-project", eventId: "abc123")
```

### Resolve an issue
```
sentry_resolve-issue(issueId: "12345")
```
