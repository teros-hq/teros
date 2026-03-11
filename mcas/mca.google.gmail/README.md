# Gmail MCA

Gmail email management - send, read, search, label, and filter emails via Google Gmail API.

## Features

- List, read, and search emails
- Send emails with attachments
- Reply to emails
- Manage labels (create, update, delete)
- Manage filters (create, delete)
- Download attachments
- Draft management (create, update, delete)

## Configuration

### System Secrets (Admin)

These are configured by the system administrator:

- `CLIENT_ID` - Google OAuth Client ID
- `CLIENT_SECRET` - Google OAuth Client Secret
- `REDIRECT_URIS` - JSON array of redirect URIs

### User Secrets (OAuth)

These are obtained automatically via the OAuth flow:

- `ACCESS_TOKEN` - User's access token
- `REFRESH_TOKEN` - User's refresh token
- `EMAIL` - User's email address
- `EXPIRY_DATE` - Token expiry timestamp

## Deployment

This MCA uses `per-app` deployment, meaning each installed app gets its own process instance. This allows multiple Gmail accounts to be used simultaneously.

## Tools

### Messages
- `list-messages` - List emails from inbox or labels
- `get-message` - Get full email details
- `send-message` - Send an email
- `reply-message` - Reply to an email
- `search-messages` - Search emails
- `modify-labels` - Add/remove labels from a message

### Drafts
- `list-drafts` - List draft emails
- `create-draft` - Create a draft
- `update-draft` - Update a draft
- `delete-draft` - Delete a draft

### Attachments
- `get-attachment` - Get attachment content
- `store-attachment` - Save attachment to disk

### Labels
- `list-labels` - List all labels
- `create-label` - Create a label
- `update-label` - Update a label
- `delete-label` - Delete a label

### Filters
- `list-filters` - List all filters
- `create-filter` - Create a filter
- `delete-filter` - Delete a filter

### Health
- `-health-check` - Verify OAuth credentials and connectivity
