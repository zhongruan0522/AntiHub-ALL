/**
 * API 客户端工具
 * 基于后端 OpenAPI 规范实现
 * 支持无感刷新 Token
 */

import { getApiBaseUrlForRuntime } from './apiBase';

const API_BASE_URL = getApiBaseUrlForRuntime();

// ==================== 类型定义 ====================

export interface LoginRequest {
  username: string;
  password: string;
}

export interface UserResponse {
  id: number;
  username: string;
  avatar_url?: string | null;
  trust_level: number;
  is_active: boolean;
  is_silenced: boolean;
  beta: number; // 0=未加入beta，1=已加入beta
  created_at: string;
  last_login_at?: string | null;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: UserResponse;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface OAuthInitiateResponse {
  authorization_url: string;
  state: string;
}

export interface LogoutResponse {
  success: boolean;
  message: string;
}

export interface ApiError {
  detail: string | Array<{
    loc: (string | number)[];
    msg: string;
    type: string;
  }>;
}

// ==================== Token 刷新状态管理 ====================

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string | null) => void;
  reject: (error: Error) => void;
}> = [];

const processQueue = (error: Error | null, token: string | null = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// ==================== 工具函数 ====================

/**
 * 处理 API 响应
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error: ApiError = await response.json().catch(() => ({
      detail: `HTTP ${response.status}: ${response.statusText}`
    }));
    
    let errorMessage: string;
    if (typeof error.detail === 'string') {
      errorMessage = error.detail;
    } else if (Array.isArray(error.detail)) {
      errorMessage = error.detail.map(e => e.msg).join(', ');
    } else if (error.detail && typeof error.detail === 'object') {
      // 处理对象类型的 detail，例如 {error: "message"}
      errorMessage = (error.detail as any).error || (error.detail as any).message || JSON.stringify(error.detail);
    } else {
      errorMessage = JSON.stringify(error.detail);
    }
    
    throw new Error(errorMessage);
  }
  
  return response.json();
}

/**
 * 获取认证 header
 */
function getAuthHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` })
  };
}

/**
 * 保存登录凭证到 localStorage
 */
function saveAuthCredentials(data: LoginResponse | RefreshTokenResponse, user?: UserResponse) {
  if (typeof window === 'undefined') return;
  
  localStorage.setItem('access_token', data.access_token);
  localStorage.setItem('refresh_token', data.refresh_token);
  localStorage.setItem('token_expires_at', String(Date.now() + data.expires_in * 1000));
  
  if (user) {
    localStorage.setItem('user', JSON.stringify(user));
  }
}

/**
 * 清除所有认证凭证
 */
function clearAuthCredentials() {
  if (typeof window === 'undefined') return;
  
  // 清除 localStorage
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('token_expires_at');
  localStorage.removeItem('user');
  
  // 清除 cookies（设置过期时间为过去）
  if (typeof document !== 'undefined') {
    document.cookie = 'access_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    document.cookie = 'refresh_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    document.cookie = 'user=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    console.log('[clearAuthCredentials] 已清除所有认证凭证（localStorage + cookies）');
  }
}

/**
 * 刷新 Token
 * 尝试从多个来源获取 refresh_token
 */
async function refreshToken(): Promise<RefreshTokenResponse> {
  console.log('[refreshToken] 调用刷新接口');
  
  // 尝试从多个来源获取 refresh_token
  let refreshTokenValue = null;
  
  // 1. 尝试从 localStorage 读取
  if (typeof window !== 'undefined') {
    refreshTokenValue = localStorage.getItem('refresh_token');
    if (refreshTokenValue) {
      console.log('[refreshToken] 从 localStorage 获取到 refresh_token');
    }
  }
  
  // 2. 如果 localStorage 没有，尝试从非 httpOnly cookie 读取
  if (!refreshTokenValue && typeof document !== 'undefined') {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const [name, value] = cookie.trim().split('=');
      if (name === 'refresh_token') {
        refreshTokenValue = value;
        console.log('[refreshToken] 从 cookie 获取到 refresh_token');
        break;
      }
    }
  }
  
  if (!refreshTokenValue) {
    console.error('[refreshToken] 无法获取 refresh_token');
    throw new Error('No refresh token available');
  }
  
  const response = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include', // 发送 cookies（以防后端也支持从 cookie 读取）
    body: JSON.stringify({ refresh_token: refreshTokenValue }),
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Token refresh failed' }));
    console.error('[refreshToken] 刷新失败:', error);
    throw new Error('Token refresh failed');
  }
  
  const data = await response.json();
  console.log('[refreshToken] 刷新成功');
  return data;
}

/**
 * 带自动刷新的 fetch 请求
 * 当遇到 401 错误时，自动尝试刷新 token 并重试请求
 */
export async function fetchWithAuth<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
    ...(token && { 'Authorization': `Bearer ${token}` })
  };
  
  const response = await fetch(url, { ...options, headers });
  
  // 如果不是 401 或 403 错误，直接处理响应
  if (response.status !== 401 && response.status !== 403) {
    return handleResponse<T>(response);
  }
  
  // 处理 401/403 错误 - 尝试刷新 token
  console.log(`[fetchWithAuth] 检测到 ${response.status} 错误，准备刷新 token...`);
  // 注意：不需要检查 refresh_token 是否存在，因为它在 httpOnly cookie 中
  // 后端会自动从 cookie 读取
  
  // 如果正在刷新，将请求加入队列
  console.log('[fetchWithAuth] 检查是否正在刷新:', isRefreshing);
  if (isRefreshing) {
    console.log('[fetchWithAuth] 正在刷新中，将请求加入队列');
    return new Promise<T>((resolve, reject) => {
      failedQueue.push({
        resolve: async (newToken) => {
          if (newToken) {
            const retryHeaders: HeadersInit = {
              ...headers,
              'Authorization': `Bearer ${newToken}`
            };
            try {
              const retryResponse = await fetch(url, { ...options, headers: retryHeaders });
              resolve(await handleResponse<T>(retryResponse));
            } catch (error) {
              reject(error);
            }
          } else {
            reject(new Error('Token refresh failed'));
          }
        },
        reject
      });
    });
  }
  
  isRefreshing = true;
  
  try {
    console.log('[fetchWithAuth] 正在调用刷新接口...');
    const refreshData = await refreshToken();
    console.log('[fetchWithAuth] Token 刷新成功');
    
    // 保存新的 token
    saveAuthCredentials(refreshData);
    
    // 处理队列中的请求
    processQueue(null, refreshData.access_token);
    
    // 重试原请求
    const retryHeaders: HeadersInit = {
      ...headers,
      'Authorization': `Bearer ${refreshData.access_token}`
    };
    const retryResponse = await fetch(url, { ...options, headers: retryHeaders });
    return handleResponse<T>(retryResponse);
    
  } catch (refreshError) {
    console.error('[fetchWithAuth] Token 刷新失败:', refreshError);
    processQueue(refreshError as Error, null);
    // 刷新失败，清除 token
    clearAuthCredentials();
    throw new Error('Session expired, please login again');
  } finally {
    isRefreshing = false;
  }
}

// ==================== 认证相关 API ====================

/**
 * 检查用户名（邮箱）是否存在
 * GET /api/auth/check-username - 检查用户名是否存在
 */
export async function checkEmailExists(email: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/check-username?username=${encodeURIComponent(email)}`, {
      method: 'GET',
    });
    
    if (!response.ok) {
      return false;
    }
    
    const data = await response.json();
    return data.exists || false;
  } catch (error) {
    console.error('Check username error:', error);
    return false;
  }
}

