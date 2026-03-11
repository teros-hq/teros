/**
 * Railway GraphQL API Client
 *
 * Provides typed access to Railway's GraphQL API for managing projects,
 * services, deployments, environments, and variables.
 *
 * API Docs: https://docs.railway.com/reference/public-api
 */

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

// =============================================================================
// TYPES
// =============================================================================

export interface RailwayWorkspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface RailwayUser {
  id: string;
  email: string;
  name: string;
  workspaces: RailwayWorkspace[];
}

export interface RailwayProject {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  environments: RailwayEnvironment[];
  services: RailwayService[];
}

export interface RailwayEnvironment {
  id: string;
  name: string;
  createdAt: string;
}

export interface RailwayService {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  staticUrl?: string;
}

export interface RailwayVariable {
  name: string;
  value: string;
}

export interface RailwayDomain {
  id: string;
  domain: string;
  serviceId: string;
  environmentId: string;
}

export interface RailwayVolume {
  id: string;
  name: string;
  mountPath: string;
  sizeGB: number;
}

// =============================================================================
// GRAPHQL QUERIES & MUTATIONS
// =============================================================================

const QUERIES = {
  // Me (current user info)
  me: `
    query {
      me {
        id
        email
        name
        workspaces {
          id
          name
          createdAt
        }
      }
    }
  `,

  // Projects
  listProjects: `
    query {
      me {
        workspaces {
          projects {
            edges {
              node {
                id
                name
                description
                createdAt
                updatedAt
                environments {
                  edges {
                    node {
                      id
                      name
                      createdAt
                    }
                  }
                }
                services {
                  edges {
                    node {
                      id
                      name
                      createdAt
                      updatedAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `,

  getProject: `
    query($id: String!) {
      project(id: $id) {
        id
        name
        description
        createdAt
        updatedAt
        environments {
          edges {
            node {
              id
              name
              createdAt
            }
          }
        }
        services {
          edges {
            node {
              id
              name
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  `,

  // Deployments
  getDeployment: `
    query($id: String!) {
      deployment(id: $id) {
        id
        status
        createdAt
        updatedAt
        staticUrl
      }
    }
  `,

  listDeployments: `
    query($projectId: String!, $serviceId: String!, $environmentId: String!) {
      deployments(
        first: 10
        input: {
          projectId: $projectId
          serviceId: $serviceId
          environmentId: $environmentId
        }
      ) {
        edges {
          node {
            id
            status
            createdAt
            updatedAt
            staticUrl
          }
        }
      }
    }
  `,

  // Variables
  listVariables: `
    query($projectId: String!, $serviceId: String!, $environmentId: String!) {
      variables(
        projectId: $projectId
        serviceId: $serviceId
        environmentId: $environmentId
      )
    }
  `,

  // Domains
  listDomains: `
    query($projectId: String!, $serviceId: String!, $environmentId: String!) {
      domains(
        projectId: $projectId
        serviceId: $serviceId
        environmentId: $environmentId
      ) {
        serviceDomains {
          id
          domain
          serviceId
          environmentId
        }
        customDomains {
          id
          domain
          serviceId
          environmentId
        }
      }
    }
  `,

  // Build Logs
  buildLogs: `
    query($deploymentId: String!, $limit: Int, $filter: String) {
      buildLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
        message
        timestamp
        severity
      }
    }
  `,

  // Deployment Logs (runtime logs)
  deploymentLogs: `
    query($deploymentId: String!, $limit: Int, $filter: String) {
      deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
        message
        timestamp
        severity
      }
    }
  `,
};

