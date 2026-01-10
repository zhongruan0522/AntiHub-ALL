import crypto from 'crypto';
import logger from '../utils/logger.js';

const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/device/code';
const QWEN_OAUTH_TOKEN_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/token';
// 来自参考项目 CLIProxyAPI 的 Qwen OAuth client_id（Qwen Code）
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';
const QWEN_OAUTH_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function safeJsonParse(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizePositiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n <= 0) return fallback;
  return n;
}

class QwenService {
  generateCodeVerifier() {
    // 32 bytes -> 43 chars base64url，足够用于 PKCE
    return base64UrlEncode(crypto.randomBytes(32));
  }

  generateCodeChallenge(codeVerifier) {
    const digest = crypto.createHash('sha256').update(codeVerifier).digest();
    return base64UrlEncode(digest);
  }

  /**
   * 发起 Qwen OAuth Device Flow（参考 CLIProxyAPI）
   * @returns {Promise<{device_code:string, user_code?:string, verification_uri?:string, verification_uri_complete:string, expires_in:number, interval:number, code_verifier:string}>}
   */
  async initiateDeviceFlow() {
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);

    const body = new URLSearchParams();
    body.set('client_id', QWEN_OAUTH_CLIENT_ID);
    body.set('scope', QWEN_OAUTH_SCOPE);
    body.set('code_challenge', codeChallenge);
    body.set('code_challenge_method', 'S256');

    const resp = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    const raw = await resp.text();
    const data = safeJsonParse(raw);

    if (!resp.ok) {
      const errorType = data?.error || '';
      const errorDesc = data?.error_description || raw || `HTTP ${resp.status}`;
      throw new Error(`Qwen OAuth 发起失败: ${errorType} ${errorDesc}`.trim());
    }

    const deviceCode = typeof data?.device_code === 'string' ? data.device_code.trim() : '';
    const verificationUriComplete =
      typeof data?.verification_uri_complete === 'string' ? data.verification_uri_complete.trim() : '';
    if (!deviceCode || !verificationUriComplete) {
      throw new Error('Qwen OAuth 发起失败：响应缺少 device_code / verification_uri_complete');
    }