/**
 * 发送邮箱登录链接
 * TODO: 等待后端提供此接口
 */
export async function sendEmailLogin(email: string): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_BASE_URL}/api/auth/email-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });
  
  return handleResponse<{ success: boolean; message: string }>(response);
}

/**
 * 用户名密码登录
 */
export async function login(credentials: LoginRequest): Promise<LoginResponse> {
  // 走 Next.js 同域 API，由服务端设置 httpOnly cookies（用于 /dashboard middleware 鉴权）
  const response = await fetch(`/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials),
  });
  
  const data = await handleResponse<LoginResponse>(response);
  
  // 保存 token 和 refresh_token 到 localStorage
  saveAuthCredentials(data, data.user);
  
  return data;
}

/**
 * 发起 SSO 登录 (Linux.do)
 * 注意: 返回的 authorization_url 会重定向到 OAuth 提供商,
 * OAuth 提供商会回调到后端配置的 redirect_uri
 */
export async function initiateSSOLogin(): Promise<OAuthInitiateResponse> {
  const response = await fetch(`${API_BASE_URL}/api/auth/sso/initiate`, {
    method: 'GET',
  });
  
  return handleResponse<OAuthInitiateResponse>(response);
}

/**
 * 发起 GitHub SSO 登录
 * GET /api/auth/github/login
 */
export async function initiateGitHubLogin(): Promise<OAuthInitiateResponse> {
  const response = await fetch(`${API_BASE_URL}/api/auth/github/login`, {
    method: 'GET',
  });
  
  return handleResponse<OAuthInitiateResponse>(response);
}

/**
 * 完成 GitHub SSO 认证
 * POST /api/auth/github/callback
 */
export async function handleGitHubCallback(code: string, state: string): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE_URL}/api/auth/github/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code, state }),
  });
  
  const data = await handleResponse<LoginResponse>(response);
  
  // 保存 token 和 refresh_token 到 localStorage
  saveAuthCredentials(data, data.user);
  
  return data;
}

/**
 * OAuth 回调处理
 */
export async function handleOAuthCallback(code: string, state: string): Promise<LoginResponse> {
  const response = await fetch(
    `${API_BASE_URL}/api/auth/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    {
      method: 'GET',
    }
  );
  
  const data = await handleResponse<LoginResponse>(response);
  
  // 保存 token 和 refresh_token 到 localStorage
  saveAuthCredentials(data, data.user);
  
  return data;
}

/**
 * 登出
 */
