# Google Drive MCA - Migration Guide

## 🎯 **Objective**

Migrate the Google Drive MCA from the old pattern (standalone MCP) to the modern pattern (MCP + SDK WebSocket + integrated OAuth).

## 📋 **Summary of Changes**

### 🔄 **Directory Structure**
```
BEFORE                         AFTER
├── mcp/                       └── src/
│   ├── index.ts                    ├── index.ts
│   └── src/                      └── auth-server.ts
│       └── index.ts               
└── credentials.json             └── src/
```

### 🏗️ **Added Components**

#### **1. Modernized Manifest**
- ✅ OAuth2 configured with Google Drive scopes
- ✅ Support for multiple instances (`multi: true`)
- ✅ Secrets defined: `CLIENT_ID`, `CLIENT_SECRET`, `ACCESS_TOKEN`, `REFRESH_TOKEN`
- ✅ Entry point updated to `./src/index.ts`

#### **2. Auth Server (New)**
- ✅ HTTP server for local OAuth flow (optional)
- ✅ Endpoints: `/auth/connect`, `/auth/callback`, `/auth/status`
- ✅ Automatic token handling and refresh

#### **3. SDK Integration**
- ✅ `@teros/mca-sdk` for secrets management
- ✅ WebSocket client for bidirectional communication
- ✅ Standardized health checks
- ✅ Backend secrets caching

#### **4. Tools with Dynamic Prefixes**
- ✅ Prefix based on `MCA_APP_NAME` (e.g. `google-drive-`)
- ✅ Health check: `${prefix}health-check`
- ✅ All tools with consistent prefixes

## 🔧 **Modern Architecture**

### **Authentication Flow**
```
1. Backend → MCA (WebSocket) → Secrets
2. User → Auth URL → Google OAuth
3. Google → Callback → Auth Server → Tokens
4. Auth Server → Backend → MongoDB (user_credentials)
```

### **Current Dependencies**
```json
{
  "@modelcontextprotocol/sdk": "^1.20.2",
  "googleapis": "^164.1.0", 
  "google-auth-library": "latest",
  "@teros/mca-sdk": "0.1.0",
  "@teros/shared": "2.0.0"
}
```

## 🛠️ **Available Tools**

| Tool | Description |
|------------|-------------|
| `health-check` | Verifies OAuth and connectivity |
| `list-files` | Lists files/folders with filters |
| `get-file` | Gets file/folder information |
| `download-file` | Downloads files from Drive |
| `upload-file` | Uploads files to Drive |
| `create-folder` | Creates folders |
| `delete-file` | Deletes files/folders |
| `share-file` | Shares files with permissions |
| `read-spreadsheet` | Reads Google Sheets |
| `read-presentation` | Reads Google Slides |
| `read-document` | Reads Google Docs |

## 🧪 **Testing**

### **Connection Verification**
```bash
# Previous test showed:
✅ WebSocket connected successfully
✅ MCP server started successfully  
✅ App ID: app_cbc12f0408ef4dab
✅ Auth URL: https://be.teros.ai/auth/mca/app_cbc12f0408ef4dab/connect
```

### **Environment Variables**
- `MCA_APP_ID`: Instance ID (injected by backend)
- `MCA_APP_NAME`: Name for prefixes (default: "google-drive")
- `MCA_HTTP_PORT`: Auth server port (optional)
- `MCA_LOCAL_AUTH`: Enable local auth server (default: false)

## 🚀 **Next Steps**

### **For Production**
1. Configure OAuth credentials in `.secrets/mcas/mca.google.drive/credentials.json`
2. Test complete authorization flow
3. Verify all tools work
4. Test automatic token refresh

### **Comparison with Existing Patterns**

| Feature | Gmail ✅ | Linear ✅ | Drive ✅ (NEW) |
|---------------|-----------|-----------|-------------------|
| SDK WebSocket | ✅ | ✅ | ✅ |
| Integrated OAuth | ✅ | ❌ | ✅ |
| Multi-instance | ✅ | ❌ | ✅ |
| Auth Server | ✅ | ❌ | ✅ |
| Health Checks | ✅ | ✅ | ✅ |
| Dynamic Prefixes | ✅ | ✅ | ✅ |

## 🎉 **Result**

Google Drive now follows the same modern pattern as Gmail and Linear:
- ✅ Consistent architecture
- ✅ Secure authentication
- ✅ Multi-instance supported
- ✅ Standardized health checks
- ✅ Full integration with Teros backend
