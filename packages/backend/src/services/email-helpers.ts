/**
 * Email Helpers
 *
 * Helper functions for email composition
 */

/**
 * Get initials from a display name
 */
export function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Extract first name from display name
 */
export function getFirstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0];
}