export async function logout(): Promise<LogoutResponse> {
  const refreshTokenValue = typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null;
  
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ refresh_token: refreshTokenValue }),
    });
    
    const data = await handleResponse<LogoutResponse>(response);
    return data;
  } finally {
    // 无论成功与否，都清除本地存储
    clearAuthCredentials();
  }
}

/**
 * 获取当前用户信息
 */
export async function getCurrentUser(): Promise<UserResponse> {
  return fetchWithAuth<UserResponse>(`${API_BASE_URL}/api/auth/me`, {
    method: 'GET',
  });
}

/**
 * 加入Beta计划
 */
export async function joinBeta(): Promise<{ success: boolean; message: string; beta: number }> {
  return fetchWithAuth<{ success: boolean; message: string; beta: number }>(
    `${API_BASE_URL}/api/auth/join-beta`,
    { method: 'POST' }
  );
}

/**
 * 获取Beta计划状态
 */
export async function getBetaStatus(): Promise<{ success: boolean; message: string; beta: number }> {
  return fetchWithAuth<{ success: boolean; message: string; beta: number }>(
    `${API_BASE_URL}/api/auth/beta-status`,
    { method: 'GET' }
  );
}

// ==================== 本地存储工具 ====================

/**
 * 检查用户是否已登录
 */
export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;
  return !!localStorage.getItem('access_token');
}

/**
 * 获取本地存储的用户信息
 */
export function getStoredUser(): UserResponse | null {
  if (typeof window === 'undefined') return null;
  const userStr = localStorage.getItem('user');
  return userStr ? JSON.parse(userStr) : null;
}

/**
 * 获取本地存储的 token
 */
export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('access_token');
}

/**
 * 从 cookie 中获取值
 */
function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  
  console.log('[getCookie] 查找 cookie:', name);
  console.log('[getCookie] 所有 cookies:', document.cookie);
  
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  
  console.log('[getCookie] 分割后的 parts 长度:', parts.length);
  
  if (parts.length === 2) {
    const result = parts.pop()?.split(';').shift() || null;
    console.log('[getCookie] 找到的值:', result ? '存在' : '不存在');
    return result;
  }
  
  console.log('[getCookie] 未找到 cookie:', name);
  return null;
}

/**
 * 获取本地存储的 refresh token
 * 优先从 cookie 读取，如果没有则从 localStorage 读取
 */
export function getStoredRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  
  // 优先从 cookie 读取（因为登录时 refresh_token 保存在 cookie 中）
  let refreshToken = getCookie('refresh_token');
  console.log('[getStoredRefreshToken] 从 cookie 读取:', !!refreshToken);
  
  // 如果 cookie 中没有，尝试从 localStorage 读取
  if (!refreshToken) {
    refreshToken = localStorage.getItem('refresh_token');
    console.log('[getStoredRefreshToken] 从 localStorage 读取:', !!refreshToken);
  } else {
    // 如果从 cookie 读取到了，同步到 localStorage
    localStorage.setItem('refresh_token', refreshToken);
    console.log('[getStoredRefreshToken] 从 cookie 同步 refresh_token 到 localStorage');
  }
  
  return refreshToken;
}

/**
 * 获取 token 过期时间
 */
export function getTokenExpiresAt(): number | null {
  if (typeof window === 'undefined') return null;
  const expiresAt = localStorage.getItem('token_expires_at');
  return expiresAt ? parseInt(expiresAt, 10) : null;
}

/**
 * 检查 token 是否即将过期（默认 5 分钟内）
 */
export function isTokenExpiringSoon(thresholdMs: number = 5 * 60 * 1000): boolean {
  const expiresAt = getTokenExpiresAt();
  if (!expiresAt) return true;
  return Date.now() + thresholdMs >= expiresAt;
}

/**
 * 设置主动刷新 Token 的定时器
 * 在 token 即将过期前自动刷新
 */
export function setupTokenRefresh(onRefreshFailed?: () => void): () => void {
  let timeoutId: NodeJS.Timeout | null = null;
  
  const scheduleRefresh = () => {
    const expiresAt = getTokenExpiresAt();
    if (!expiresAt) return;
    
    const expiresIn = expiresAt - Date.now();
    // 在过期前 5 分钟刷新
    const refreshIn = expiresIn - 5 * 60 * 1000;
    
    if (refreshIn > 0) {
      timeoutId = setTimeout(async () => {
        try {
          const refreshData = await refreshToken();
          saveAuthCredentials(refreshData);
          // 递归设置下一次刷新
          scheduleRefresh();
        } catch (error) {
          console.error('Token refresh failed:', error);
          onRefreshFailed?.();
        }
      }, refreshIn);
    } else if (expiresIn > 0) {
      // Token 即将过期但还没过期，立即刷新
      (async () => {
        try {
          const refreshData = await refreshToken();
          saveAuthCredentials(refreshData);
          scheduleRefresh();
        } catch (error) {
          console.error('Token refresh failed:', error);
          onRefreshFailed?.();
        }
      })();
    }
  };
  
  scheduleRefresh();
  
  // 返回清理函数
  return () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };
}

