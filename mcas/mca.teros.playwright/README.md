# mca.teros.playwright

Browser automation MCA powered by Playwright.

## Description

This MCA provides browser automation capabilities within the Teros MCA architecture. It enables web scraping, testing, and interaction with web pages.

## Features

- **Browser Navigation** - Navigate to URLs and control page flow
- **Element Interaction** - Click, type, fill forms, select options
- **Screenshots** - Capture full page or element screenshots
- **JavaScript Execution** - Run custom scripts in browser context
- **Network Monitoring** - Track requests and responses
- **Console Logging** - Access browser console messages
- **Tab Management** - Create, close, and switch between tabs

## Tools (22 total)

- `browser-navigate` - Navigate to a URL
- `browser-navigate-back` - Go back to previous page
- `browser-snapshot` - Get accessibility snapshot of the page
- `browser-click` - Click elements
- `browser-type` - Type text into elements
- `browser-fill-form` - Fill multiple form fields at once
- `browser-select-option` - Select dropdown options
- `browser-hover` - Hover over elements
- `browser-drag` - Drag and drop between elements
- `browser-press-key` - Press keyboard keys
- `browser-take-screenshot` - Take screenshots
- `browser-evaluate` - Execute JavaScript in page context
- `browser-run-code` - Run Playwright code snippets
- `browser-close` - Close the browser
- `browser-resize` - Resize browser window
- `browser-wait-for` - Wait for text, element, or time
- `browser-console-messages` - Get console logs
- `browser-network-requests` - Get network activity
- `browser-handle-dialog` - Handle alert/confirm/prompt dialogs
- `browser-file-upload` - Upload files
- `browser-tabs` - Manage browser tabs
- `browser-install` - Install browser binaries

## Saving Files (Screenshots, etc.)

When saving screenshots or other files, **always use the `/workspace` directory**. This is the shared volume accessible by all MCAs.

```
# ✅ Correct - saves to shared volume
browser-take-screenshot filename="/workspace/screenshot.png"

# ❌ Wrong - saves inside container, not accessible to other MCAs
browser-take-screenshot filename="/tmp/screenshot.png"
browser-take-screenshot filename="screenshot.png"
```

Files saved to `/workspace` can then be used by other MCAs like `messaging` to send images to the user.

## Type

System MCA - Shared browser automation infrastructure

## Configuration

No credentials required. Browser binaries are pre-installed in the Docker image.