const MUTATIONS = {
  // Projects
  createProject: `
    mutation($name: String!, $description: String, $workspaceId: String!) {
      projectCreate(input: { name: $name, description: $description, workspaceId: $workspaceId }) {
        id
        name
        description
        createdAt
        environments {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `,

  deleteProject: `
    mutation($id: String!) {
      projectDelete(id: $id)
    }
  `,

  // Environments
  createEnvironment: `
    mutation($input: EnvironmentCreateInput!) {
      environmentCreate(input: $input) {
        id
        name
        createdAt
      }
    }
  `,

  deleteEnvironment: `
    mutation($id: String!) {
      environmentDelete(id: $id)
    }
  `,

  // Services
  createService: `
    mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
        name
        createdAt
      }
    }
  `,

  deleteService: `
    mutation($id: String!) {
      serviceDelete(id: $id)
    }
  `,

  // Variables
  upsertVariables: `
    mutation($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `,

  deleteVariable: `
    mutation($input: VariableDeleteInput!) {
      variableDelete(input: $input)
    }
  `,

  // Deployments
  deploymentRedeploy: `
    mutation($id: String!) {
      deploymentRedeploy(id: $id) {
        id
        status
        createdAt
      }
    }
  `,

  deploymentCancel: `
    mutation($id: String!) {
      deploymentCancel(id: $id)
    }
  `,

  // Domains
  createServiceDomain: `
    mutation($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) {
        id
        domain
        serviceId
        environmentId
      }
    }
  `,

  // Volumes
  createVolume: `
    mutation($input: VolumeCreateInput!) {
      volumeCreate(input: $input) {
        id
        name
      }
    }
  `,

  // Connect GitHub repo to service (works with private repos if GitHub is connected)
  serviceConnect: `
    mutation($serviceId: String!, $repo: String!, $branch: String) {
      serviceConnect(id: $serviceId, input: { repo: $repo, branch: $branch }) {
        id
        name
      }
    }
  `,

  // Deploy public GitHub repo (only works with public repos)
  githubRepoDeploy: `
    mutation($projectId: String!, $repo: String!, $branch: String, $environmentId: String) {
      githubRepoDeploy(input: { projectId: $projectId, repo: $repo, branch: $branch, environmentId: $environmentId })
    }
  `,
};

// =============================================================================
// CLIENT
// =============================================================================

export interface RailwayLog {
  message: string;
  timestamp: string;
  severity?: string;
}

export interface RailwayLogsResult {
  logs: RailwayLog[];
  total: number;
}