// ==================== 健康检查 ====================

/**
 * 健康检查
 */
export async function healthCheck(): Promise<Record<string, any>> {
  const response = await fetch(`${API_BASE_URL}/api/health`, {
    method: 'GET',
  });
  
  return handleResponse<Record<string, any>>(response);
}

// ==================== 账号管理相关 API ====================

export interface Account {
  cookie_id: string;
  name?: string;
  email?: string;
  status: number; // 0=禁用, 1=启用
  is_shared: number; // 0=专属, 1=共享
  need_refresh?: boolean; // 是否需要重新登录
  project_id_0?: string; // 项目ID
  is_restricted?: boolean; // 是否被限制
  paid_tier?: boolean; // 是否付费用户
  ineligible?: boolean; // 是否不符合条件
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
  quotas?: any;
}

/**
 * 获取账号列表
 */
export async function getAccounts(): Promise<Account[]> {
  const result = await fetchWithAuth<{ success: boolean; data: Account[] }>(
    `${API_BASE_URL}/api/plugin-api/accounts`,
    { method: 'GET' }
  );
  return result.data;
}

/**
 * 获取账号详情
 */
export async function getAccount(cookieId: string): Promise<Account> {
  const result = await fetchWithAuth<{ success: boolean; data: Account }>(
    `${API_BASE_URL}/api/plugin-api/accounts/${cookieId}`,
    { method: 'GET' }
  );
  return result.data;
}

/**
 * 删除账号
 */
export async function deleteAccount(cookieId: string): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/plugin-api/accounts/${cookieId}`,
    { method: 'DELETE' }
  );
  return result.data;
}

/**
 * 更新账号状态
 */
export async function updateAccountStatus(cookieId: string, status: number): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/plugin-api/accounts/${cookieId}/status`,
    {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }
  );
  return result.data;
}

/**
 * 转换账号类型（专属/共享）
 * @param cookieId 账号的 Cookie ID
 * @param isShared 账号类型：0=专属，1=共享
 */
export async function updateAccountType(cookieId: string, isShared: number): Promise<{
  cookie_id: string;
  is_shared: number;
}> {
  const result = await fetchWithAuth<{
    success: boolean;
    message: string;
    data: {
      cookie_id: string;
      is_shared: number;
    };
  }>(
    `${API_BASE_URL}/api/plugin-api/accounts/${cookieId}/type`,
    {
      method: 'PUT',
      body: JSON.stringify({ is_shared: isShared }),
    }
  );
  return result.data;
}

/**
 * 更新账号名称
 */
export async function updateAccountName(cookieId: string, name: string): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/plugin-api/accounts/${cookieId}/name`,
    {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }
  );
  return result.data;
}

/**
 * 获取 OAuth 授权 URL
 */
export async function getOAuthAuthorizeUrl(isShared: number = 0): Promise<{ auth_url: string; state: string; expires_in: number }> {
  const result = await fetchWithAuth<{ success: boolean; data: { auth_url: string; state: string; expires_in: number } }>(
    `${API_BASE_URL}/api/plugin-api/oauth/authorize`,
    {
      method: 'POST',
      body: JSON.stringify({ is_shared: isShared }),
    }
  );
  return result.data;
}

// ==================== API Key 管理 ====================

export interface PluginAPIKey {
  id: number;
  user_id: number;
  key_preview: string;
  name: string;
  config_type: 'antigravity' | 'kiro'; // 配置类型
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface CreateAPIKeyResponse {
  id: number;
  user_id: number;
  key: string;
  name: string;
  config_type: 'antigravity' | 'kiro'; // 配置类型
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

/**
 * 获取 API Key 列表
 */
export async function getAPIKeys(): Promise<PluginAPIKey[]> {
  return fetchWithAuth<PluginAPIKey[]>(
    `${API_BASE_URL}/api/api-keys`,
    { method: 'GET' }
  );
}

/**
 * 获取 API Key 信息(兼容旧代码)
 */
export async function getAPIKeyInfo(): Promise<PluginAPIKey | null> {
  const keys = await getAPIKeys();
  // 返回第一个激活的 API Key，如果没有则返�� null
  return keys.find(key => key.is_active) || keys[0] || null;
}

/**
 * 生成新的 API Key
 */
export async function generateAPIKey(
  name: string = 'My API Key',
  configType: 'antigravity' | 'kiro' = 'antigravity'
): Promise<CreateAPIKeyResponse> {
  return fetchWithAuth<CreateAPIKeyResponse>(
    `${API_BASE_URL}/api/api-keys`,
    {
      method: 'POST',
      body: JSON.stringify({ name, config_type: configType }),
    }
  );
}

/**
 * 删除指定的 API Key
 */
export async function deleteAPIKey(keyId: number): Promise<any> {
  return fetchWithAuth<any>(
    `${API_BASE_URL}/api/api-keys/${keyId}`,
    { method: 'DELETE' }
  );
}

/**
 * 提交 OAuth 回调
 */
export async function submitOAuthCallback(callbackUrl: string): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/plugin-api/oauth/callback`,
    {
      method: 'POST',
      body: JSON.stringify({ callback_url: callbackUrl }),
    }
  );
  return result.data;
}

