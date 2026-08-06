export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function parseOutput<T>(output: string): T | string | null {
  try {
    return JSON.parse(output) as T;
  } catch {
    return output;
  }
}

export function truncate(text: string, maxLength = 50): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export function isSuccessMessage(parsed: unknown): boolean {
  return (
    typeof parsed === 'string' &&
    (parsed.includes('✅') ||
      parsed.includes('success') ||
      parsed.includes('Success') ||
      parsed.includes('deleted') ||
      parsed.includes('archived') ||
      parsed.includes('added'))
  );
}

/**
 * Convierte identificadores técnicos (camelCase, snake_case, kebab-case) a
 * etiquetas legibles en Title Case. Útil para renderizar campos de objetos
 * donde las keys son técnicas pero el UI las muestra a humanos.
 *
 *   humanizeLabel('createdAt')  // → 'Created At'
 *   humanizeLabel('mca_id')     // → 'Mca Id'
 *   humanizeLabel('user-name')  // → 'User Name'
 */
export function humanizeLabel(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Detecta valores que no aportan información al usuario (strings vacíos o
 * serializaciones triviales de null/undefined/estructuras vacías). Útil
 * para filtrar campos vacíos antes de pintarlos en un KeyValueGrid.
 */
export function isEmptyValue(value: string): boolean {
  const v = value.trim();
  return v === '' || v === '[]' || v === '{}' || v === 'null' || v === 'undefined';
}
