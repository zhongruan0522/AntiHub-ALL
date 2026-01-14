type CookieHttpMode = 'HTTP' | 'HTTPS';

const DEFAULT_COOKIE_HTTP_MODE: CookieHttpMode = 'HTTPS';

function normalizeCookieHttpMode(value: string | undefined): CookieHttpMode {
  if (!value) return DEFAULT_COOKIE_HTTP_MODE;
  const normalized = value.trim().toUpperCase();
  return normalized === 'HTTP' ? 'HTTP' : 'HTTPS';
}

export function getCookieHttpMode(): CookieHttpMode {
  // 兼容两种命名：
  // - COOKIE_HTTP：推荐（Next.js/Compose 生态最稳）
  // - Cookie-Http：按你的需求命名（用于直接控制 Secure 行为）
  const raw = process.env.COOKIE_HTTP ?? process.env['Cookie-Http'];
  return normalizeCookieHttpMode(raw);
}

export function getCookieSecure(): boolean {
  if (getCookieHttpMode() === 'HTTP') return false;
  return process.env.NODE_ENV === 'production';
}