/**
 * 获取账号配额
 */
export async function getAccountQuotas(cookieId: string): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/plugin-api/accounts/${cookieId}/quotas`,
    { method: 'GET' }
  );
  return result.data;
}

/**
 * 更新模型配额状态
 */
export async function updateQuotaStatus(cookieId: string, modelName: string, status: number): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/plugin-api/accounts/${cookieId}/quotas/${modelName}/status`,
    {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }
  );
  return result.data;
}

/**
 * 更新 Cookie 优先级
 */
export async function updateCookiePreference(preferShared: number): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/plugin-api/preference`,
    {
      method: 'PUT',
      body: JSON.stringify({ prefer_shared: preferShared }),
    }
  );
  return result.data;
}

/**
 * 获取 Cookie 优先级设置
 */
export async function getCookiePreference(): Promise<{ prefer_shared: number }> {
  const result = await fetchWithAuth<{ success: boolean; data: { prefer_shared: number } }>(
    `${API_BASE_URL}/api/plugin-api/preference`,
    { method: 'GET' }
  );
  return result.data;
}

// ==================== 配额管理相关 API ====================

export interface UserQuotaItem {
  pool_id: string;
  user_id: string;
  model_name: string;
  quota: string;
  max_quota: string;
  last_recovered_at: string;
  last_updated_at: string;
}

export interface QuotaConsumption {
  log_id: string;
  user_id: string;
  cookie_id: string;
  model_name: string;
  quota_before: string;
  quota_after: string;
  quota_consumed: string;
  is_shared: number;
  consumed_at: string;
}

export interface SharedPoolModelQuota {
  model_name: string;
  total_quota: string;
  earliest_reset_time: string | null;
  available_cookies: string;
  status: number;
  last_fetched_at: string;
}

export interface UserConsumption {
  total_requests: number;
  total_quota_consumed: number;
}

export interface SharedPoolQuotasResponse {
  quotas: SharedPoolModelQuota[];
  user_consumption: UserConsumption;
}

export interface SharedPoolModelStats {
  total_quota: number;
  available_cookies: number;
  earliest_reset_time: string | null;
  status: number;
}

export interface SharedPoolStats {
  accounts: {
    total_shared: number;
    active_shared: number;
    inactive_shared: number;
  };
  quotas_by_model: Record<string, SharedPoolModelStats>;
  note?: string;
}

/**
 * 获取用户配额池
 */
export async function getUserQuotas(): Promise<UserQuotaItem[]> {
  const result = await fetchWithAuth<{ success: boolean; data: UserQuotaItem[] }>(
    `${API_BASE_URL}/api/plugin-api/quotas/user`,
    { method: 'GET' }
  );
  return result.data;
}

/**
 * 获取配额消耗记录
 */
export async function getQuotaConsumption(params?: {
  limit?: number;
  start_date?: string;
  end_date?: string;
}): Promise<QuotaConsumption[]> {
  const queryParams = new URLSearchParams();
  if (params?.limit) queryParams.append('limit', params.limit.toString());
  if (params?.start_date) queryParams.append('start_date', params.start_date);
  if (params?.end_date) queryParams.append('end_date', params.end_date);
  
  const url = `${API_BASE_URL}/api/plugin-api/quotas/consumption${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
  
  const result = await fetchWithAuth<{ success: boolean; data: QuotaConsumption[] }>(url, { method: 'GET' });
  return result.data;
}

/**
 * 获取共享池配额信息（新版本，包含用户消费统计）
 */
export async function getSharedPoolQuotas(): Promise<SharedPoolQuotasResponse> {
  const result = await fetchWithAuth<{ success: boolean; data: SharedPoolQuotasResponse }>(
    `${API_BASE_URL}/api/plugin-api/quotas/shared-pool`,
    { method: 'GET' }
  );
  return result.data;
}

/**
 * 获取共享池配额列表（仅配额列表，兼容旧代码）
 */
export async function getSharedPoolQuotasList(): Promise<SharedPoolModelQuota[]> {
  const result = await getSharedPoolQuotas();
  return result.quotas;
}

/**
 * 获取共享池统计信息
 */
export async function getSharedPoolStats(): Promise<SharedPoolStats> {
  const result = await fetchWithAuth<{ success: boolean; data: SharedPoolStats }>(
    `${API_BASE_URL}/api/usage/shared-pool/stats`,
    { method: 'GET' }
  );
  return result.data;
}

// ==================== 聊天相关 API ====================

export type ApiType = 'antigravity' | 'kiro';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
  }>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  apiType?: ApiType;
}

// ==================== 图片生成相关 API ====================

export type ImageAspectRatio = '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '9:16' | '16:9' | '21:9';
export type ImageSize = '1K' | '2K' | '4K';

export interface ImageGenerationConfig {
  aspectRatio?: ImageAspectRatio;
  imageSize?: ImageSize;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  imageConfig?: ImageGenerationConfig;
  apiType?: ApiType;
  // 图生图：附带的图片数据
  inputImage?: {
    mimeType: string;
    data: string; // Base64 编码的图片数据
  };
}

