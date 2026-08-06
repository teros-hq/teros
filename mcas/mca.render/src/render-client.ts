/**
 * Render REST API Client
 *
 * Provides typed access to Render's REST API v1 for managing services,
 * deployments, environment variables, custom domains, and projects.
 *
 * API Docs: https://api-docs.render.com/reference/introduction
 */

const RENDER_API_URL = 'https://api.render.com/v1';

// =============================================================================
// TYPES
// =============================================================================

export interface RenderOwner {
  id: string;
  name: string;
  email: string;
  type: 'user' | 'team';
}

export interface RenderUser {
  id: string;
  name: string;
  email: string;
}

export interface RenderProject {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RenderEnvironment {
  id: string;
  name: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RenderService {
  id: string;
  name: string;
  type: string;
  ownerId: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  serviceDetails?: {
    url?: string;
    buildCommand?: string;
    startCommand?: string;
    region?: string;
    plan?: string;
    branch?: string;
    repoURL?: string;
    autoDeploy?: string;
  };
}

export interface RenderDeploy {
  id: string;
  serviceId: string;
  status: string;
  trigger: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  commit?: {
    id: string;
    message: string;
    createdAt: string;
  };
}

export interface RenderEnvVar {
  key: string;
  value: string;
}

export interface RenderCustomDomain {
  id: string;
  name: string;
  domainType: string;
  publicSuffix: string;
  redirectForName?: string;
  verificationStatus: string;
  createdAt: string;
  server?: {
    id: string;
    name: string;
    type: string;
  };
}

export interface RenderDisk {
  id: string;
  name: string;
  mountPath: string;
  sizeGB: number;
  serviceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RenderLogEntry {
  timestamp: string;
  message: string;
  level?: string;
  serviceId?: string;
  instanceId?: string;
}

// =============================================================================
// CLIENT
// =============================================================================

export class RenderClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Execute a REST API call
   */
  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    let url = `${RENDER_API_URL}${path}`;