    return {
      device_code: deviceCode,
      user_code: typeof data?.user_code === 'string' ? data.user_code.trim() : undefined,
      verification_uri: typeof data?.verification_uri === 'string' ? data.verification_uri.trim() : undefined,
      verification_uri_complete: verificationUriComplete,
      expires_in: normalizePositiveInt(data?.expires_in, 300),
      interval: normalizePositiveInt(data?.interval, 5),
      code_verifier: codeVerifier,
    };
  }

  /**
   * 使用 refresh_token 刷新 access_token
   * @param {string} refresh_token
   * @returns {Promise<{access_token:string, refresh_token?:string, token_type?:string, resource_url?:string, expires_in?:number}>}
   */
  async refreshAccessToken(refresh_token) {
    const normalized = typeof refresh_token === 'string' ? refresh_token.trim() : '';
    if (!normalized) {
      const err = new Error('refresh_token不能为空');
      err.isInvalidGrant = true;
      throw err;
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('client_id', QWEN_OAUTH_CLIENT_ID);
    body.set('refresh_token', normalized);

    const resp = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    const raw = await resp.text();
    const data = safeJsonParse(raw);

    if (!resp.ok) {
      const errorType = data?.error || '';
      const errorDesc = data?.error_description || raw || `HTTP ${resp.status}`;

      const err = new Error(`Qwen refresh token 失败: ${errorType} ${errorDesc}`.trim());
      // OAuth 常见错误
      if (errorType === 'invalid_grant') {
        err.isInvalidGrant = true;
      }
      err.statusCode = resp.status;
      err.response = data || raw;
      throw err;
    }

    if (!data || typeof data.access_token !== 'string' || !data.access_token.trim()) {
      throw new Error('Qwen refresh token 响应缺少 access_token');
    }

    return {
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      token_type: typeof data.token_type === 'string' ? data.token_type : undefined,
      resource_url: typeof data.resource_url === 'string' ? data.resource_url : undefined,
      expires_in: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    };
  }

  /**
   * Device Flow 轮询 token（RFC 8628）
   * 注意：默认最多等 5 分钟，避免后台任务跑太久（参考 CLIProxyAPI）。
   * @param {Object} params
   * @param {string} params.device_code
   * @param {string} params.code_verifier
   * @param {number} [params.interval]
   * @returns {Promise<{access_token:string, refresh_token?:string, token_type?:string, resource_url?:string, expires_in?:number}>}
   */
  async pollForToken({ device_code, code_verifier, interval }) {
    const deviceCode = typeof device_code === 'string' ? device_code.trim() : '';
    const codeVerifier = typeof code_verifier === 'string' ? code_verifier.trim() : '';
    if (!deviceCode || !codeVerifier) {
      throw new Error('device_code / code_verifier 不能为空');
    }

    let pollIntervalMs = normalizePositiveInt(interval, 5) * 1000;
    const deadline = Date.now() + 5 * 60 * 1000;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt += 1;

      const body = new URLSearchParams();
      body.set('grant_type', QWEN_OAUTH_DEVICE_GRANT_TYPE);
      body.set('client_id', QWEN_OAUTH_CLIENT_ID);
      body.set('device_code', deviceCode);
      body.set('code_verifier', codeVerifier);

      const resp = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });

      const raw = await resp.text();
      const data = safeJsonParse(raw);

      if (resp.ok) {
        const accessToken = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
        if (!accessToken) {
          throw new Error('Qwen OAuth 登录失败：响应缺少 access_token');
        }
        return {
          access_token: accessToken,
          refresh_token: typeof data?.refresh_token === 'string' ? data.refresh_token : undefined,
          token_type: typeof data?.token_type === 'string' ? data.token_type : undefined,
          resource_url: typeof data?.resource_url === 'string' ? data.resource_url : undefined,
          expires_in: typeof data?.expires_in === 'number' ? data.expires_in : undefined,
        };
      }

      const errorType = typeof data?.error === 'string' ? data.error : '';
      const errorDesc = typeof data?.error_description === 'string' ? data.error_description : '';

      if (resp.status === 400) {
        if (errorType === 'authorization_pending') {
          await sleep(pollIntervalMs);
          continue;
        }
        if (errorType === 'slow_down') {
          pollIntervalMs = Math.min(10_000, Math.floor(pollIntervalMs * 1.5));
          await sleep(pollIntervalMs);
          continue;
        }
        if (errorType === 'expired_token') {
          throw new Error('Qwen OAuth 登录失败：device_code 已过期，请重新开始');
        }
        if (errorType === 'access_denied') {
          throw new Error('Qwen OAuth 登录失败：用户拒绝授权，请重新开始');
        }
      }

      const hint = `${errorType} ${errorDesc}`.trim();
      throw new Error(
        `Qwen OAuth 轮询失败(第${attempt}次): ${hint || raw || `HTTP ${resp.status}`}`.trim()
      );
    }

    throw new Error('Qwen OAuth 登录超时，请重新开始');
  }

  /**
   * 规范化 resource_url：允许传入 portal.qwen.ai 或 https://portal.qwen.ai
   * @param {string|null|undefined} resource_url
   * @returns {string}
   */
  normalizeResourceURL(resource_url) {
    if (typeof resource_url !== 'string' || !resource_url.trim()) {
      return 'portal.qwen.ai';
    }
    return resource_url.trim().replace(/^https?:\/\//i, '');
  }

  /**
   * 将 QwenCli 导出的 expired 字段解析成毫秒时间戳
   * @param {string|number|null|undefined} expired
   * @returns {number|null}
   */
  parseExpiredToMillis(expired) {
    if (expired == null) return null;

    if (typeof expired === 'number' && Number.isFinite(expired)) {
      const n = Math.floor(expired);
      if (n <= 0) return null;
      // Heuristic: treat values below 1e12 as seconds.
      return n < 1e12 ? n * 1000 : n;
    }

    if (typeof expired !== 'string') return null;
    const trimmed = expired.trim();
    if (!trimmed) return null;

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;

    // Some exports use numeric timestamps serialized as strings.
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      const n = Math.floor(numeric);
      return n < 1e12 ? n * 1000 : n;
    }

    return null;
  }

  /**
   * 为导入流程提供一层兜底的、可读的错误日志（避免把 token 打到日志里）
   * @param {Error} error
   */
  logSafeError(error) {
    const message = typeof error?.message === 'string' ? error.message : String(error);
    logger.warn(`QwenService error: ${message}`);
  }
}

const qwenService = new QwenService();
export default qwenService;