export interface ImageGenerationResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string; // Base64 编码的图片数据
        };
      }>;
      role: string;
    };
    finishReason: string;
  }>;
}

// SSE 事件类型
export type SSEEventType = 'heartbeat' | 'result' | 'error';

export interface SSEHeartbeatEvent {
  type: 'heartbeat';
  timestamp: number;
}

export interface SSEResultEvent {
  type: 'result';
  data: ImageGenerationResponse;
}

export interface SSEErrorEvent {
  type: 'error';
  error: {
    message: string;
    code?: string;
  };
}

export type SSEEvent = SSEHeartbeatEvent | SSEResultEvent | SSEErrorEvent;

/**
 * 生成图片（SSE 流式响应）
 * POST /v1beta/models/{model}:generateContent
 *
 * SSE 响应格式：
 * - 心跳事件（每30秒）：保持连接活跃
 * - 结果事件：包含生成的图片数据
 * - 错误事件：包含错误信息
 */
export async function generateImage(
  request: ImageGenerationRequest,
  onError?: (error: Error) => void,
  onHeartbeat?: () => void
): Promise<ImageGenerationResponse | null> {
  let token = getStoredToken();
  if (!token) {
    const error = new Error('未登录，请先登录');
    onError?.(error);
    throw error;
  }

  const makeRequest = async (authToken: string): Promise<Response> => {
    // 构建 parts 数组
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    
    // 添加文本提示
    if (request.prompt) {
      parts.push({ text: request.prompt });
    }
    
    // 如果有输入图片（图生图），添加图片数据
    if (request.inputImage) {
      parts.push({
        inlineData: {
          mimeType: request.inputImage.mimeType,
          data: request.inputImage.data,
        },
      });
    }

    const body: any = {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
    };
    
    // 添加图片生成配置
    if (request.imageConfig) {
      body.generationConfig = {
        imageConfig: {
          aspectRatio: request.imageConfig.aspectRatio,
          imageSize: request.imageConfig.imageSize,
        },
      };
    }

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'text/event-stream',
    };
    
    if (request.apiType) {
      headers['X-Api-Type'] = request.apiType;
    }

    return fetch(`${API_BASE_URL}/v1beta/models/${request.model}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  };

  try {
    let response = await makeRequest(token);

    // 如果是 401 或 403 错误，尝试刷新 token
    if (response.status === 401 || response.status === 403) {
      console.log(`[generateImage] 检测到 ${response.status} 错误，准备刷新 token...`);

      try {
        console.log('[generateImage] 正在调用刷新接口...');
        const refreshData = await refreshToken();
        console.log('[generateImage] Token 刷新成功');
        saveAuthCredentials(refreshData);
        token = refreshData.access_token;
        response = await makeRequest(token);
      } catch (refreshError) {
        console.error('[generateImage] Token 刷新失败:', refreshError);
        clearAuthCredentials();
        const error = new Error('Session expired, please login again');
        onError?.(error);
        throw error;
      }
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: `HTTP ${response.status}: ${response.statusText}`
      }));
      const errorMessage = typeof error.detail === 'string'
        ? error.detail
        : Array.isArray(error.detail)
        ? error.detail.map((e: any) => e.msg || e.message || JSON.stringify(e)).join(', ')
        : error.error?.message || JSON.stringify(error.detail || error);
      const err = new Error(errorMessage);
      onError?.(err);
      throw err;
    }

    // 检查响应类型，判断是 SSE 还是普通 JSON
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('text/event-stream')) {
      // SSE 流式响应处理
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('无法读取响应流');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let result: ImageGenerationResponse | null = null;

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          
          // 解析 SSE 事件
          if (trimmedLine.startsWith('event:')) {
            // 事件类型行，继续读取数据行
            continue;
          }
          
          if (trimmedLine.startsWith('data:')) {
            const dataContent = trimmedLine.slice(5).trim();
            
            // 跳过 [DONE] 结束标记
            if (dataContent === '[DONE]') {
              console.log('[generateImage] 收到 SSE 结束标记');
              continue;
            }
            
            if (!dataContent) continue;
            
            try {
              const eventData = JSON.parse(dataContent);
              
              // 根据事件类型处理
              if (eventData.type === 'heartbeat') {
                // 心跳事件
                console.log('[generateImage] 收到心跳事件');
                onHeartbeat?.();
              } else if (eventData.type === 'error') {
                // 错误事件
                const errorMsg = eventData.error?.message || '图片生成失败';
                const err = new Error(errorMsg);
                onError?.(err);
                throw err;
              } else if (eventData.type === 'result' || eventData.candidates) {
                // 结果事件 - 可能是 { type: 'result', data: {...} } 或直接是响应数据
                result = eventData.data || eventData;
              } else {
                // 尝试作为直接的响应数据处理
                if (eventData.candidates) {
                  result = eventData;
                }
              }
            } catch (e) {
              console.error('[generateImage] 解析 SSE 数据失败:', e, trimmedLine);
            }
          }
        }
      }

      if (!result) {
        throw new Error('未收到有效的图片生成结果');
      }

      return result;
    } else {
      // 普通 JSON 响应（兼容旧格式）
      const data: ImageGenerationResponse = await response.json();
      return data;
    }
  } catch (error) {
    onError?.(error as Error);
    throw error;
  }
}

/**
 * 发送聊天请求（流式）
 * 使用用户的 access_token 进行认证
 * 支持自动刷新 token
 * 支持 reasoning_content（思维链）和 content（正常内容）
 */
export async function sendChatCompletionStream(
  request: ChatCompletionRequest,
  onChunk: (chunk: string, reasoningChunk?: string) => void,
  onError: (error: Error) => void,
  onComplete: () => void
): Promise<void> {
  let token = getStoredToken();
  if (!token) {
    throw new Error('未登录，请先登录');
  }

  const makeRequest = async (authToken: string): Promise<Response> => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    };
    
    if (request.apiType) {
      headers['X-Api-Type'] = request.apiType;
    }

    // 从请求体中移除 apiType，因为它只用于请求头
    const { apiType, ...requestBody } = request;

    return fetch(`${API_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...requestBody,
        stream: true,
      }),
    });
  };

  try {
    let response = await makeRequest(token);

    // 如果是 401 或 403 错误，尝试刷新 token
    if (response.status === 401 || response.status === 403) {
      console.log(`[sendChatCompletionStream] 检测到 ${response.status} 错误，准备刷新 token...`);
      // 注意：refresh_token 在 httpOnly cookie 中，后端会自动读取

      try {
        console.log('[sendChatCompletionStream] 正在调用刷新接口...');
        const refreshData = await refreshToken();
        console.log('[sendChatCompletionStream] Token 刷新成功');
        saveAuthCredentials(refreshData);
        token = refreshData.access_token;
        response = await makeRequest(token);
      } catch (refreshError) {
        console.error('[sendChatCompletionStream] Token 刷新失败:', refreshError);
        clearAuthCredentials();
        throw new Error('Session expired, please login again');
      }
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: `HTTP ${response.status}: ${response.statusText}`
      }));
      const errorMessage = typeof error.detail === 'string'
        ? error.detail
        : Array.isArray(error.detail)
        ? error.detail.map((e: any) => e.msg || e.message || JSON.stringify(e)).join(', ')
        : JSON.stringify(error.detail);
      throw new Error(errorMessage);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应流');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        onComplete();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine === 'data: [DONE]') continue;
        
        if (trimmedLine.startsWith('data: ')) {
          try {
            const jsonStr = trimmedLine.slice(6);
            const data = JSON.parse(jsonStr);
            const delta = data.choices?.[0]?.delta;
            const content = delta?.content;
            const reasoningContent = delta?.reasoning_content;
            
            // 如果有内容或思维链内容，调用回调
            if (content || reasoningContent) {
              onChunk(content || '', reasoningContent);
            }
          } catch (e) {
            console.error('解析 SSE 数据失败:', e);
          }
        }
      }
    }
  } catch (error) {
    onError(error as Error);
  }
}