    // Append query params
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          searchParams.append(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Render API error: ${response.status} - ${text}`);
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // ===========================================================================
  // USER & OWNERS
  // ===========================================================================

  /**
   * Get the authenticated user
   */
  async getUser(): Promise<RenderUser> {
    return this.request<RenderUser>('GET', '/user');
  }

  /**
   * List all workspaces/owners accessible to the user
   */
  async listOwners(): Promise<RenderOwner[]> {
    const data = await this.request<{ owner: RenderOwner }[]>('GET', '/owners', undefined, { limit: 100 });
    return data.map((item) => item.owner);
  }

  // ===========================================================================
  // PROJECTS
  // ===========================================================================

  /**
   * List all projects
   */
  async listProjects(): Promise<RenderProject[]> {
    const data = await this.request<{ project: RenderProject }[]>('GET', '/projects', undefined, { limit: 100 });
    return data.map((item) => item.project);
  }

  /**
   * Get a project by ID
   */
  async getProject(projectId: string): Promise<RenderProject> {
    return this.request<RenderProject>('GET', `/projects/${projectId}`);
  }

  /**
   * Create a new project
   */
  async createProject(name: string, ownerId: string): Promise<RenderProject> {
    return this.request<RenderProject>('POST', '/projects', { name, ownerId });
  }

  /**
   * Delete a project
   */
  async deleteProject(projectId: string): Promise<void> {
    return this.request<void>('DELETE', `/projects/${projectId}`);
  }

  // ===========================================================================
  // ENVIRONMENTS
  // ===========================================================================

  /**
   * List environments in a project
   */
  async listEnvironments(projectId: string): Promise<RenderEnvironment[]> {
    const data = await this.request<{ environment: RenderEnvironment }[]>(
      'GET',
      `/projects/${projectId}/environments`,
      undefined,
      { limit: 100 },
    );
    return data.map((item) => item.environment);
  }

  /**
   * Create an environment in a project
   */
  async createEnvironment(projectId: string, name: string): Promise<RenderEnvironment> {
    return this.request<RenderEnvironment>('POST', `/projects/${projectId}/environments`, { name });
  }

  // ===========================================================================
  // SERVICES
  // ===========================================================================

  /**
   * List all services
   */
  async listServices(params?: { type?: string; name?: string; limit?: number }): Promise<RenderService[]> {
    const data = await this.request<{ service: RenderService }[]>('GET', '/services', undefined, {
      type: params?.type,
      name: params?.name,
      limit: params?.limit ?? 100,
    });
    return data.map((item) => item.service);
  }

  /**
   * Get a service by ID
   */
  async getService(serviceId: string): Promise<RenderService> {
    return this.request<RenderService>('GET', `/services/${serviceId}`);
  }

  /**
   * Create a new web service from a GitHub repo
   */
  async createService(input: {
    name: string;
    ownerId: string;
    type: 'web_service' | 'static_site' | 'background_worker' | 'private_service' | 'cron_job';
    repoURL: string;
    branch?: string;
    buildCommand?: string;
    startCommand?: string;
    plan?: string;
    region?: string;
    autoDeploy?: 'yes' | 'no';
    envVars?: { key: string; value: string }[];
  }): Promise<{ service: RenderService; deployId: string | null }> {
    const serviceDetails: Record<string, any> = {
      repoURL: input.repoURL,
      branch: input.branch ?? 'main',
      autoDeploy: input.autoDeploy ?? 'yes',
    };

    if (input.buildCommand) serviceDetails.buildCommand = input.buildCommand;
    if (input.startCommand) serviceDetails.startCommand = input.startCommand;
    if (input.plan) serviceDetails.plan = input.plan;
    if (input.region) serviceDetails.region = input.region;
    if (input.envVars) serviceDetails.envVars = input.envVars;

    const body: Record<string, any> = {
      name: input.name,
      ownerId: input.ownerId,
      type: input.type,
      serviceDetails,
    };

    const data = await this.request<{ service: RenderService; deployId: string | null }>('POST', '/services', body);
    return data;
  }

  /**
   * Delete a service
   */
  async deleteService(serviceId: string): Promise<void> {
    return this.request<void>('DELETE', `/services/${serviceId}`);
  }

  /**
   * Suspend a service
   */
  async suspendService(serviceId: string): Promise<void> {
    return this.request<void>('POST', `/services/${serviceId}/suspend`);
  }

  /**
   * Resume a suspended service
   */
  async resumeService(serviceId: string): Promise<void> {
    return this.request<void>('POST', `/services/${serviceId}/resume`);
  }

  /**
   * Restart a service
   */
  async restartService(serviceId: string): Promise<void> {
    return this.request<void>('POST', `/services/${serviceId}/restart`);
  }

  // ===========================================================================
  // DEPLOYMENTS
  // ===========================================================================

  /**
   * List deploys for a service
   */
  async listDeploys(serviceId: string, limit: number = 10): Promise<RenderDeploy[]> {
    const data = await this.request<{ deploy: RenderDeploy }[]>(
      'GET',
      `/services/${serviceId}/deploys`,
      undefined,
      { limit },
    );
    return data.map((item) => item.deploy);
  }

  /**
   * Get a specific deploy
   */
  async getDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
    return this.request<RenderDeploy>('GET', `/services/${serviceId}/deploys/${deployId}`);
  }

  /**
   * Trigger a new deploy
   */
  async triggerDeploy(serviceId: string, clearCache?: 'clear' | 'do_not_clear'): Promise<RenderDeploy> {
    const body: Record<string, any> = {};
    if (clearCache) body.clearCache = clearCache;
    return this.request<RenderDeploy>('POST', `/services/${serviceId}/deploys`, body);
  }

  /**
   * Cancel a running deploy
   */
  async cancelDeploy(serviceId: string, deployId: string): Promise<void> {
    return this.request<void>('POST', `/services/${serviceId}/deploys/${deployId}/cancel`);
  }

  /**
   * Roll back to a specific deploy
   */
  async rollbackDeploy(serviceId: string, deployId: string): Promise<RenderDeploy> {
    return this.request<RenderDeploy>('POST', `/services/${serviceId}/deploys/${deployId}/rollback`);
  }

  // ===========================================================================
  // ENVIRONMENT VARIABLES
  // ===========================================================================

  /**
   * List environment variables for a service
   */
  async listEnvVars(serviceId: string): Promise<RenderEnvVar[]> {
    const data = await this.request<{ envVar: RenderEnvVar }[]>(
      'GET',
      `/services/${serviceId}/env-vars`,
      undefined,
      { limit: 100 },
    );
    return data.map((item) => item.envVar);
  }

  /**
   * Update (replace all) environment variables for a service
   */
  async updateEnvVars(serviceId: string, envVars: { key: string; value: string }[]): Promise<RenderEnvVar[]> {
    const data = await this.request<{ envVar: RenderEnvVar }[]>(
      'PUT',
      `/services/${serviceId}/env-vars`,
      envVars,
    );
    return data.map((item) => item.envVar);
  }

  /**
   * Add or update a single environment variable
   */
  async setEnvVar(serviceId: string, key: string, value: string): Promise<RenderEnvVar> {
    return this.request<RenderEnvVar>('PUT', `/services/${serviceId}/env-vars/${key}`, { value });
  }

  /**
   * Delete an environment variable
   */
  async deleteEnvVar(serviceId: string, key: string): Promise<void> {
    return this.request<void>('DELETE', `/services/${serviceId}/env-vars/${key}`);
  }

  // ===========================================================================
  // CUSTOM DOMAINS
  // ===========================================================================

  /**
   * List custom domains for a service
   */
  async listCustomDomains(serviceId: string): Promise<RenderCustomDomain[]> {
    const data = await this.request<{ customDomain: RenderCustomDomain }[]>(
      'GET',
      `/services/${serviceId}/custom-domains`,
      undefined,
      { limit: 100 },
    );
    return data.map((item) => item.customDomain);
  }

  /**
   * Add a custom domain to a service
   */
  async addCustomDomain(serviceId: string, name: string): Promise<RenderCustomDomain> {
    return this.request<RenderCustomDomain>('POST', `/services/${serviceId}/custom-domains`, { name });
  }

  /**
   * Delete a custom domain from a service
   */
  async deleteCustomDomain(serviceId: string, domainId: string): Promise<void> {
    return this.request<void>('DELETE', `/services/${serviceId}/custom-domains/${domainId}`);
  }

  /**
   * Verify DNS configuration for a custom domain
   */
  async verifyCustomDomain(serviceId: string, domainId: string): Promise<RenderCustomDomain> {
    return this.request<RenderCustomDomain>('POST', `/services/${serviceId}/custom-domains/${domainId}/verify`);
  }

  // ===========================================================================
  // DISKS
  // ===========================================================================

  /**
   * List disks for a service
   */
  async listDisks(serviceId: string): Promise<RenderDisk[]> {
    const data = await this.request<{ disk: RenderDisk }[]>(
      'GET',
      `/services/${serviceId}/disks`,
      undefined,
      { limit: 100 },
    );
    return data.map((item) => item.disk);
  }

  /**
   * Add a disk to a service
   */
  async addDisk(serviceId: string, name: string, mountPath: string, sizeGB: number): Promise<RenderDisk> {
    return this.request<RenderDisk>('POST', `/services/${serviceId}/disks`, { name, mountPath, sizeGB });
  }

  // ===========================================================================
  // LOGS
  // ===========================================================================

  /**
   * List logs for a service (last N lines via REST)
   */
  async getLogs(
    ownerId: string,
    serviceIds: string[],
    limit: number = 100,
    startTime?: string,
    endTime?: string,
    text?: string,
    level?: string,
  ): Promise<RenderLogEntry[]> {
    const params: Record<string, string | number | undefined> = {
      limit,
      startTime,
      endTime,
      text,
      level,
    };

    // serviceIds is passed as repeated query params
    let url = `${RENDER_API_URL}/logs?ownerId=${ownerId}`;
    for (const id of serviceIds) {
      url += `&serviceId[]=${id}`;
    }

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url += `&${key}=${encodeURIComponent(String(value))}`;
      }
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Render API error: ${response.status} - ${text}`);
    }

    const data = await response.json() as any;
    return data.logs ?? data ?? [];
  }

  // ===========================================================================
  // UTILITY
  // ===========================================================================

  /**
   * Validate the API key by fetching the authenticated user
   */
  async validateApiKey(): Promise<boolean> {
    try {
      await this.getUser();
      return true;
    } catch {
      return false;
    }
  }
}