export class RailwayClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Execute a GraphQL query/mutation
   */
  private async execute<T>(
    query: string,
    variables?: Record<string, any>,
  ): Promise<T> {
    const response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Railway API error: ${response.status} - ${text}`);
    }

    const data = await response.json();

    if (data.errors && data.errors.length > 0) {
      const errorMessages = data.errors.map((e: any) => e.message).join(', ');
      throw new Error(`Railway GraphQL error: ${errorMessages}`);
    }

    return data.data;
  }

  /**
   * Helper to extract nodes from edges
   */
  private extractNodes<T>(edges: { edges: { node: T }[] } | undefined): T[] {
    if (!edges || !edges.edges) return [];
    return edges.edges.map((e) => e.node);
  }

  // ===========================================================================
  // USER & WORKSPACES
  // ===========================================================================

  /**
   * Get current user info including workspaces
   */
  async getMe(): Promise<RailwayUser> {
    const data = await this.execute<{ me: any }>(QUERIES.me);
    return {
      ...data.me,
      workspaces: data.me.workspaces || [],
    };
  }

  /**
   * List workspaces for current user
   */
  async listWorkspaces(): Promise<RailwayWorkspace[]> {
    const me = await this.getMe();
    return me.workspaces;
  }

  // ===========================================================================
  // PROJECTS
  // ===========================================================================

  /**
   * List all projects
   */
  async listProjects(): Promise<RailwayProject[]> {
    const data = await this.execute<{ me: { workspaces: { projects: { edges: { node: any }[] } }[] } }>(
      QUERIES.listProjects,
    );

    // Flatten projects from all workspaces
    const allProjects: RailwayProject[] = [];
    for (const workspace of data.me.workspaces) {
      const projects = this.extractNodes(workspace.projects).map((p) => ({
        ...p,
        environments: this.extractNodes(p.environments),
        services: this.extractNodes(p.services),
      }));
      allProjects.push(...projects);
    }
    return allProjects;
  }

  /**
   * Get a project by ID
   */
  async getProject(id: string): Promise<RailwayProject | null> {
    try {
      const data = await this.execute<{ project: any }>(QUERIES.getProject, {
        id,
      });

      if (!data.project) return null;

      return {
        ...data.project,
        environments: this.extractNodes(data.project.environments),
        services: this.extractNodes(data.project.services),
      };
    } catch (error) {
      // Project not found
      return null;
    }
  }

  /**
   * Create a new project in a workspace
   */
  async createProject(
    name: string,
    workspaceId: string,
    description?: string,
  ): Promise<RailwayProject> {
    const data = await this.execute<{ projectCreate: any }>(
      MUTATIONS.createProject,
      {
        name,
        description,
        workspaceId,
      },
    );

    return {
      ...data.projectCreate,
      environments: this.extractNodes(data.projectCreate.environments),
      services: [],
    };
  }

  /**
   * Delete a project
   */
  async deleteProject(id: string): Promise<boolean> {
    await this.execute(MUTATIONS.deleteProject, { id });
    return true;
  }

  // ===========================================================================
  // ENVIRONMENTS
  // ===========================================================================

  /**
   * Create a new environment in a project
   */
  async createEnvironment(
    projectId: string,
    name: string,
  ): Promise<RailwayEnvironment> {
    const data = await this.execute<{ environmentCreate: RailwayEnvironment }>(
      MUTATIONS.createEnvironment,
      {
        input: { projectId, name },
      },
    );

    return data.environmentCreate;
  }

  /**
   * Delete an environment
   */
  async deleteEnvironment(id: string): Promise<boolean> {
    await this.execute(MUTATIONS.deleteEnvironment, { id });
    return true;
  }

  // ===========================================================================
  // SERVICES
  // ===========================================================================

  /**
   * Create a new service in a project
   */
  async createService(projectId: string, name: string): Promise<RailwayService> {
    const data = await this.execute<{ serviceCreate: RailwayService }>(
      MUTATIONS.createService,
      {
        input: { projectId, name },
      },
    );

    return data.serviceCreate;
  }

  /**
   * Delete a service
   */
  async deleteService(id: string): Promise<boolean> {
    await this.execute(MUTATIONS.deleteService, { id });
    return true;
  }

  // ===========================================================================
  // VARIABLES
  // ===========================================================================

  /**
   * List variables for a service in an environment
   */
  async listVariables(
    projectId: string,
    serviceId: string,
    environmentId: string,
  ): Promise<Record<string, string>> {
    const data = await this.execute<{ variables: Record<string, string> }>(
      QUERIES.listVariables,
      { projectId, serviceId, environmentId },
    );

    return data.variables || {};
  }

  /**
   * Set/update variables for a service
   */
  async setVariables(
    projectId: string,
    serviceId: string,
    environmentId: string,
    variables: Record<string, string>,
  ): Promise<boolean> {
    await this.execute(MUTATIONS.upsertVariables, {
      input: {
        projectId,
        serviceId,
        environmentId,
        variables,
      },
    });

    return true;
  }

  /**
   * Delete a variable
   */
  async deleteVariable(
    projectId: string,
    serviceId: string,
    environmentId: string,
    name: string,
  ): Promise<boolean> {
    await this.execute(MUTATIONS.deleteVariable, {
      input: {
        projectId,
        serviceId,
        environmentId,
        name,
      },
    });

    return true;
  }

  // ===========================================================================
  // DEPLOYMENTS
  // ===========================================================================

  /**
   * Get deployment status
   */
  async getDeployment(id: string): Promise<RailwayDeployment | null> {
    try {
      const data = await this.execute<{ deployment: RailwayDeployment }>(
        QUERIES.getDeployment,
        { id },
      );
      return data.deployment;
    } catch {
      return null;
    }
  }

  /**
   * List recent deployments for a service
   */
  async listDeployments(
    projectId: string,
    serviceId: string,
    environmentId: string,
  ): Promise<RailwayDeployment[]> {
    const data = await this.execute<{
      deployments: { edges: { node: RailwayDeployment }[] };
    }>(QUERIES.listDeployments, { projectId, serviceId, environmentId });

    return this.extractNodes(data.deployments);
  }

  /**
   * Redeploy a deployment
   */
  async redeploy(deploymentId: string): Promise<RailwayDeployment> {
    const data = await this.execute<{ deploymentRedeploy: RailwayDeployment }>(
      MUTATIONS.deploymentRedeploy,
      { id: deploymentId },
    );

    return data.deploymentRedeploy;
  }

  /**
   * Cancel a deployment
   */
  async cancelDeployment(deploymentId: string): Promise<boolean> {
    await this.execute(MUTATIONS.deploymentCancel, { id: deploymentId });
    return true;
  }

  // ===========================================================================
  // DOMAINS
  // ===========================================================================

  /**
   * List domains for a service
   */
  async listDomains(
    projectId: string,
    serviceId: string,
    environmentId: string,
  ): Promise<RailwayDomain[]> {
    const data = await this.execute<{
      domains: {
        serviceDomains: RailwayDomain[];
        customDomains: RailwayDomain[];
      };
    }>(QUERIES.listDomains, { projectId, serviceId, environmentId });

    return [
      ...(data.domains?.serviceDomains || []),
      ...(data.domains?.customDomains || []),
    ];
  }

  /**
   * Create a Railway-generated domain for a service
   */
  async createServiceDomain(
    serviceId: string,
    environmentId: string,
  ): Promise<RailwayDomain> {
    const data = await this.execute<{ serviceDomainCreate: RailwayDomain }>(
      MUTATIONS.createServiceDomain,
      {
        input: { serviceId, environmentId },
      },
    );

    return data.serviceDomainCreate;
  }

  // ===========================================================================
  // VOLUMES
  // ===========================================================================

  /**
   * Create a persistent volume for a service
   */
  async createVolume(
    projectId: string,
    serviceId: string,
    environmentId: string,
    mountPath: string,
  ): Promise<RailwayVolume> {
    const data = await this.execute<{ volumeCreate: RailwayVolume }>(
      MUTATIONS.createVolume,
      {
        input: {
          projectId,
          serviceId,
          environmentId,
          mountPath,
        },
      },
    );

    return data.volumeCreate;
  }

  // ===========================================================================
  // UTILITY
  // ===========================================================================

  /**
   * Validate the API token by listing projects
   */
  async validateToken(): Promise<boolean> {
    try {
      await this.listProjects();
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // LOGS
  // ===========================================================================

  /**
   * Get build logs for a deployment
   */
  async getBuildLogs(
    deploymentId: string,
    limit: number = 100,
    filter?: string,
  ): Promise<RailwayLogsResult> {
    try {
      const data = await this.execute<{ buildLogs: RailwayLog[] }>(
        QUERIES.buildLogs,
        { deploymentId, limit, filter },
      );

      return {
        logs: data.buildLogs || [],
        total: data.buildLogs?.length || 0,
      };
    } catch (error) {
      // Re-throw with more context
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get build logs: ${message}`);
    }
  }

  /**
   * Get deployment/runtime logs for a deployment
   */
  async getDeploymentLogs(
    deploymentId: string,
    limit: number = 100,
    filter?: string,
  ): Promise<RailwayLogsResult> {
    try {
      const data = await this.execute<{ deploymentLogs: RailwayLog[] }>(
        QUERIES.deploymentLogs,
        { deploymentId, limit, filter },
      );

      return {
        logs: data.deploymentLogs || [],
        total: data.deploymentLogs?.length || 0,
      };
    } catch (error) {
      // Re-throw with more context
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get deployment logs: ${message}`);
    }
  }

  // ===========================================================================
  // GITHUB INTEGRATION
  // ===========================================================================

  /**
   * Connect a GitHub repository to a service.
   * Works with private repos if GitHub is connected in Railway account.
   * Automatically triggers a deployment.
   */
  async connectRepo(
    serviceId: string,
    repo: string,
    branch: string = 'main',
  ): Promise<{ id: string; name: string }> {
    const data = await this.execute<{ serviceConnect: { id: string; name: string } }>(
      MUTATIONS.serviceConnect,
      {
        serviceId,
        repo,
        branch,
      },
    );

    return data.serviceConnect;
  }

  /**
   * Deploy a public GitHub repository.
   * Only works with PUBLIC repos. For private repos, use connectRepo().
   * Returns the service ID.
   */
  async deployPublicRepo(
    projectId: string,
    repo: string,
    branch: string = 'main',
    environmentId?: string,
  ): Promise<string> {
    const data = await this.execute<{ githubRepoDeploy: string }>(
      MUTATIONS.githubRepoDeploy,
      {
        projectId,
        repo,
        branch,
        environmentId,
      },
    );

    return data.githubRepoDeploy;
  }
}
