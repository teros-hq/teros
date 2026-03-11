/**
 * Email Helpers
 *
 * Helper functions to prepare email template variables
 */

import type { InvitationReceivedVars } from './email-service';

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

// Colors for progress dots
const DOT_ACTIVE = '#06B6D4'; // cyan-500
const DOT_INACTIVE = '#3F3F46'; // zinc-700

/**
 * Build variables for invitation-received email
 */
export function buildInvitationReceivedVars(params: {
  userName: string;
  inviterName: string;
  currentCount: number; // 1, 2, or 3
}): InvitationReceivedVars {
  const { userName, inviterName, currentCount } = params;
  const remaining = 3 - currentCount;

  return {
    USER_NAME: userName,
    INVITER_NAME: inviterName,
    INVITER_INITIALS: getInitials(inviterName),
    CURRENT_COUNT: currentCount.toString(),
    REMAINING_COUNT: remaining.toString(),
    REMAINING_PLURAL: remaining === 1 ? '' : 's',
    DOT_1_CLASS: currentCount >= 1 ? DOT_ACTIVE : DOT_INACTIVE,
    DOT_2_CLASS: currentCount >= 2 ? DOT_ACTIVE : DOT_INACTIVE,
    DOT_3_CLASS: currentCount >= 3 ? DOT_ACTIVE : DOT_INACTIVE,
  };
}

/**
 * Extract first name from display name
 */
export function getFirstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0];
}
