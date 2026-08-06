/**
 * Boundary validation for Hunter tool arguments — enforces what JSON Schema
 * cannot express (non-empty / non-whitespace strings, email shape). Errors are
 * prefixed `[BAD_REQUEST]` so they read consistently with provider errors and
 * the LLM can react to the bracket.
 */

import { HunterError } from './errors';

/** Pragmatic email shape check (not RFC-complete; rejects obvious garbage). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Domain shape: one or more labels followed by an alphabetic TLD (≥2 letters),
 * no spaces, no scheme/path. The alphabetic-TLD requirement rejects bare IPs
 * (e.g. "192.168.0.1"), which Hunter's domain endpoints do not accept.
 */
const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

function badRequest(message: string): HunterError {
  return new HunterError('BAD_REQUEST', message);
}

/** Require a non-empty, non-whitespace string. Returns the trimmed value. */
export function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

/** Validate + normalize a domain (strips a leading scheme / trailing path if present). */
export function requireDomain(value: unknown): string {
  const raw = requireNonEmpty(value, 'domain');
  // Tolerate users passing a URL — keep only the host.
  const host = raw
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();
  if (!DOMAIN_RE.test(host)) {
    throw badRequest(`domain "${raw}" is not a valid domain (expected e.g. "stripe.com")`);
  }
  return host;
}

/** Validate an email address. Returns the trimmed value. */
export function requireEmail(value: unknown): string {
  const email = requireNonEmpty(value, 'email');
  if (!EMAIL_RE.test(email)) {
    throw badRequest(`email "${email}" is not a valid email address`);
  }
  return email;
}

/** Validate an optional positive integer within [min, max]. Returns undefined when absent. */
export function optionalInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
