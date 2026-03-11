/**
 * Hook to detect click modifiers (Ctrl/Cmd/Middle-click)
 * Allows opening content in new tabs in the window system
 */

export function useClickModifiers() {
  /**
   * Determines if a click should open in a new tab
   * @param e Click event (mouse or touch)
   * @returns true if it should open in a new tab
   */
  const shouldOpenInNewTab = (e: any) => {
    // Cmd+Click on Mac, Ctrl+Click on Windows/Linux
    const cmdOrCtrl = e.ctrlKey || e.metaKey;
    // Middle button click (button === 1)
    const middleClick = e.button === 1;

    return cmdOrCtrl || middleClick;
  };

  return { shouldOpenInNewTab };
}
