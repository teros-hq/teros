/**
 * MCA Registry
 *
 * Central registry for MCA UI components.
 * Maps mcaId to their custom renderers.
 *
 * With the new naming system, tool names use user-defined app names as prefix
 * (e.g., bash_bash, gmail-work_read-email), but renderer matching uses mcaId
 * which is consistent across all instances (e.g., mca.teros.bash).
 */

import * as Sentry from '@sentry/react-native';
import { DefaultToolCallRenderer } from './DefaultToolCallRenderer';
import type { RegisteredMca, ToolCallRendererComponent } from './types';

// Track which tools have already been warned about to avoid spam
const warnedTools = new Set<string>();

class McaRegistryClass {
  private mcas: Map<string, RegisteredMca> = new Map();

  /**
   * Register an MCA with its UI components
   *
   * @param mca - The MCA configuration including mcaId and renderer
   */
  register(mca: RegisteredMca): void {
    this.mcas.set(mca.mcaId, mca);
    console.log(`[McaRegistry] Registered MCA: ${mca.mcaId} (${mca.name})`);
  }

  /**
   * Unregister an MCA
   */
  unregister(mcaId: string): void {
    if (this.mcas.has(mcaId)) {
      this.mcas.delete(mcaId);
      console.log(`[McaRegistry] Unregistered MCA: ${mcaId}`);
    }
  }

  /**
   * Get the ToolCallRenderer for a specific mcaId
   * Returns the custom renderer if available, otherwise the default
   *
   * @param mcaId - The MCP ID (e.g., 'mca.teros.bash')
   * @param toolName - Optional tool name for warning context
   */
  getToolCallRendererByMcpId(
    mcaId: string | undefined,
    toolName?: string,
  ): ToolCallRendererComponent {
    if (!mcaId) {
      this.warnDefaultRenderer(mcaId, toolName);
      return DefaultToolCallRenderer;
    }

    const mca = this.mcas.get(mcaId);
    if (mca?.ToolCallRenderer) {
      return mca.ToolCallRenderer;
    }

    // Fallback to default renderer - emit warning
    this.warnDefaultRenderer(mcaId, toolName);
    return DefaultToolCallRenderer;
  }

  /**
   * Emit a warning when using the default renderer
   * This helps track tools that need custom renderers
   */
  private warnDefaultRenderer(mcaId: string | undefined, toolName?: string): void {
    const key = `${mcaId || 'unknown'}:${toolName || 'unknown'}`;

    // Only warn once per tool to avoid log spam
    if (warnedTools.has(key)) {
      return;
    }
    warnedTools.add(key);

    const message = `[McaRegistry] Using default renderer for tool: ${toolName || 'unknown'} (mcaId: ${mcaId || 'undefined'})`;

    // Log to console
    console.warn(message);

    // Send to Sentry as a warning (not an error)
    try {
      Sentry.captureMessage(message, {
        level: 'warning',
        tags: {
          type: 'missing_renderer',
          mcaId: mcaId || 'undefined',
          toolName: toolName || 'unknown',
        },
        extra: {
          registeredMcas: Array.from(this.mcas.keys()),
        },
      });
    } catch (e) {
      // Sentry might not be initialized in dev, ignore
    }
  }

  /**
   * Get MCA info by mcaId
   */
  getMca(mcaId: string): RegisteredMca | undefined {
    return this.mcas.get(mcaId);
  }

  /**
   * Get all registered MCAs
   */
  getAllMcas(): RegisteredMca[] {
    return Array.from(this.mcas.values());
  }

  /**
   * Check if an MCA has a custom renderer
   */
  hasCustomRenderer(mcaId: string): boolean {
    const mca = this.mcas.get(mcaId);
    return !!mca?.ToolCallRenderer;
  }

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    this.mcas.clear();
  }

  /**
   * Clear warned tools cache (useful for testing)
   */
  clearWarnings(): void {
    warnedTools.clear();
  }
}

// Singleton instance
export const McaRegistry = new McaRegistryClass();

// Export for convenience
export { DefaultToolCallRenderer };
