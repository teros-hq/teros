# GitHub MCA

Integrate GitHub repositories, issues, pull requests, actions, and more into Teros.

## Features

- **Repository Management**: List, get, and create repositories
- **Issues**: Create, update, list, and comment on issues
- **Pull Requests**: Create, merge, and manage pull requests
- **Branches**: Create and manage branches
- **Commits**: View commit history and details
- **GitHub Actions**: List workflows, view runs, and trigger workflows
- **File Operations**: Read and write files in repositories
- **Search**: Search repositories and code across GitHub

## Setup

### 1. Create a GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Or visit: https://github.com/settings/tokens

2. Click "Generate new token" → "Generate new token (classic)"

3. Give your token a descriptive name (e.g., "Teros Integration")

4. Select the following scopes:
   - `repo` - Full control of private repositories
   - `workflow` - Update GitHub Action workflows
   - `read:org` - Read org and team membership (if working with organizations)
   - `user` - Read user profile data

5. Click "Generate token"

6. **Copy the token immediately** - you won't be able to see it again!

### 2. Configure in Teros

Add your token to the GitHub app configuration in Teros:

- `GITHUB_TOKEN`: Your personal access token

Optionally, you can set:
- `GITHUB_DEFAULT_OWNER`: Default GitHub username or organization (saves you from typing it every time)

## Usage Examples

### List Repositories

```javascript
// List your repositories
github-list-repos({ owner: "your-username" })

// List organization repositories
github-list-repos({ owner: "your-org", type: "all" })
```

### Create an Issue

```javascript
github-create-issue({
  owner: "your-username",
  repo: "your-repo",
  title: "Bug: Something is broken",
  body: "Detailed description of the issue...",
  labels: ["bug", "high-priority"]
})
```

### Create a Pull Request

```javascript
github-create-pull({
  owner: "your-username",
  repo: "your-repo",
  title: "feat: Add new feature",
  body: "This PR adds...",
  head: "feature-branch",
  base: "main"
})
```

### Trigger a Workflow

```javascript
github-trigger-workflow({
  owner: "your-username",
  repo: "your-repo",
  workflow_id: "deploy.yml",
  ref: "main",
  inputs: {
    environment: "production"
  }
})
```

### Search Code

```javascript
github-search-code({
  query: "addClass in:file language:js repo:jquery/jquery"
})
```

## Available Tools

### Repository Management
- `github-list-repos` - List repositories for a user or organization
- `github-get-repo` - Get detailed information about a repository
- `github-create-repo` - Create a new repository

### Issues
- `github-list-issues` - List issues with filters
- `github-get-issue` - Get issue details
- `github-create-issue` - Create a new issue
- `github-update-issue` - Update an existing issue
- `github-add-issue-comment` - Add a comment to an issue

### Pull Requests
- `github-list-pulls` - List pull requests
- `github-get-pull` - Get pull request details
- `github-create-pull` - Create a new pull request
- `github-merge-pull` - Merge a pull request

### Branches
- `github-list-branches` - List branches in a repository
- `github-get-branch` - Get branch information
- `github-create-branch` - Create a new branch

### Commits
- `github-list-commits` - List commits in a repository
- `github-get-commit` - Get commit details

### GitHub Actions
- `github-list-workflows` - List workflows in a repository
- `github-list-workflow-runs` - List workflow runs
- `github-trigger-workflow` - Trigger a workflow dispatch event

### File Operations
- `github-get-file-content` - Get file content from a repository
- `github-create-or-update-file` - Create or update a file

### Search
- `github-search-repos` - Search for repositories
- `github-search-code` - Search for code across GitHub

### User
- `github-get-user` - Get user information

## Security Notes

- Your GitHub token has access to your repositories and can perform actions on your behalf
- Keep your token secure and never share it
- Use fine-grained permissions when possible
- Regularly rotate your tokens
- Revoke tokens that are no longer needed

## Troubleshooting

### "Bad credentials" error
- Check that your token is correct and hasn't expired
- Ensure the token has the necessary scopes

### "Not Found" error
- Verify the repository owner and name are correct
- Check that the token has access to the repository (especially for private repos)

### Rate Limiting
- GitHub API has rate limits (5,000 requests/hour for authenticated requests)
- The MCA will return rate limit information in error messages

## Links

- [GitHub REST API Documentation](https://docs.github.com/en/rest)
- [GitHub Personal Access Tokens](https://github.com/settings/tokens)
- [GitHub API Rate Limits](https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting)
