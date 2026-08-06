import es from '../locales/es.json';
import en from '../locales/en.json';

type Locale = 'es' | 'en';

const LOCALES: Record<Locale, Record<string, unknown>> = {
  es: es as Record<string, unknown>,
  en: en as Record<string, unknown>,
};

let currentLocale: Locale = 'es';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

function lookup(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

function titleCaseLastSegment(key: string): string {
  const last = key.split('.').pop() ?? key;
  return last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function pluralize(key: string, count: number): string {
  const variant = count === 1 ? '_one' : '_other';
  return `${key}${variant}`;
}

/**
 * Translate `key`. `{{name}}` placeholders interpolate from `params`. Passing `{ count: N }` resolves to `${key}_one` / `${key}_other`.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let resolvedKey = key;
  if (params && typeof params.count === 'number') {
    resolvedKey = pluralize(key, params.count);
  }

  let value = lookup(LOCALES[currentLocale], resolvedKey);
  if (value === undefined && currentLocale !== 'es') {
    value = lookup(LOCALES.es, resolvedKey);
  }
  if (value === undefined && currentLocale !== 'en') {
    value = lookup(LOCALES.en, resolvedKey);
  }

  if (value === undefined) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[i18n] Missing key: ${resolvedKey}`);
      return `⚠️ ${resolvedKey}`;
    }
    return titleCaseLastSegment(resolvedKey);
  }

  if (params) {
    value = value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const v = params[name];
      return v === undefined ? `{{${name}}}` : String(v);
    });
  }
  return value;
}
