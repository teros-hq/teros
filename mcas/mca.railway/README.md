# Railway MCA

Deploy projects to Railway directly from Teros workspaces.

## Features

- **Project Management**: Create, list, and delete Railway projects
- **Environment Management**: Create staging/production environments
- **Service Management**: Create and manage services
- **Variable Management**: Set environment variables for services
- **Deployment Tracking**: Monitor deployment status
- **Domain Management**: Create and list domains
- **Volume Support**: Create persistent volumes for databases

## Setup

1. Get your Railway API token from https://railway.app/account/tokens
2. Install this MCA in Teros
3. Configure `RAILWAY_TOKEN` in your app settings

## Tools

### Projects
- `railway-list-projects` - List all projects
- `railway-get-project` - Get project details
- `railway-create-project` - Create a new project
- `railway-delete-project` - Delete a project

### Environments
- `railway-list-environments` - List environments in a project
- `railway-create-environment` - Create a new environment

### Services
- `railway-list-services` - List services in a project
- `railway-create-service` - Create a new service
- `railway-delete-service` - Delete a service

### Variables
- `railway-list-variables` - List environment variables
- `railway-set-variables` - Set environment variables

### Deployments
- `railway-list-deployments` - List recent deployments
- `railway-get-deployment` - Get deployment status
- `railway-redeploy` - Trigger a redeploy

### Domains
- `railway-list-domains` - List domains for a service
- `railway-create-domain` - Create a Railway-generated domain

### Volumes
- `railway-create-volume` - Create a persistent volume

## Example Usage

```
User: "Create a Railway project called 'my-landing'"

Alice: [railway-create-project name="my-landing"]
       → Project created with ID: prj_abc123

User: "Add a staging environment"

Alice: [railway-create-environment projectId="prj_abc123" name="staging"]
       → Environment created with ID: env_xyz789

User: "Create a web service"

Alice: [railway-create-service projectId="prj_abc123" name="web"]
       → Service created with ID: svc_123456

User: "Set NODE_ENV to staging"

Alice: [railway-set-variables 
         projectId="prj_abc123" 
         serviceId="svc_123456"
         environmentId="env_xyz789"
         variables={"NODE_ENV": "staging"}]
       → Variables set successfully

User: "Create a public domain"

Alice: [railway-create-domain serviceId="svc_123456" environmentId="env_xyz789"]
       → Domain created: my-landing-staging.up.railway.app
```

## API Reference

This MCA uses Railway's GraphQL API. For more information:
- [Railway API Docs](https://docs.railway.com/reference/public-api)
- [Railway GraphQL Playground](https://railway.com/graphiql)

## License

MIT
