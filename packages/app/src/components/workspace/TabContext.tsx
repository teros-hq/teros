/**
 * TabContext — propagates tab/container state to child windows
 *
 * Allows window headers (ChatHeader, etc.) to match the tab's background
 * color and adapt their appearance based on container/tab active state.
 */

import { createContext, useContext } from 'react';

export interface TabContextValue {
  /** Background color the active tab uses — headers should match this */
  tabBgColor: string;
  /** Whether the parent container has focus (split pane active) */
  isContainerActive: boolean;
  /** Whether this specific tab is the visible one (display:flex vs none) */
  isTabActive: boolean;
}

export const TabContext = createContext<TabContextValue | null>(null);

export function useTabContext(): TabContextValue | null {
  return useContext(TabContext);
}
