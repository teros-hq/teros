# Google Forms MCA

Google Forms integration for Teros. Create forms, manage questions, and read responses via the Google Forms API v1.

## Features

- **Create Forms** — Create new Google Forms with title and document title
- **Get Form** — Retrieve form structure including all items and questions
- **Update Form** — Add, edit, or delete questions using batch update requests
- **List Forms** — List all Google Forms in your Drive
- **List Responses** — Retrieve form responses with optional filtering
- **Get Response** — Get a specific response by ID

## Authentication

This MCA uses Google OAuth2. You'll need to connect your Google account with the following scopes:

- `https://www.googleapis.com/auth/forms.body` — Create and edit forms
- `https://www.googleapis.com/auth/forms.responses.readonly` — Read form responses
- `https://www.googleapis.com/auth/drive.file` — List forms in Drive
- `https://www.googleapis.com/auth/userinfo.email` — Identify the connected account

## Setup

1. Install the MCA from the Teros catalog
2. Connect your Google account via OAuth
3. Start creating and managing forms

## Update Form Requests

The `update-form` tool uses the Google Forms API batch update format. Supported request types:

- **`createItem`** — Add a new question or content item
- **`updateItem`** — Modify an existing item
- **`deleteItem`** — Remove an item from the form
- **`updateFormInfo`** — Update form title, description, etc.
- **`updateSettings`** — Change form settings (quiz mode, response collection, etc.)

See the [Google Forms API documentation](https://developers.google.com/forms/api/reference/rest/v1/forms/batchUpdate) for full request schemas.
