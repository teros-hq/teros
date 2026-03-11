/**
 * Static URL utilities for MCA assets
 */

import { config } from '../config';

/**
 * Build a full static URL for an MCA asset
 *
 * @param mcaId - The MCA identifier (e.g., 'mca.perplexity')
 * @param relativePath - Relative path within the MCA's static folder (e.g., 'logo.svg')
 * @returns Full URL to the static asset
 *
 * @example
 * getMcaStaticUrl('mca.perplexity', 'logo.svg')
 * // → 'https://your-backend-domain.com/static/mcas/mca.perplexity/logo.svg'
 */
export function getMcaStaticUrl(mcaId: string, relativePath: string): string {
  // Remove leading slash if present
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return `${config.static.baseUrl}/mcas/${mcaId}/${cleanPath}`;
}

/**
 * Build a full static URL for a general static asset (not MCA-specific)
 *
 * @param relativePath - Relative path within the static folder
 * @returns Full URL to the static asset
 *
 * @example
 * getStaticUrl('alice-avatar.jpg')
 * // → 'https://your-backend-domain.com/static/alice-avatar.jpg'
 */
export function getStaticUrl(relativePath: string): string {
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return `${config.static.baseUrl}/${cleanPath}`;
}
