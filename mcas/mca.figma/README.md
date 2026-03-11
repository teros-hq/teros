# Figma MCA

Access Figma design files, extract styles, components, design tokens, and export assets directly from your AI assistant.

## Features

- 📁 **File Access**: Get file structure, pages, frames, and components
- 🎨 **Style Extraction**: Extract colors, typography, effects, and grids
- 🔤 **Design Tokens**: Access Figma variables (design tokens) by collection
- 🧩 **Components**: List and inspect components and variants
- 📤 **Export**: Export nodes as PNG, JPG, SVG, or PDF
- 💬 **Comments**: Read file comments
- 🗂️ **Projects**: Browse team projects and files

## Setup

### 1. Generate a Personal Access Token

1. Go to your Figma account settings
2. Navigate to **Security** > **Personal Access Tokens**
3. Click **Generate new token**
4. Give it a name (e.g., "Teros AI")
5. Copy the token (starts with `figd_`)

### 2. Configure the MCA

Add your token to the credentials file:

```json
// .secrets/mcas/mca.figma/credentials.json
{
  "PERSONAL_ACCESS_TOKEN": "figd_your_token_here"
}
```

## Tools

### File Operations

| Tool | Description |
|------|-------------|
| `figma_get-file` | Get file structure with configurable depth |
| `figma_get-file-styles` | List all styles (colors, text, effects) |
| `figma_get-file-variables` | Get design tokens/variables |
| `figma_get-node` | Get details of a specific node |
| `figma_get-components` | List all components |
| `figma_get-component-sets` | List component sets (variants) |
| `figma_export-images` | Export nodes as images |
| `figma_get-comments` | Get file comments |

### Team/Project Operations

| Tool | Description |
|------|-------------|
| `figma_get-team-projects` | List projects in a team |
| `figma_get-project-files` | List files in a project |

### Design Extraction

| Tool | Description |
|------|-------------|
| `figma_extract-colors` | Extract colors as CSS/Tailwind/JSON |
| `figma_extract-typography` | Extract typography as CSS/Tailwind/JSON |

## Usage Examples

### Get a file's structure
```
Use figma_get-file with fileKey "ABC123xyz" and depth 3
```

### Extract colors for Tailwind
```
Use figma_extract-colors with fileKey "ABC123xyz" and format "tailwind"
```

### Export a frame as SVG
```
Use figma_export-images with fileKey "ABC123xyz", nodeIds ["1:234"], format "svg"
```

## Finding File Keys and Node IDs

- **File Key**: The part after `/file/` in the Figma URL
  - URL: `https://www.figma.com/file/ABC123xyz/My-Design`
  - File Key: `ABC123xyz`

- **Node ID**: Found in URL after `?node-id=` or in tool responses
  - URL: `...?node-id=1-234`
  - Node ID: `1:234` or `1-234` (both formats work)

## Output Formats

### CSS Output
```css
:root {
  --color-1: #FF5733;
  --color-2: #33FF57;
}
```

### Tailwind Output
```js
// tailwind.config.js colors
{
  "color-1": "#FF5733",
  "color-2": "#33FF57"
}
```

## API Rate Limits

Figma API has rate limits. If you encounter errors, wait a moment before retrying.

## Resources

- [Figma REST API Documentation](https://www.figma.com/developers/api)
- [Personal Access Tokens](https://www.figma.com/developers/api#access-tokens)
- [Figma Variables](https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-variables-in-Figma)
