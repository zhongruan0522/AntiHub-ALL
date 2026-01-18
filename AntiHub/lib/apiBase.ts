const DEFAULT_DEV_API_BASE_URL = 'http://localhost:8008';
const DEFAULT_PROD_PUBLIC_API_BASE_URL = '/backend';
const DEFAULT_PROD_INTERNAL_API_BASE_URL = 'http://antihub-backend:8000';

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // dotenv/平台可能把值包一层引号：INTERNAL_API_BASE_URL="http://..."
  const unquoted = trimmed.replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!unquoted) return undefined;

  return unquoted.replace(/\/+$/, '');
}

function normalizeInternalBaseUrl(value: string | undefined): string | undefined {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return undefined;

  if (isAbsoluteUrl(normalized)) return normalized;
  if (normalized.startsWith('/')) return undefined;

  // 兼容只填 host:port 的情况：antihub-backend:8000 -> http://antihub-backend:8000
  return `http://${normalized}`;
}

export function getPublicApiBaseUrl(): string {
  const envValue = normalizeEnvValue(process.env.NEXT_PUBLIC_API_URL);
  if (envValue) return envValue;
  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PROD_PUBLIC_API_BASE_URL
    : DEFAULT_DEV_API_BASE_URL;
}

export function getInternalApiBaseUrl(): string {
  const envInternal =
    normalizeInternalBaseUrl(process.env.INTERNAL_API_BASE_URL) ||
    normalizeInternalBaseUrl(process.env.BACKEND_INTERNAL_URL);
  if (envInternal) return envInternal;

  const publicBase = getPublicApiBaseUrl();
  if (isAbsoluteUrl(publicBase)) return publicBase.replace(/\/+$/, '');

  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PROD_INTERNAL_API_BASE_URL
    : DEFAULT_DEV_API_BASE_URL;
}

export function getApiBaseUrlForRuntime(): string {
  return typeof window === 'undefined' ? getInternalApiBaseUrl() : getPublicApiBaseUrl();
}
