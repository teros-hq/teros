/**
 * Text Template Validator
 *
 * Validates text data against a template that may contain {{variable}} placeholders.
 *
 * A template like "Write a summary of {{topic}}" defines:
 * - Static text segments that must appear verbatim in the data
 * - {{variable}} placeholders that capture the text between the static segments
 *
 * Validation rules:
 * 1. Data must be a string
 * 2. All static text segments in the template must appear in the data, in order
 * 3. Each {{variable}} captures the text between its surrounding static segments
 * 4. Variables must be non-empty (whitespace-only is rejected) — a placeholder
 *    implies the value must be present
 * 5. If the template has no placeholders, the data must contain the template text
 *    (substring match, not exact — allows additional context)
 */

import type { ValidationResult } from './types';

// Matches {{variableName}} — supports alphanumeric + underscore + hyphen
const PLACEHOLDER_RE = /\{\{([a-zA-Z0-9_-]+)\}\}/g;

/**
 * Extract all {{variable}} names from a template string.
 * Returns them in order of appearance (with duplicates removed).
 */
export function extractTemplateVariables(template: string): string[] {
  const vars: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  // Reset lastIndex in case the regex was used before
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      vars.push(name);
    }
  }

  return vars;
}

/**
 * Escape special regex characters in a literal string so it can be
 * used safely inside a RegExp.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex from a template that captures variable values into named groups.
 *
 * The template "Hello {{name}}, you are {{age}}" becomes:
 *   /^Hello (?<name>.+?), you are (?<age>.+?)$/
 *
 * Uses non-greedy quantifiers so multiple variables don't over-capture.
 * The regex is anchored to the full string (^...$) for exact matching.
 */
function buildTemplateRegex(template: string): RegExp {
  // Split template into segments: static text and {{placeholders}}
  const parts: { type: 'static' | 'var'; value: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
    // Static text before this placeholder
    if (match.index > lastIndex) {
      parts.push({ type: 'static', value: template.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'var', value: match[1] });
    lastIndex = match.index + match[0].length;
  }
  // Trailing static text
  if (lastIndex < template.length) {
    parts.push({ type: 'static', value: template.slice(lastIndex) });
  }

  // Build regex pattern
  let pattern = '^';
  for (const part of parts) {
    if (part.type === 'static') {
      pattern += escapeRegex(part.value);
    } else {
      // Named capture group, non-greedy
      pattern += `(?<${part.value}>.+?)`;
    }
  }
  pattern += '$';

  return new RegExp(pattern, 's');
}

/**
 * Validate text data against a text template.
 *
 * @param data - The text data to validate (must be a string)
 * @param template - The template with optional {{variable}} placeholders
 * @returns ValidationResult with `valid`, `errors`, and `variables` (if any placeholders matched)
 */
export function validateTextTemplate(data: unknown, template: string): ValidationResult {
  const errors: string[] = [];

  // 1. Data must be a string
  if (typeof data !== 'string') {
    errors.push(`Expected text data (string), got ${typeof data}`);
    return { valid: false, errors };
  }

  // 2. Data must not be empty
  if (data.length === 0) {
    errors.push('Data is an empty string');
    return { valid: false, errors };
  }

  // 3. Template must not be empty
  if (!template || template.trim().length === 0) {
    errors.push('Template is empty');
    return { valid: false, errors };
  }

  // 4. Extract variables for metadata
  const variableNames = extractTemplateVariables(template);

  // 5. If no placeholders, check if template text appears as substring
  if (variableNames.length === 0) {
    if (data.includes(template)) {
      return { valid: true, errors: [], variables: {} };
    }
    errors.push(`Data does not contain expected text: "${template}"`);
    return { valid: false, errors };
  }

  // 6. Build regex and match
  try {
    const regex = buildTemplateRegex(template);
    const match = data.match(regex);

    if (!match) {
      errors.push(`Data does not match template pattern: "${template}"`);
      return { valid: false, errors };
    }

    // 7. Extract captured variables
    const variables: Record<string, string> = {};
    const groups = match.groups;
    if (groups) {
      for (const name of variableNames) {
        const value = groups[name];
        if (value === undefined || value.trim().length === 0) {
          errors.push(`Variable "{{${name}}}" is empty or whitespace-only`);
        } else {
          variables[name] = value;
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors, variables };
    }

    return { valid: true, errors: [], variables };
  } catch (err) {
    errors.push(`Failed to build template regex: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors };
  }
}
