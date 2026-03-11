/**
 * Admin Handler
 * Handles administrative operations like MCA monitoring
 */

import type { Db } from 'mongodb';
import type { WebSocket } from 'ws';
import type { McaManager } from '../services/mca-manager';
import { McaService } from '../services/mca-service';

export class AdminHandler {
  private mcaService: McaService;

  constructor(
    private db: Db,
    private mcaManager: McaManager | null,
  ) {
    this.mcaService = new McaService(db);
  }

  /**
   * Handle admin_mca_status request
   * Returns status of all running MCAs
   */
  async handleMcaStatus(ws: WebSocket): Promise<void> {
    if (!this.mcaManager) {
      this.sendResponse(ws, {
        type: 'admin_mca_status',
        error: 'MCA Manager not available',
        mcas: [],
      });
      return;
    }

    const status = this.mcaManager.getStatus();

    // Enrich with app details from DB
    const enrichedStatus = await Promise.all(
      status.map(async (mca) => {
        const app = await this.mcaService.getApp(mca.appId);
        const catalog = app ? await this.mcaService.getMcaFromCatalog(app.mcaId) : null;

        return {
          ...mca,
          appName: app?.name ?? 'Unknown',
          mcaName: catalog?.name ?? 'Unknown',
          ownerId: app?.ownerId ?? 'Unknown',
          idleTimeMs: Date.now() - mca.lastUsed.getTime(),
        };
      }),
    );

    this.sendResponse(ws, {
      type: 'admin_mca_status',
      mcas: enrichedStatus,
      summary: {
        total: status.length,
        ready: status.filter((m) => m.status === 'ready').length,
        starting: status.filter((m) => m.status === 'starting').length,
        error: status.filter((m) => m.status === 'error').length,
      },
    });
  }

  /**
   * Handle admin_mca_kill request
   * Kills a specific MCA process
   */
  async handleMcaKill(ws: WebSocket, appId: string): Promise<void> {
    if (!this.mcaManager) {
      this.sendError(ws, 'MCA_MANAGER_UNAVAILABLE', 'MCA Manager not available');
      return;
    }

    try {
      await this.mcaManager.kill(appId);
      this.sendResponse(ws, {
        type: 'admin_mca_killed',
        appId,
        success: true,
      });
    } catch (error: any) {
      this.sendError(ws, 'MCA_KILL_FAILED', error.message);
    }
  }

  /**
   * Handle admin_mca_cleanup request
   * Triggers cleanup of inactive MCAs
   */
  async handleMcaCleanup(ws: WebSocket): Promise<void> {
    if (!this.mcaManager) {
      this.sendError(ws, 'MCA_MANAGER_UNAVAILABLE', 'MCA Manager not available');
      return;
    }

    try {
      const cleaned = await this.mcaManager.cleanupInactive();
      this.sendResponse(ws, {
        type: 'admin_mca_cleanup',
        cleaned,
        count: cleaned.length,
      });
    } catch (error: any) {
      this.sendError(ws, 'MCA_CLEANUP_FAILED', error.message);
    }
  }

  /**
   * Handle admin_apps_list request
   * Returns all installed apps
   */
  async handleAppsList(ws: WebSocket): Promise<void> {
    const apps = await this.db.collection('apps').find({}).toArray();

    // Enrich with catalog info
    const enrichedApps = await Promise.all(
      apps.map(async (app: any) => {
        const catalog = await this.mcaService.getMcaFromCatalog(app.mcaId);
        return {
          appId: app.appId,
          name: app.name,
          mcaId: app.mcaId,
          mcaName: catalog?.name ?? 'Unknown',
          ownerId: app.ownerId,
          status: app.status,
          createdAt: app.createdAt,
        };
      }),
    );

    this.sendResponse(ws, {
      type: 'admin_apps_list',
      apps: enrichedApps,
    });
  }

  /**
   * Handle admin_agent_access_list request
   * Returns all agent app access grants
   */
  async handleAgentAccessList(ws: WebSocket): Promise<void> {
    const access = await this.db.collection('agent_app_access').find({}).toArray();

    // Enrich with app names
    const enrichedAccess = await Promise.all(
      access.map(async (a: any) => {
        const app = await this.mcaService.getApp(a.appId);
        return {
          agentId: a.agentId,
          appId: a.appId,
          appName: app?.name ?? 'Unknown',
          grantedBy: a.grantedBy,
          grantedAt: a.grantedAt,
          allowedTools: a.allowedTools,
        };
      }),
    );

    this.sendResponse(ws, {
      type: 'admin_agent_access_list',
      access: enrichedAccess,
    });
  }

  /**
   * Send response to client
   */
  private sendResponse(ws: WebSocket, data: any): void {
    ws.send(JSON.stringify(data));
  }

  /**
   * Send error to client
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(
      JSON.stringify({
        type: 'error',
        code,
        message,
      }),
    );
  }
}
