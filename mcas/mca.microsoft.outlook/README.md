# Outlook MCA

Microsoft Outlook email management via Microsoft Graph API.

## Features

- **Messages**: List, read, send, reply, forward, search, delete
- **Drafts**: Create, update, send, delete drafts
- **Folders**: List, create, delete mail folders
- **Organization**: Mark read/unread, set importance, categorize, flag, move messages
- **Attachments**: Download and store email attachments
- **Rules**: List inbox rules
- **Auto Markdown**: Automatically converts Markdown to styled HTML emails

## Setup

### 1. Register Azure AD Application

1. Go to [Azure Portal > App registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
3. Set name (e.g., "Teros Outlook Integration")
4. Set **Supported account types** to "Accounts in any organizational directory and personal Microsoft accounts"
5. Set **Redirect URI** to your callback URL (e.g., `https://your-domain/api/oauth/callback`)
6. Click **Register**

### 2. Configure API Permissions

In the app registration:
1. Go to **API permissions**
2. Add the following **Delegated permissions** for Microsoft Graph:
   - `Mail.Read`
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `User.Read`
   - `openid`
   - `profile`
   - `email`
   - `offline_access`

### 3. Create Client Secret

1. Go to **Certificates & secrets**
2. Click **New client secret**
3. Copy the secret value

### 4. Configure System Secrets

Set the following system secrets for the MCA:
- `CLIENT_ID`: Application (client) ID from Azure
- `CLIENT_SECRET`: Client secret value
- `REDIRECT_URIS`: JSON array with your redirect URI

## OAuth Scopes

| Scope | Purpose |
|-------|---------|
| `openid` | OpenID Connect sign-in |
| `profile` | Access user profile |
| `email` | Access user email address |
| `offline_access` | Get refresh tokens |
| `Mail.Read` | Read user mail |
| `Mail.ReadWrite` | Read and write user mail |
| `Mail.Send` | Send mail as user |
| `User.Read` | Read user profile |

## Tools

| Tool | Description |
|------|-------------|
| `list-messages` | List messages from inbox or specific folder |
| `get-message` | Get full message details including body and attachments |
| `send-message` | Send an email with optional attachments |
| `reply-message` | Reply or reply-all to a message |
| `forward-message` | Forward a message to other recipients |
| `search-messages` | Search messages by text |
| `modify-message` | Mark read/unread, set importance, categorize, flag |
| `move-message` | Move message to a different folder |
| `delete-message` | Delete or permanently delete a message |
| `list-drafts` | List draft emails |
| `create-draft` | Create a new draft |
| `update-draft` | Update an existing draft |
| `send-draft` | Send a draft |
| `delete-draft` | Delete a draft |
| `list-folders` | List all mail folders |
| `create-folder` | Create a new mail folder |
| `delete-folder` | Delete a mail folder |
| `get-attachment` | Get attachment content |
| `store-attachment` | Download attachment to filesystem |
| `list-rules` | List inbox rules |
