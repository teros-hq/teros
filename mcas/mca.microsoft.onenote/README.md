# Azure App Registration — Microsoft 365 MCA Suite

This document covers the Azure App Registration setup for all Microsoft 365 MCAs in Teros:
- **Outlook** (`mca.microsoft.outlook`) — already deployed
- **OneDrive** (`mca.microsoft.onedrive`) — new
- **Excel** (`mca.microsoft.excel`) — new
- **Word** (`mca.microsoft.word`) — new
- **OneNote** (`mca.microsoft.onenote`) — new

## Key Design Decision: One Azure App Registration for All

All five Microsoft 365 MCAs share a **single Azure App Registration** — the same `CLIENT_ID` and `CLIENT_SECRET`. Each MCA installation is configured and consented separately because the scopes differ per app, but the underlying app registration is one entity.

This means:
- You enter the same `CLIENT_ID` and `CLIENT_SECRET` for all 5 MCAs
- Each MCA requests only the scopes it needs during the OAuth consent flow
- Users can connect one MCA without granting scopes for the others

## Setup Steps

### 1. Create the App Registration

1. Go to [Azure Portal > App registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
3. Set name: **Teros Microsoft 365 Integration**
4. Set **Supported account types** to:
   - "Accounts in any organizational directory and personal Microsoft accounts"
   - (This allows both work/school and personal Microsoft accounts)
5. Set **Redirect URI**:
   - Platform: **Web**
   - URI: `https://your-domain/api/oauth/callback`
   - (Replace `your-domain` with your Teros instance domain, e.g. `os.teros.ai`)
6. Click **Register**

### 2. Configure API Permissions (Delegated)

In the app registration, go to **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**.

Add ALL of the following scopes (each MCA uses a subset):

| Scope | Used by | Purpose |
|-------|---------|---------|
| `openid` | All | OpenID Connect sign-in |
| `profile` | All | Access user profile |
| `email` | All | Access user email address |
| `offline_access` | All | Get refresh tokens |
| `User.Read` | All | Read user profile (basic) |
| `Mail.Read` | Outlook | Read user mail |
| `Mail.ReadWrite` | Outlook | Read and write user mail |
| `Mail.Send` | Outlook | Send mail as user |
| `Files.ReadWrite.All` | OneDrive, Excel, Word | Read and write all OneDrive files |
| `Sites.Read.All` | OneDrive | Read SharePoint sites |
| `Notes.ReadWrite.All` | OneNote | Read and write all OneNote notebooks |
| `Notes.Create` | OneNote | Create new OneNote notebooks and pages |

> **Note:** Adding all scopes to the app registration does NOT mean every user grants all of them. Each MCA requests only its specific scopes during the OAuth consent flow. The app registration must have all scopes pre-registered so they can be requested.

### 3. Create Client Secret

1. Go to **Certificates & secrets**
2. Click **New client secret**
3. Set description: "Teros MCA Suite"
4. Set expiry (recommended: 24 months)
5. **Copy the secret value** immediately (it's only shown once)

### 4. Configure System Secrets in Teros

For each MCA, set the following system secrets:

```
CLIENT_ID=<Application (client) ID from Azure>
CLIENT_SECRET=<Client secret value from step 3>
REDIRECT_URIS=["https://your-domain/api/oauth/callback"]
```

The `CLIENT_ID` and `CLIENT_SECRET` are the same for all 5 MCAs. Only the `REDIRECT_URIS` might differ if you have different domains.

### 5. User Connection Flow

When a user connects a Microsoft 365 MCA:
1. They click "Connect" in the Teros UI
2. They're redirected to Microsoft's consent page
3. They see only the scopes that specific MCA needs
4. After consent, tokens are stored as user secrets
5. The MCA can now make Graph API calls on their behalf

## Per-MCA Scope Summary

| MCA | Scopes (beyond common) | Tool Count |
|-----|------------------------|------------|
| Outlook | `Mail.Read`, `Mail.ReadWrite`, `Mail.Send` | 20 |
| OneDrive | `Files.ReadWrite.All`, `Sites.Read.All` | 20 |
| Excel | `Files.ReadWrite.All` | 20 |
| Word | `Files.ReadWrite.All` | 13 |
| OneNote | `Notes.ReadWrite.All`, `Notes.Create` | 15 |

## Token Refresh

All MCAs use the shared Graph client which:
- Proactively refreshes tokens when `EXPIRY_DATE` is within 60 seconds of expiring
- Reactively refreshes on a mid-flight 401 (one retry, then surfaces "reconnect" message)
- Persists refreshed tokens via `updateUserSecrets` so subsequent calls don't re-refresh
- Microsoft refresh tokens are valid for ~90 days of inactivity before expiring

## Troubleshooting

### "Missing scope" errors (403 accessDenied)
The error message names the specific missing scope. Reconnect the MCA to grant it. Ensure the scope is also registered in the Azure App Registration's API permissions.

### "Reconnect your account" (401 after refresh)
The refresh token has expired (90 days idle) or been revoked. The user must reconnect their Microsoft account.

### Throttling (429)
The Graph client automatically retries 429 responses with `Retry-After` header support and exponential backoff (up to 3 attempts). This is most common on the Excel workbook API and OneNote.