// ==================== Kiro 账号管理相关 API ====================

export interface KiroAccount {
  account_id: string;
  user_id: string;
  account_name?: string | null;
  auth_method?: 'Social' | 'IdC' | string;
  is_shared?: number; // 0=专属, 1=共享（部分接口未返回）
  status: number; // 0=禁用, 1=启用
  expires_at?: number | null;
  email?: string | null;
  subscription?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface KiroOAuthAuthorizeResponse {
  success: boolean;
  data: {
    auth_url: string;
    state: string;
    expires_in: number;
  };
}

export interface KiroBonusDetail {
  type: string;
  name: string;
  code: string;
  description: string;
  usage: number;
  limit: number;
  available: number;
  status: string;
  expires_at: string;
  redeemed_at: string;
}

export interface KiroFreeTrialInfo {
  status: boolean;
  usage: number;
  limit: number;
  available: number;
  expiry: string;
}

export interface KiroAccountBalance {
  account_id: string;
  account_name: string;
  email: string;
  subscription: string;
  subscription_type?: string;
  balance: {
    available: number;
    total_limit: number;
    current_usage: number;
    base_available: number;
    bonus_available: number;
    reset_date: string;
  };
  free_trial?: KiroFreeTrialInfo;
  bonus_details: KiroBonusDetail[];
}

export interface KiroConsumptionLog {
  log_id: string;
  account_id: string;
  model_id: string;
  credit_used: number;
  is_shared: number;
  consumed_at: string;
  account_name: string;
}

export interface KiroConsumptionModelStats {
  model_id: string;
  request_count: string;
  total_credit: string;
  avg_credit: string;
  min_credit: string;
  max_credit: string;
}

export interface KiroAccountConsumptionResponse {
  account_id: string;
  account_name: string;
  logs: KiroConsumptionLog[];
  stats: KiroConsumptionModelStats[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface KiroConsumptionStats {
  total_requests: string;
  total_credit: string;
  avg_credit: string;
  shared_credit: string;
  private_credit: string;
}

/**
 * 获取Kiro OAuth授权URL
 */
export async function getKiroOAuthAuthorizeUrl(
  provider: 'Google' | 'Github',
  isShared: number = 0
): Promise<KiroOAuthAuthorizeResponse> {
  return fetchWithAuth<KiroOAuthAuthorizeResponse>(
    `${API_BASE_URL}/api/kiro/oauth/authorize`,
    {
      method: 'POST',
      body: JSON.stringify({ provider, is_shared: isShared }),
    }
  );
}

export interface CreateKiroAccountRequest {
  refresh_token: string;
  auth_method: 'Social' | 'IdC';
  account_name?: string;
  client_id?: string;
  client_secret?: string;
  machineid?: string;
  is_shared?: number;
}

/**
 * 导入/创建 Kiro 账号（Refresh Token）
 */
export async function createKiroAccount(payload: CreateKiroAccountRequest): Promise<KiroAccount> {
  const result = await fetchWithAuth<{ success: boolean; data: KiroAccount }>(
    `${API_BASE_URL}/api/kiro/accounts`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  return result.data;
}

/**
 * 获取所有Kiro账号列表
 */
export async function getKiroAccounts(): Promise<KiroAccount[]> {
  const result = await fetchWithAuth<{ success: boolean; data: KiroAccount[] }>(
    `${API_BASE_URL}/api/kiro/accounts`,
    { method: 'GET' }
  );
  return result.data;
}

/**
 * 获取单个Kiro账号详情
 */
export async function getKiroAccount(accountId: string): Promise<KiroAccount> {
  const result = await fetchWithAuth<{ success: boolean; data: KiroAccount }>(
    `${API_BASE_URL}/api/kiro/accounts/${accountId}`,
    { method: 'GET' }
  );
  return result.data;
}

/**
 * 更新Kiro账号状态
 */
export async function updateKiroAccountStatus(accountId: string, status: number): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/kiro/accounts/${accountId}/status`,
    {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }
  );
  return result.data;
}

/**
 * 更新Kiro账号名称
 */
export async function updateKiroAccountName(accountId: string, accountName: string): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/kiro/accounts/${accountId}/name`,
    {
      method: 'PUT',
      body: JSON.stringify({ account_name: accountName }),
    }
  );
  return result.data;
}

/**
 * 获取Kiro账号余额信息
 */
export async function getKiroAccountBalance(accountId: string): Promise<KiroAccountBalance> {
  const result = await fetchWithAuth<{ success: boolean; data: KiroAccountBalance }>(
    `${API_BASE_URL}/api/kiro/accounts/${accountId}/balance`,
    { method: 'GET' }
  );
  return result.data;
}

/**
 * 获取Kiro账号消费记录
 */
export async function getKiroAccountConsumption(
  accountId: string,
  params?: {
    limit?: number;
    offset?: number;
    start_date?: string;
    end_date?: string;
  }
): Promise<KiroAccountConsumptionResponse> {
  const queryParams = new URLSearchParams();
  if (params?.limit) queryParams.append('limit', params.limit.toString());
  if (params?.offset) queryParams.append('offset', params.offset.toString());
  if (params?.start_date) queryParams.append('start_date', params.start_date);
  if (params?.end_date) queryParams.append('end_date', params.end_date);
  
  const url = `${API_BASE_URL}/api/kiro/accounts/${accountId}/consumption${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
  
  const result = await fetchWithAuth<{ success: boolean; data: KiroAccountConsumptionResponse }>(url, { method: 'GET' });
  return result.data;
}

/**
 * 获取用户总消费统计
 */
export async function getKiroConsumptionStats(params?: {
  start_date?: string;
  end_date?: string;
}): Promise<KiroConsumptionStats> {
  const queryParams = new URLSearchParams();
  if (params?.start_date) queryParams.append('start_date', params.start_date);
  if (params?.end_date) queryParams.append('end_date', params.end_date);
  
  const url = `${API_BASE_URL}/api/kiro/consumption/stats${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
  
  const result = await fetchWithAuth<{ success: boolean; data: KiroConsumptionStats }>(url, { method: 'GET' });
  return result.data;
}

/**
 * 删除Kiro账号
 */
export async function deleteKiroAccount(accountId: string): Promise<any> {
  const result = await fetchWithAuth<{ success: boolean; data: any }>(
    `${API_BASE_URL}/api/kiro/accounts/${accountId}`,
    { method: 'DELETE' }
  );
  return result.data;
}

/**
 * 轮询Kiro OAuth授权状态
 */
export async function pollKiroOAuthStatus(state: string): Promise<{
  success: boolean;
  status: 'pending' | 'completed' | 'failed' | 'expired';
  message?: string;
  data?: any;
}> {
  return fetchWithAuth<{
    success: boolean;
    status: 'pending' | 'completed' | 'failed' | 'expired';
    message?: string;
    data?: any;
  }>(
    `${API_BASE_URL}/api/kiro/oauth/status/${state}`,
    { method: 'GET' }
  );
}
