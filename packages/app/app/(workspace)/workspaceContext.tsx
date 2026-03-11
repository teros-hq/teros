/**
 * Workspace Context
 *
 * Provides workspace ready state to child components
 */

import { createContext, useContext } from 'react';

interface WorkspaceContextValue {
  isReady: boolean;
}

export const WorkspaceContext = createContext<WorkspaceContextValue>({ isReady: false });

/**
 * Hook to check if the workspace is fully loaded and ready
 */
export function useWorkspaceReady(): boolean {
  return useContext(WorkspaceContext).isReady;
}
