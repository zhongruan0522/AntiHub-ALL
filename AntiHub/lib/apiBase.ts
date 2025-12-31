const DEFAULT_DEV_API_BASE_URL = 'http://localhost:8008';
const DEFAULT_PROD_PUBLIC_API_BASE_URL = '/backend';
const DEFAULT_PROD_INTERNAL_API_BASE_URL = 'http://backend:8000';

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function getPublicApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PROD_PUBLIC_API_BASE_URL
    : DEFAULT_DEV_API_BASE_URL;
}

export function getInternalApiBaseUrl(): string {
  if (process.env.INTERNAL_API_BASE_URL) return process.env.INTERNAL_API_BASE_URL;

  const publicBase = getPublicApiBaseUrl();
  if (isAbsoluteUrl(publicBase)) return publicBase;

  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PROD_INTERNAL_API_BASE_URL
    : DEFAULT_DEV_API_BASE_URL;
}

export function getApiBaseUrlForRuntime(): string {
  return typeof window === 'undefined' ? getInternalApiBaseUrl() : getPublicApiBaseUrl();
}

