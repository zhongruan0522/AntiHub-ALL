import express from 'express';
import { Readable } from 'stream';
import oauthService from '../services/oauth.service.js';
import accountService from '../services/account.service.js';
import quotaService from '../services/quota.service.compat.js';
import userService from '../services/user.service.js';
import projectService from '../services/project.service.js';
import multiAccountClient from '../api/multi_account_client.js';
import { generateRequestBody, dumpErrorArtifacts } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import { countStringTokens } from '../utils/token_counter.js';

const router = express.Router();

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  if (typeof value === 'string') return value;
  return '';
}

function resolveAccountType(headers) {
  const raw =
    normalizeHeaderValue(headers?.['x-account-type']) ||
    normalizeHeaderValue(headers?.['x-api-type']) ||
    '';
  const normalized = raw.trim().toLowerCase();
  return normalized || 'antigravity';
}

function inferAccountTypeFromModel(model) {
  const normalized = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!normalized) return null;
  if (normalized.startsWith('qwen')) return 'qwen';
  if (normalized === 'vision-model') return 'qwen';
  return null;
}

function normalizeSubscriptionTier(rawTier) {
  if (!rawTier) return null;
  const value = String(rawTier);
  const upper = value.toUpperCase();
  if (upper.includes('ULTRA')) return 'ULTRA';
  if (upper.includes('PRO')) return 'PRO';
  if (upper.includes('FREE')) return 'FREE';
  return value;
}

/**
 * API Key认证中间件
 * 从Authorization: Bearer sk-xxx 中提取API Key并验证
 */
const authenticateApiKey = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '缺少Authorization请求头' });
  }

  const apiKey = authHeader.slice(7);
  
  // 检查是否是管理员API Key（从配置文件读取）
  if (apiKey === config.security?.adminApiKey) {
    req.isAdmin = true;
    req.user = { user_id: 'admin', api_key: apiKey };
    return next();
  }

  // 验证用户API Key
  const user = await userService.validateApiKey(apiKey);
  if (!user) {
    return res.status(401).json({ error: '无效的API Key' });
  }

  req.user = user;
  req.isAdmin = false;
  next();
};

/**
 * 管理员认证中间件
 */
const requireAdmin = (req, res, next) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
};

// ==================== 用户管理API ====================

/**
 * 获取当前用户信息
 * GET /api/user/me
 */
router.get('/api/user/me', authenticateApiKey, async (req, res) => {
  try {
    // 隐藏敏感信息（不返回api_key的完整值）
    const safeUser = {
      user_id: req.user.user_id,
      name: req.user.name,
      prefer_shared: req.user.prefer_shared,
      status: req.user.status,
      created_at: req.user.created_at,
      updated_at: req.user.updated_at
    };

    res.json({
      success: true,
      data: safeUser
    });
  } catch (error) {
    logger.error('获取用户信息失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 创建用户（管理员接口）
 * POST /api/users
 * Body: { name }
 */
router.post('/api/users', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    const user = await userService.createUser({ name });

    res.json({
      success: true,
      message: '用户创建成功',
      data: {
        user_id: user.user_id,
        api_key: user.api_key,
        name: user.name,
        created_at: user.created_at
      }
    });
  } catch (error) {
    logger.error('创建用户失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取所有用户列表（管理员接口）
 * GET /api/users
 */
router.get('/api/users', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const users = await userService.getAllUsers();
    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    logger.error('获取用户列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 重新生成API Key（管理员接口）
 * POST /api/users/:user_id/regenerate-key
 */
router.post('/api/users/:user_id/regenerate-key', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;
    const user = await userService.regenerateApiKey(user_id);

    res.json({
      success: true,
      message: 'API Key已重新生成',
      data: {
        user_id: user.user_id,
        api_key: user.api_key
      }
    });
  } catch (error) {
    logger.error('重新生成API Key失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新用户状态（管理员接口）
 * PUT /api/users/:user_id/status
 * Body: { status }
 */
router.put('/api/users/:user_id/status', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;
    const { status } = req.body;

    if (status !== 0 && status !== 1) {
      return res.status(400).json({ error: 'status必须是0或1' });
    }

    const user = await userService.updateUserStatus(user_id, status);

    res.json({
      success: true,
      message: `用户状态已更新为${status === 1 ? '启用' : '禁用'}`,
      data: {
        user_id: user.user_id,
        status: user.status
      }
    });
  } catch (error) {
    logger.error('更新用户状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新用户Cookie优先级
 * PUT /api/users/:user_id/preference
 * Body: { prefer_shared }
 */
router.put('/api/users/:user_id/preference', authenticateApiKey, async (req, res) => {
  try {
    const { user_id } = req.params;
    const { prefer_shared } = req.body;

    // 检查权限（只能修改自己的设置，管理员可以修改所有）
    if (!req.isAdmin && user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权修改此用户的设置' });
    }

    if (prefer_shared !== 0 && prefer_shared !== 1) {
      return res.status(400).json({ error: 'prefer_shared必须是0或1' });
    }

    const user = await userService.updateUserPreference(user_id, prefer_shared);

    res.json({
      success: true,
      message: `Cookie优先级已更新为${prefer_shared === 1 ? '共享优先' : '专属优先'}`,
      data: {
        user_id: user.user_id,
        prefer_shared: user.prefer_shared
      }
    });
  } catch (error) {
    logger.error('更新用户优先级失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 删除用户（管理员接口）
 * DELETE /api/users/:user_id
 */
router.delete('/api/users/:user_id', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;
    const deleted = await userService.deleteUser(user_id);

    if (!deleted) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({
      success: true,
      message: '用户已删除'
    });
  } catch (error) {
    logger.error('删除用户失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== OAuth相关API ====================

/**
 * 获取OAuth授权URL
 * POST /api/oauth/authorize
 * Body: { is_shared }
 * 使用API Key中的用户信息
 */
router.post('/api/oauth/authorize', authenticateApiKey, async (req, res) => {
  try {
    const { is_shared = 0 } = req.body;

    const result = oauthService.generateAuthUrl(req.user.user_id, is_shared);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('生成OAuth URL失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * OAuth回调处理
 * GET /api/oauth/callback?code=xxx&state=xxx
 * 无需认证，由Google OAuth自动回调
 */
router.get('/api/oauth/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  // 设置HTML响应头
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (oauthError) {
    logger.error('OAuth授权失败:', oauthError);
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>授权失败</title></head>
      <body>
        <h1>授权失败</h1>
        <p>错误: ${oauthError}</p>
        <p>请关闭此页面并重新尝试授权。</p>
      </body>
      </html>
    `);
  }

  if (!code || !state) {
    logger.error('OAuth回调缺少参数:', { code: !!code, state: !!state });
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>授权失败</title></head>
      <body>
        <h1>授权失败</h1>
        <p>缺少必要的参数。</p>
        <p>请关闭此页面并重新尝试授权。</p>
      </body>
      </html>
    `);
  }

  try {
    logger.info('收到OAuth回调，正在处理...');
    const account = await oauthService.handleCallback(code, state);
    
    logger.info(`OAuth授权成功: cookie_id=${account.cookie_id}`);
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>授权成功</title></head>
      <body>
        <h1>授权成功！</h1>
        <p>账号已成功添加，可以关闭此页面。</p>
        <p>Cookie ID: ${account.cookie_id}</p>
      </body>
      </html>
    `);
  } catch (error) {
    logger.error('OAuth回调处理失败:', error.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>授权失败</title></head>
      <body>
        <h1>授权失败</h1>
        <p>错误: ${error.message}</p>
        <p>请关闭此页面并重新尝试授权。</p>
      </body>
      </html>
    `);
  }
});

/**
 * 手动提交OAuth回调URL
 * POST /api/oauth/callback/manual
 * Body: { callback_url }
 * 用于用户手动粘贴授权后的完整回调URL
 */
router.post('/api/oauth/callback/manual', authenticateApiKey, async (req, res) => {
  try {
    const { callback_url } = req.body;

    if (!callback_url) {
      return res.status(400).json({ error: '缺少callback_url参数' });
    }

    // 解析回调URL
    let url;
    try {
      url = new URL(callback_url);
    } catch (error) {
      return res.status(400).json({ error: '无效的URL格式' });
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError) {
      return res.status(400).json({
        error: `OAuth授权失败: ${oauthError}`
      });
    }

    if (!code || !state) {
      return res.status(400).json({
        error: '回调URL中缺少code或state参数'
      });
    }

    logger.info('收到手动提交的OAuth回调');
    const account = await oauthService.handleCallback(code, state);

    res.json({
      success: true,
      message: '账号添加成功',
      data: {
        cookie_id: account.cookie_id,
        user_id: account.user_id,
        is_shared: account.is_shared,
        project_id_0: account.project_id_0,
        is_restricted: account.is_restricted,
        ineligible: account.ineligible,
        created_at: account.created_at
      }
    });
  } catch (error) {
    logger.error('处理手动OAuth回调失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== 账号管理API ====================

/**
 * 通过 Refresh Token 导入账号（无需走 OAuth 授权流程）
 * POST /api/accounts/import
 * Body: { refresh_token, is_shared }
 */
router.post('/api/accounts/import', authenticateApiKey, async (req, res) => {
  try {
    const { refresh_token, is_shared = 0 } = req.body;

    if (!refresh_token || typeof refresh_token !== 'string' || !refresh_token.trim()) {
      return res.status(400).json({ error: '缺少refresh_token参数' });
    }

    if (is_shared !== 0 && is_shared !== 1) {
      return res.status(400).json({ error: 'is_shared必须是0或1' });
    }

    const account = await oauthService.importAccountByRefreshToken({
      user_id: req.user.user_id,
      is_shared,
      refresh_token
    });

    res.json({
      success: true,
      message: '账号导入成功',
      data: {
        cookie_id: account.cookie_id,
        user_id: account.user_id,
        is_shared: account.is_shared,
        name: account.name,
        email: account.email,
        project_id_0: account.project_id_0,
        is_restricted: account.is_restricted,
        paid_tier: account.paid_tier,
        ineligible: account.ineligible,
        created_at: account.created_at
      }
    });
  } catch (error) {
    logger.error('导入账号失败:', error.message);

    if (error?.isInvalidGrant) {
      return res.status(400).json({ error: 'refresh_token无效或已失效，请重新授权后再导入' });
    }

    // 常见的可预期错误（如邮箱重复、账号不合格等）用 400 返回，方便前端提示
    const message = typeof error?.message === 'string' ? error.message : '导入失败';
    const isExpected =
      message.includes('此邮箱已被添加过') ||
      message.includes('此Refresh Token已被导入') ||
      message.includes('没有资格使用Antigravity') ||
      message.includes('未获取到refresh_token') ||
      message.includes('缺少refresh_token参数');

    return res.status(isExpected ? 400 : 500).json({ error: message });
  }
});

/**
 * 获取当前用户的账号列表
 * GET /api/accounts
 */
router.get('/api/accounts', authenticateApiKey, async (req, res) => {
  try {
    const accounts = await accountService.getAccountsByUserId(req.user.user_id);

    // 隐藏敏感信息
    const safeAccounts = accounts.map(acc => ({
      cookie_id: acc.cookie_id,
      user_id: acc.user_id,
      name: acc.name,
      is_shared: acc.is_shared,
      status: acc.status,
      need_refresh: acc.need_refresh,
      expires_at: acc.expires_at,
      project_id_0: acc.project_id_0,
      is_restricted: acc.is_restricted,
      paid_tier: acc.paid_tier,
      ineligible: acc.ineligible,
      last_used_at: acc.last_used_at,
      created_at: acc.created_at,
      updated_at: acc.updated_at
    }));

    res.json({
      success: true,
      data: safeAccounts
    });
  } catch (error) {
    logger.error('获取账号列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取单个账号信息
 * GET /api/accounts/:cookie_id
 */
router.get('/api/accounts/:cookie_id', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const account = await accountService.getAccountByCookieId(cookie_id);

    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }

    // 检查权限（只能查看自己的账号，管理员可以查看所有）
    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号' });
    }

    // 隐藏敏感信息
    const safeAccount = {
      cookie_id: account.cookie_id,
      user_id: account.user_id,
      name: account.name,
      is_shared: account.is_shared,
      status: account.status,
      need_refresh: account.need_refresh,
      expires_at: account.expires_at,
      project_id_0: account.project_id_0,
      is_restricted: account.is_restricted,
      paid_tier: account.paid_tier,
      ineligible: account.ineligible,
      created_at: account.created_at,
      updated_at: account.updated_at
    };

    res.json({
      success: true,
      data: safeAccount
    });
  } catch (error) {
    logger.error('获取账号信息失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 导出账号凭证（敏感信息）
 * GET /api/accounts/:cookie_id/credentials
 *
 * 说明：
 * - 仅账号所有者/管理员可访问
 * - 用于前端“复制凭证为JSON”
 */
router.get('/api/accounts/:cookie_id/credentials', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const account = await accountService.getAccountByCookieId(cookie_id);

    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }

    // 检查权限（只能查看自己的账号，管理员可以查看所有）
    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号' });
    }

    const credentials = {
      type: 'antigravity',
      cookie_id: account.cookie_id,
      is_shared: account.is_shared,
      access_token: account.access_token,
      refresh_token: account.refresh_token,
      expires_at: account.expires_at,
    };

    // 过滤空值，避免导出无意义字段（0/false 需要保留）
    const exportData = Object.fromEntries(
      Object.entries(credentials).filter(([, value]) => {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string' && value.trim() === '') return false;
        return true;
      })
    );

    res.json({ success: true, data: exportData });
  } catch (error) {
    logger.error('导出账号凭证失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 手动刷新账号（强制刷新 access_token + 更新 project_id_0）
 * POST /api/accounts/:cookie_id/refresh
 */
router.post('/api/accounts/:cookie_id/refresh', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const account = await accountService.getAccountByCookieId(cookie_id);

    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }

    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号' });
    }

    if (!account.refresh_token) {
      return res.status(400).json({ error: '账号缺少refresh_token，无法刷新' });
    }

    // 1) 强制刷新 access_token
    let accessToken = account.access_token;
    let expiresAt = account.expires_at;
    try {
      const tokenData = await oauthService.refreshAccessToken(account.refresh_token);
      accessToken = tokenData.access_token;
      expiresAt = Date.now() + (tokenData.expires_in * 1000);
      await accountService.updateAccountToken(cookie_id, accessToken, expiresAt);
    } catch (error) {
      if (error?.isInvalidGrant) {
        logger.error(`账号刷新token失败(invalid_grant)，标记需要重新登录: cookie_id=${cookie_id}`);
        await accountService.markAccountNeedRefresh(cookie_id);
        return res.status(400).json({ error: 'refresh_token无效或已失效，请重新授权后再导入' });
      }
      throw error;
    }

    // 2) 更新 project_id_0（必要时走 onboardUser）
    const updated = await projectService.updateAccountProjectIds(cookie_id, accessToken);

    // 隐藏敏感信息
    const safeAccount = {
      cookie_id,
      user_id: account.user_id,
      name: account.name,
      is_shared: account.is_shared,
      status: account.status,
      need_refresh: account.need_refresh,
      expires_at: expiresAt,
      project_id_0: updated?.project_id_0 ?? account.project_id_0,
      is_restricted: updated?.is_restricted ?? account.is_restricted,
      paid_tier: updated?.paid_tier ?? account.paid_tier,
      ineligible: updated?.ineligible ?? account.ineligible,
      created_at: account.created_at,
      updated_at: updated?.updated_at ?? account.updated_at,
    };

    res.json({
      success: true,
      message: '刷新成功',
      data: safeAccount,
    });
  } catch (error) {
    logger.error('刷新账号失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新账号状态
 * PUT /api/accounts/:cookie_id/status
 * Body: { status }
 *
 * 禁用共享账号时：减少用户共享配额池的 quota 和 max_quota
 * 启用共享账号时：增加用户共享配额池的 quota 和 max_quota
 */
/**
 * 获取当前账号可用的 Project ID 列表（仅 Code Assist）
 * GET /api/accounts/:cookie_id/projects
 */
router.get('/api/accounts/:cookie_id/projects', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const account = await accountService.getAccountByCookieId(cookie_id);

    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }

    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号' });
    }

    if (!account.refresh_token) {
      return res.status(400).json({ error: '账号缺少refresh_token，无法获取项目列表' });
    }

    // 确保 access_token 可用（过期则刷新）
    let accessToken = account.access_token;
    if (accountService.isTokenExpired(account)) {
      logger.info(`账号token已过期，正在刷新: cookie_id=${cookie_id}`);
      const tokenData = await oauthService.refreshAccessToken(account.refresh_token);
      const expires_at = Date.now() + (tokenData.expires_in * 1000);
      accessToken = tokenData.access_token;
      await accountService.updateAccountToken(cookie_id, accessToken, expires_at);
    }

    const currentProjectId = typeof account.project_id_0 === 'string' ? account.project_id_0.trim() : '';

    // Antigravity/Code Assist 实际使用的项目：cloudaicompanionProject（来自 loadCodeAssist / onboardUser）
    let codeAssistProjectId = '';
    try {
      const projectData = await projectService.loadCodeAssist(accessToken);
      codeAssistProjectId = projectService.extractProjectId(projectData?.cloudaicompanionProject);

      // 没返回 cloudaicompanionProject 时，按 CLIProxyAPI 的逻辑尝试 onboardUser 拿到真实 project_id
      if (!codeAssistProjectId) {
        const tierId = projectService.getDefaultTierId(projectData);
        codeAssistProjectId = await projectService.onboardUser(accessToken, tierId);
      }
    } catch (error) {
      logger.warn(`[projects] loadCodeAssist/onboardUser failed: cookie_id=${cookie_id}, error=${error?.message || error}`);
    }

    // 优先建议 Code Assist project（这才是 Antigravity 上游真正用的 project）
    const defaultProjectId = codeAssistProjectId || currentProjectId || '';

    const safeProjects = [];
    const pushUniqueProjectItem = (projectId, name) => {
      const pid = typeof projectId === 'string' ? projectId.trim() : '';
      if (!pid) return;
      if (safeProjects.some((p) => p.project_id === pid)) return;
      safeProjects.push({ project_id: pid, name: name || '' });
    };

    pushUniqueProjectItem(defaultProjectId, codeAssistProjectId ? 'cloudaicompanionProject' : 'default');
    pushUniqueProjectItem(currentProjectId, 'current');

    res.json({
      success: true,
      data: {
        cookie_id,
        current_project_id: currentProjectId || '',
        default_project_id: defaultProjectId || '',
        projects: safeProjects,
      },
    });
  } catch (error) {
    logger.error('获取项目列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新账号自定义 Project ID（优先使用）
 * PUT /api/accounts/:cookie_id/project-id
 * Body: { project_id }
 */
router.put('/api/accounts/:cookie_id/project-id', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const project_id = typeof req.body?.project_id === 'string' ? req.body.project_id.trim() : '';

    if (!project_id) {
      return res.status(400).json({ error: 'project_id不能为空' });
    }

    const account = await accountService.getAccountByCookieId(cookie_id);
    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }

    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号' });
    }

    const updatedAccount = await accountService.updateProjectIds(
      cookie_id,
      project_id,
      account.is_restricted,
      account.ineligible,
      account.paid_tier
    );

    const safeAccount = {
      cookie_id: updatedAccount.cookie_id,
      user_id: updatedAccount.user_id,
      name: updatedAccount.name,
      is_shared: updatedAccount.is_shared,
      status: updatedAccount.status,
      need_refresh: updatedAccount.need_refresh,
      expires_at: updatedAccount.expires_at,
      project_id_0: updatedAccount.project_id_0,
      is_restricted: updatedAccount.is_restricted,
      paid_tier: updatedAccount.paid_tier,
      ineligible: updatedAccount.ineligible,
      last_used_at: updatedAccount.last_used_at,
      created_at: updatedAccount.created_at,
      updated_at: updatedAccount.updated_at,
    };

    res.json({
      success: true,
      message: 'Project ID已更新',
      data: safeAccount,
    });
  } catch (error) {
    logger.error('更新Project ID失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/accounts/:cookie_id/detail', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const account = await accountService.getAccountByCookieId(cookie_id);

    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }

    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号' });
    }

    // 确保 access_token 可用（过期则刷新）
    if (accountService.isTokenExpired(account)) {
      logger.info(`账号token已过期，正在刷新: cookie_id=${cookie_id}`);
      try {
        const tokenData = await oauthService.refreshAccessToken(account.refresh_token);
        const expires_at = Date.now() + (tokenData.expires_in * 1000);
        await accountService.updateAccountToken(cookie_id, tokenData.access_token, expires_at);
        account.access_token = tokenData.access_token;
        account.expires_at = expires_at;
      } catch (refreshError) {
        if (refreshError?.isInvalidGrant) {
          logger.error(`账号刷新token失败(invalid_grant)，禁用账号: cookie_id=${cookie_id}`);
          await accountService.updateAccountStatus(cookie_id, 0);
        }
        throw refreshError;
      }
    }

    // 1) 邮箱：优先使用落库值；缺失则尝试实时获取（不强依赖）
    let email = account.email ?? null;
    if (!email) {
      try {
        const userInfo = await oauthService.getUserInfo(account.access_token);
        email = userInfo?.email ?? null;
      } catch (e) {
        logger.warn(`获取账号邮箱失败: cookie_id=${cookie_id}, error=${e?.message || e}`);
      }
    }

    // 2) 订阅层级：通过 loadCodeAssist 的 paidTier/currentTier 推断
    let subscription_tier_raw = null;
    let subscription_tier = null;
    try {
      const projectData = await projectService.loadCodeAssist(account.access_token);
      subscription_tier_raw = projectData?.paidTier?.id || projectData?.currentTier?.id || null;
      subscription_tier = normalizeSubscriptionTier(subscription_tier_raw);
    } catch (e) {
      logger.warn(`获取订阅层级失败: cookie_id=${cookie_id}, error=${e?.message || e}`);
    }

    res.json({
      success: true,
      data: {
        cookie_id: account.cookie_id,
        name: account.name,
        email,
        created_at: account.created_at,
        paid_tier: account.paid_tier ?? false,
        subscription_tier,
        subscription_tier_raw
      }
    });
  } catch (error) {
    logger.error('获取账号详情失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/accounts/:cookie_id/status', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const { status } = req.body;

    if (status !== 0 && status !== 1) {
      return res.status(400).json({ error: 'status必须是0或1' });
    }

    // 检查权限
    const existingAccount = await accountService.getAccountByCookieId(cookie_id);
    if (!existingAccount) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (!req.isAdmin && existingAccount.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权修改此账号' });
    }

    // 如果状态没有变化，直接返回
    if (existingAccount.status === status) {
      return res.json({
        success: true,
        message: '账号状态未变化',
        data: {
          cookie_id: existingAccount.cookie_id,
          status: existingAccount.status
        }
      });
    }

    // 如果是共享账号，需要处理配额变化
    if (existingAccount.is_shared === 1) {
      const accountQuotas = await quotaService.getQuotasByCookieId(cookie_id);
      
      if (status === 0) {
        // 禁用共享账号：减少用户共享配额池的 quota 和 max_quota
        logger.info(`禁用共享账号，正在减少用户共享配额: cookie_id=${cookie_id}, user_id=${existingAccount.user_id}`);
        
        for (const quota of accountQuotas) {
          try {
            await quotaService.removeUserSharedQuota(
              existingAccount.user_id,
              quota.model_name,
              quota.quota
            );
            logger.info(`已减少共享配额: user_id=${existingAccount.user_id}, model=${quota.model_name}, quota=${quota.quota}`);
          } catch (quotaError) {
            logger.error(`减少共享配额失败: model=${quota.model_name}, error=${quotaError.message}`);
          }
        }
      } else {
        // 启用共享账号：增加用户共享配额池的 quota 和 max_quota
        logger.info(`启用共享账号，正在增加用户共享配额: cookie_id=${cookie_id}, user_id=${existingAccount.user_id}`);
        
        for (const quota of accountQuotas) {
          try {
            await quotaService.addUserSharedQuota(
              existingAccount.user_id,
              quota.model_name,
              quota.quota
            );
            logger.info(`已增加共享配额: user_id=${existingAccount.user_id}, model=${quota.model_name}, quota=${quota.quota}`);
          } catch (quotaError) {
            logger.error(`增加共享配额失败: model=${quota.model_name}, error=${quotaError.message}`);
          }
        }
      }
    }

    const account = await accountService.updateAccountStatus(cookie_id, status);

    res.json({
      success: true,
      message: `账号状态已更新为${status === 1 ? '启用' : '禁用'}`,
      data: {
        cookie_id: account.cookie_id,
        status: account.status
      }
    });
  } catch (error) {
    logger.error('更新账号状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新账号名称
 * PUT /api/accounts/:cookie_id/name
 * Body: { name }
 */
router.put('/api/accounts/:cookie_id/name', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const { name } = req.body;

    if (name === undefined || name === null) {
      return res.status(400).json({ error: 'name是必需的' });
    }

    if (typeof name !== 'string' || name.length > 100) {
      return res.status(400).json({ error: 'name必须是字符串且长度不超过100' });
    }

    // 检查权限
    const existingAccount = await accountService.getAccountByCookieId(cookie_id);
    if (!existingAccount) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (!req.isAdmin && existingAccount.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权修改此账号' });
    }

    const account = await accountService.updateAccountName(cookie_id, name);

    res.json({
      success: true,
      message: '账号名称已更新',
      data: {
        cookie_id: account.cookie_id,
        name: account.name
      }
    });
  } catch (error) {
    logger.error('更新账号名称失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 删除账号
 * DELETE /api/accounts/:cookie_id
 */
router.delete('/api/accounts/:cookie_id', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;

    // 检查权限
    const existingAccount = await accountService.getAccountByCookieId(cookie_id);
    if (!existingAccount) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (!req.isAdmin && existingAccount.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权删除此账号' });
    }

    // 如果是共享账号，需要移除用户共享配额池中的配额
    if (existingAccount.is_shared === 1) {
      logger.info(`删除共享账号，正在移除用户共享配额: cookie_id=${cookie_id}, user_id=${existingAccount.user_id}`);
      
      // 获取该账号的配额信息
      const accountQuotas = await quotaService.getQuotasByCookieId(cookie_id);
      
      // 移除每个模型的配额
      for (const quota of accountQuotas) {
        try {
          await quotaService.removeUserSharedQuota(
            existingAccount.user_id,
            quota.model_name,
            quota.quota  // 使用账号的实际配额值
          );
          logger.info(`已移除共享配额: user_id=${existingAccount.user_id}, model=${quota.model_name}, quota=${quota.quota}`);
        } catch (quotaError) {
          logger.error(`移除共享配额失败: model=${quota.model_name}, error=${quotaError.message}`);
          // 继续处理其他模型，不中断删除流程
        }
      }
    }

    await accountService.deleteAccount(cookie_id);

    res.json({
      success: true,
      message: '账号已删除'
    });
  } catch (error) {
    logger.error('删除账号失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 转换账号类型（专属/共享）
 * PUT /api/accounts/:cookie_id/type
 * Body: { is_shared }
 *
 * 专属账号(is_shared=0) → 共享账号(is_shared=1)：增加用户共享配额
 * 共享账号(is_shared=1) → 专属账号(is_shared=0)：减少用户共享配额
 */
router.put('/api/accounts/:cookie_id/type', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;
    const { is_shared } = req.body;

    if (is_shared !== 0 && is_shared !== 1) {
      return res.status(400).json({ error: 'is_shared必须是0或1' });
    }

    // 检查权限
    const existingAccount = await accountService.getAccountByCookieId(cookie_id);
    if (!existingAccount) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (!req.isAdmin && existingAccount.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权修改此账号' });
    }

    // 如果类型没有变化，直接返回
    if (existingAccount.is_shared === is_shared) {
      return res.json({
        success: true,
        message: '账号类型未变化',
        data: {
          cookie_id: existingAccount.cookie_id,
          is_shared: existingAccount.is_shared
        }
      });
    }

    // 获取该账号的配额信息
    const accountQuotas = await quotaService.getQuotasByCookieId(cookie_id);

    if (is_shared === 1) {
      // 专属账号 → 共享账号：增加用户共享配额
      logger.info(`账号类型转换: 专属→共享, cookie_id=${cookie_id}, user_id=${existingAccount.user_id}`);
      
      for (const quota of accountQuotas) {
        try {
          await quotaService.addUserSharedQuota(
            existingAccount.user_id,
            quota.model_name,
            quota.quota
          );
          logger.info(`已增加共享配额: user_id=${existingAccount.user_id}, model=${quota.model_name}, quota=${quota.quota}`);
        } catch (quotaError) {
          logger.error(`增加共享配额失败: model=${quota.model_name}, error=${quotaError.message}`);
        }
      }
    } else if (accountType === 'qwen') {
      const qwenClient = (await import('../api/qwen_client.js')).default;
      res.json(qwenClient.getAvailableModels());
    } else {
      // 共享账号 → 专属账号：减少用户共享配额
      logger.info(`账号类型转换: 共享→专属, cookie_id=${cookie_id}, user_id=${existingAccount.user_id}`);
      
      for (const quota of accountQuotas) {
        try {
          await quotaService.removeUserSharedQuota(
            existingAccount.user_id,
            quota.model_name,
            quota.quota
          );
          logger.info(`已移除共享配额: user_id=${existingAccount.user_id}, model=${quota.model_name}, quota=${quota.quota}`);
        } catch (quotaError) {
          logger.error(`移除共享配额失败: model=${quota.model_name}, error=${quotaError.message}`);
        }
      }
    }

    // 更新账号类型
    const updatedAccount = await accountService.updateAccountSharedType(cookie_id, is_shared);

    res.json({
      success: true,
      message: `账号类型已更新为${is_shared === 1 ? '共享' : '专属'}`,
      data: {
        cookie_id: updatedAccount.cookie_id,
        is_shared: updatedAccount.is_shared
      }
    });
  } catch (error) {
    logger.error('转换账号类型失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== 配额管理API ====================

/**
 * 获取账号的配额信息
 * GET /api/accounts/:cookie_id/quotas
 * 从API实时查询并更新数据库
 */
router.get('/api/accounts/:cookie_id/quotas', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id } = req.params;

    // 检查权限
    const account = await accountService.getAccountByCookieId(cookie_id);
    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号的配额信息' });
    }

    // 检查token是否过期，如果过期则刷新
    if (accountService.isTokenExpired(account)) {
      logger.info(`账号token已过期，正在刷新: cookie_id=${cookie_id}`);
      try {
        const tokenData = await oauthService.refreshAccessToken(account.refresh_token);
        const expires_at = Date.now() + (tokenData.expires_in * 1000);
        await accountService.updateAccountToken(cookie_id, tokenData.access_token, expires_at);
        account.access_token = tokenData.access_token;
      } catch (refreshError) {
        // 如果是 invalid_grant 错误，直接禁用账号
        if (refreshError.isInvalidGrant) {
          logger.error(`账号刷新token失败(invalid_grant)，禁用账号: cookie_id=${cookie_id}`);
          await accountService.updateAccountStatus(cookie_id, 0);
        }
        throw refreshError;
      }
    }

    // 从API获取最新配额信息（使用两个projectId）
    logger.info(`从API获取配额信息: cookie_id=${cookie_id}`);
    
    let modelsData = {};
    
    // 使用 project_id_0 获取配额
    try {
      const pid0 = account.project_id_0 || '';
      logger.info(`  使用 project_id_0: ${pid0 || '(空)'}`);
      const response0 = await fetch(config.api.modelsUrl, {
        method: 'POST',
        headers: {
          'Host': config.api.host,
          'User-Agent': config.api.userAgent,
          'Authorization': `Bearer ${account.access_token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        body: JSON.stringify({ project: pid0 })
      });

      if (response0.ok) {
        const data0 = await response0.json();
        modelsData = data0.models || {};
        logger.info(`  project_id_0 获取成功: ${Object.keys(modelsData).length} 个模型`);
      } else {
        logger.warn(`  project_id_0 获取失败: ${response0.status}`);
      }
    } catch (error) {
      logger.warn(`  project_id_0 获取失败: ${error.message}`);
    }

    // 更新配额信息到数据库
    if (Object.keys(modelsData).length > 0) {
      await quotaService.updateQuotasFromModels(cookie_id, modelsData);
      logger.info(`配额信息已更新: cookie_id=${cookie_id}`);
    } else {
      throw new Error('无法获取配额信息');
    }

    // 从数据库获取更新后的配额
    const quotas = await quotaService.getQuotasByCookieId(cookie_id);

    // reset_time 是本地时间,移除 Z 标志
    const formattedQuotas = quotas.map(q => ({
      ...q,
      reset_time: q.reset_time ? q.reset_time.replace('Z', '') : q.reset_time
    }));

    res.json({
      success: true,
      data: formattedQuotas
    });
  } catch (error) {
    logger.error('获取配额信息失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新指定cookie的指定模型状态
 * PUT /api/accounts/:cookie_id/quotas/:model_name/status
 * Body: { status }
 */
router.put('/api/accounts/:cookie_id/quotas/:model_name/status', authenticateApiKey, async (req, res) => {
  try {
    const { cookie_id, model_name } = req.params;
    const { status } = req.body;

    if (status !== 0 && status !== 1) {
      return res.status(400).json({ error: 'status必须是0或1' });
    }

    // 检查权限
    const account = await accountService.getAccountByCookieId(cookie_id);
    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }
    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权修改此账号的配额' });
    }

    const quota = await quotaService.updateModelQuotaStatus(cookie_id, model_name, status);

    res.json({
      success: true,
      message: `模型配额状态已更新为${status === 1 ? '启用' : '禁用'}`,
      data: {
        cookie_id: quota.cookie_id,
        model_name: quota.model_name,
        status: quota.status
      }
    });
  } catch (error) {
    logger.error('更新模型配额状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取配额即将耗尽的模型（管理员接口）
 * GET /api/quotas/low?threshold=0.1
 */
router.get('/api/quotas/low', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const threshold = parseFloat(req.query.threshold) || 0.1;
    const lowQuotas = await quotaService.getLowQuotaModels(threshold);

    res.json({
      success: true,
      data: lowQuotas
    });
  } catch (error) {
    logger.error('获取低配额模型失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取当前用户的聚合配额
 * GET /api/quotas/user
 */
router.get('/api/quotas/user', authenticateApiKey, async (req, res) => {
  try {
    const quotas = await quotaService.getUserQuotas(req.user.user_id);

    res.json({
      success: true,
      data: quotas
    });
  } catch (error) {
    logger.error('获取用户配额失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取共享池的聚合配额
 * GET /api/quotas/shared-pool
 *
 * 注意：此接口会自动检查并刷新配额已过期（reset_time 在当前时间之前）的账号，
 * 确保返回的统计数据是最新的。
 */
router.get('/api/quotas/shared-pool', authenticateApiKey, async (req, res) => {
  try {
    // 首先检查是否有配额已过期的账号需要刷新
    const expiredAccounts = await quotaService.getExpiredQuotaSharedAccounts();
    
    if (expiredAccounts.length > 0) {
      logger.info(`发现 ${expiredAccounts.length} 个配额已过期的账号，正在刷新...`);
      
      // 并行刷新所有过期账号的配额
      const refreshPromises = expiredAccounts.map(async (account) => {
        try {
          // 检查token是否过期，如果过期则刷新
          let accessToken = account.access_token;
          if (accountService.isTokenExpired(account)) {
            logger.info(`账号token已过期，正在刷新: cookie_id=${account.cookie_id}`);
            try {
              const tokenData = await oauthService.refreshAccessToken(account.refresh_token);
              const expires_at = Date.now() + (tokenData.expires_in * 1000);
              await accountService.updateAccountToken(account.cookie_id, tokenData.access_token, expires_at);
              accessToken = tokenData.access_token;
            } catch (refreshError) {
              // 如果是 invalid_grant 错误，直接禁用账号
              if (refreshError.isInvalidGrant) {
                logger.error(`账号刷新token失败(invalid_grant)，禁用账号: cookie_id=${account.cookie_id}`);
                await accountService.updateAccountStatus(account.cookie_id, 0);
              }
              // 继续处理其他账号，不抛出错误
              logger.warn(`刷新账号配额失败: cookie_id=${account.cookie_id}, error=${refreshError.message}`);
              return;
            }
          }
          
          // 刷新配额
          await multiAccountClient.refreshCookieQuota(account.cookie_id, accessToken);
          logger.info(`已刷新账号配额: cookie_id=${account.cookie_id}`);
        } catch (error) {
          logger.warn(`刷新账号配额失败: cookie_id=${account.cookie_id}, error=${error.message}`);
          // 如果是token刷新失败，标记账号需要重新授权
          if (error.message.includes('refresh') || error.message.includes('token')) {
            await accountService.markAccountNeedRefresh(account.cookie_id);
          }
        }
      });
      
      // 等待所有刷新完成
      await Promise.all(refreshPromises);
      logger.info(`配额刷新完成`);
    }
    
    // 获取更新后的配额统计
    const quotas = await quotaService.getSharedPoolQuotas();

    // earliest_reset_time 是本地时间,移除 Z 标志
    const formattedQuotas = quotas.map(q => ({
      ...q,
      earliest_reset_time: q.earliest_reset_time ? q.earliest_reset_time.replace('Z', '') : q.earliest_reset_time
    }));

    // 获取用户的所有配额消费总计（包括共享和专属）
    const userConsumption = await quotaService.getUserTotalConsumption(req.user.user_id);

    res.json({
      success: true,
      data: {
        quotas: formattedQuotas,
        user_consumption: {
          total_requests: parseInt(userConsumption.total_requests) || 0,
          total_quota_consumed: parseFloat(userConsumption.total_quota_consumed) || 0,
          shared_quota_consumed: parseFloat(userConsumption.shared_quota_consumed) || 0,
          private_quota_consumed: parseFloat(userConsumption.private_quota_consumed) || 0
        }
      }
    });
  } catch (error) {
    logger.error('获取共享池配额失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取用户的消耗记录
 * GET /api/quotas/consumption?limit=100&start_date=2025-11-01&end_date=2025-11-30
 */
router.get('/api/quotas/consumption', authenticateApiKey, async (req, res) => {
  try {
    const { limit, start_date, end_date } = req.query;
    
    const options = {};
    if (limit) options.limit = parseInt(limit);
    if (start_date) options.start_date = new Date(start_date);
    if (end_date) options.end_date = new Date(end_date);

    const consumption = await quotaService.getUserConsumption(req.user.user_id, options);

    res.json({
      success: true,
      data: consumption
    });
  } catch (error) {
    logger.error('获取用户消耗记录失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取用户某个模型的消耗统计
 * GET /api/quotas/consumption/stats/:model_name
 */
router.get('/api/quotas/consumption/stats/:model_name', authenticateApiKey, async (req, res) => {
  try {
    const { model_name } = req.params;
    const stats = await quotaService.getUserModelConsumptionStats(req.user.user_id, model_name);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('获取用户模型消耗统计失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== OpenAI兼容接口 ====================

/**
 * 获取模型列表
 * GET /v1/models
 * Header: X-Account-Type: antigravity (默认) / kiro / qwen
 */
router.get('/v1/models', authenticateApiKey, async (req, res) => {
  try {
    // 从请求头获取账号类型，默认为 antigravity
    const headerAccountType =
      normalizeHeaderValue(req.headers['x-account-type']) ||
      normalizeHeaderValue(req.headers['x-api-type']);
    const hasExplicitAccountType = !!(headerAccountType && headerAccountType.trim());
    const accountType = resolveAccountType(req.headers);

    // Header 未指定时：返回合并后的模型列表，避免默认走 Antigravity 但用户没账号导致模型列表空白/报错。
    if (!hasExplicitAccountType) {
      const merged = [];

      try {
        const models = await multiAccountClient.getAvailableModels(req.user.user_id);
        if (Array.isArray(models?.data)) {
          merged.push(...models.data);
        }
      } catch (error) {
        logger.warn(`获取 Antigravity models 失败(已忽略): ${error?.message || error}`);
      }

      try {
        const kiroClient = (await import('../api/kiro_client.js')).default;
        const models = kiroClient.getAvailableModels();
        if (Array.isArray(models?.data)) {
          merged.push(...models.data);
        }
      } catch (error) {
        logger.warn(`获取 Kiro models 失败(已忽略): ${error?.message || error}`);
      }

      try {
        const qwenClient = (await import('../api/qwen_client.js')).default;
        const models = qwenClient.getAvailableModels();
        if (Array.isArray(models?.data)) {
          merged.push(...models.data);
        }
      } catch (error) {
        logger.warn(`获取 Qwen models 失败(已忽略): ${error?.message || error}`);
      }

      const created = Math.floor(Date.now() / 1000);
      const deduped = new Map();
      for (const item of merged) {
        const id = typeof item?.id === 'string' ? item.id : null;
        if (!id) continue;
        if (!deduped.has(id)) {
          deduped.set(id, { object: 'model', created, ...item, id });
        }
      }

      return res.json({
        object: 'list',
        data: Array.from(deduped.values()),
      });
    }

    if (accountType === 'kiro') {
      // 使用 kiro 账号系统
      const kiroClient = (await import('../api/kiro_client.js')).default;
      const models = kiroClient.getAvailableModels();
      res.json(models);
    } else if (accountType === 'qwen') {
      // 使用 qwen 账号系统
      const qwenClient = (await import('../api/qwen_client.js')).default;
      res.json(qwenClient.getAvailableModels());
    } else {
      // 使用 antigravity 账号系统（默认）
      const models = await multiAccountClient.getAvailableModels(req.user.user_id);
      res.json(models);
    }
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ error: error.responseText || error.message });
  }
});

/**
 * 聊天补全
 * POST /v1/chat/completions
 * Body: { messages, model, stream, ... }
 * Header: X-Account-Type: antigravity (默认) / kiro / qwen
 */
router.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
  // 设置10分钟超时（避免长对话被断开）
  req.setTimeout(600000); // 10分钟 = 600000毫秒
  res.setTimeout(600000);

  const { messages, model, stream = true, tools, tool_choice, image_config, ...params } = req.body;
  
  // 如果提供了 image_config，将其添加到 params 中
  if (image_config) {
    params.image_config = image_config;
  }

  // 参数验证错误仍返回400
  if (!messages) {
    return res.status(400).json({ error: 'messages是必需的' });
  }

  // 从请求头获取账号类型，默认为 antigravity
  const headerAccountType =
    normalizeHeaderValue(req.headers['x-account-type']) ||
    normalizeHeaderValue(req.headers['x-api-type']);
  const hasExplicitAccountType = !!(headerAccountType && headerAccountType.trim());
  let accountType = resolveAccountType(req.headers);

  // Header 未指定时，允许根据 model 推断路由（例如 qwen3-* -> Qwen）。
  if (!hasExplicitAccountType) {
    const inferred = inferAccountTypeFromModel(model);
    if (inferred) {
      accountType = inferred;
    }
  }

  if (accountType === 'qwen') {
    const qwenClient = (await import('../api/qwen_client.js')).default;

    if (!model) {
      return res.status(400).json({ error: 'model是必需的' });
    }

    const controller = new AbortController();
    const abort = () => {
      try {
        controller.abort();
      } catch {}
    };
    res.on('close', abort);

    try {
      const upstreamBody = { ...req.body };

      // 一些 OpenAI SDK 会发送 max_completion_tokens；Qwen 端通常使用 max_tokens。
      if (typeof upstreamBody.max_completion_tokens === 'number' && upstreamBody.max_tokens == null) {
        upstreamBody.max_tokens = upstreamBody.max_completion_tokens;
      }
      if (upstreamBody.max_completion_tokens != null) {
        delete upstreamBody.max_completion_tokens;
      }

      // 避免把只对 OpenAI/Gemini 有意义的字段原样转发给 Qwen 导致上游报错。
      if (upstreamBody.reasoning_effort != null) {
        delete upstreamBody.reasoning_effort;
      }
      if (upstreamBody.reasoning != null) {
        delete upstreamBody.reasoning;
      }
      if (upstreamBody.image_config != null) {
        delete upstreamBody.image_config;
      }

      // Qwen3 流式模式在未定义 tools 时可能出现“串流污染”，注入一个永远不该被调用的空工具即可规避。
      if (upstreamBody.tools == null || (Array.isArray(upstreamBody.tools) && upstreamBody.tools.length === 0)) {
        upstreamBody.tools = [
          {
            type: 'function',
            function: {
              name: 'do_not_call_me',
              description: 'Do not call this tool under any circumstances.',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          },
        ];
      }

      if (upstreamBody.stream) {
        const streamOptions =
          upstreamBody.stream_options && typeof upstreamBody.stream_options === 'object'
            ? upstreamBody.stream_options
            : {};
        upstreamBody.stream_options = { ...streamOptions, include_usage: true };
      }

      const upstreamResp = await qwenClient.requestChatCompletions({
        user_id: req.user.user_id,
        user: req.user,
        body: upstreamBody,
        signal: controller.signal,
      });

      if (!upstreamResp.ok) {
        const text = await upstreamResp.text().catch(() => '');
        logger.error(
          `Qwen请求失败: status=${upstreamResp.status}, body=${(text || '').slice(0, 2000)}`
        );
        return res
          .status(upstreamResp.status || 500)
          .json({ error: text || `Qwen上游错误: ${upstreamResp.status}` });
      }

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        if (!upstreamResp.body) {
          return res.status(500).json({ error: 'Qwen上游无响应体' });
        }

        const nodeStream = Readable.fromWeb(upstreamResp.body);
        nodeStream.on('error', (err) => {
          logger.warn(`Qwen流式转发失败: ${err?.message || err}`);
          abort();
        });
        nodeStream.pipe(res);
        return;
      }

      const json = await upstreamResp.json();
      return res.status(200).json(json);
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message : 'Qwen请求失败';
      logger.error('Qwen聊天补全失败:', message);
      return res.status(500).json({ error: message });
    }
  }

  if (accountType === 'kiro') {
    // 使用 kiro 账号系统
    const kiroClient = (await import('../api/kiro_client.js')).default;

    if (!model) {
      return res.status(400).json({ error: 'model是必需的' });
    }

    const options = { tools, tool_choice };

    // 模型内置联网（对接 Kiro MCP web_search）
    const getToolName = (t) => (t?.function?.name || t?.name || '').toString();
    const isWebSearchOnly =
      Array.isArray(tools) &&
      tools.length === 1 &&
      getToolName(tools[0]).trim().toLowerCase() === 'web_search';

    const extractTextFromContent = (content) => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('');
      }
      return '';
    };

    const extractWebSearchQuery = (msgs) => {
      let userMsg = null;
      if (Array.isArray(msgs)) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m.role === 'user') {
            userMsg = m;
            break;
          }
        }
      }

      const normalize = (raw) => {
        let q = String(raw || '').trim();
        if (!q) return null;

        const PREFIX = 'Perform a web search for the query: ';
        if (q.startsWith(PREFIX)) q = q.slice(PREFIX.length).trim();

        const m = q.match(/^(?:query|关键词|搜索|查询)\s*[:：]\s*(.+)$/i);
        if (m && m[1]) q = String(m[1]).trim();

        const original = q;

        const stripOnce = (s, prefixes) => {
          for (const p of prefixes) {
            if (s.startsWith(p)) return s.slice(p.length);
          }
          return s;
        };

        let changed = true;
        while (changed) {
          const before = q;
          q = q.replace(/^[\s:：,，。.!?？、]+/u, '');
          q = stripOnce(q, ['箱宝', '请帮我', '可以帮我', '能不能帮我', '帮我', '帮忙', '请你', '麻烦你', '请', '麻烦', '能否', '能不能', '可以']);
          q = stripOnce(q, ['联网', '上网', '在线']);
          q = stripOnce(q, ['查一下', '查下', '查一查', '查查', '查询一下', '搜索一下', '搜一下', '搜下', '搜一搜', '查询', '搜索', '检索', '找一下', '找下', '找', '查']);
          q = q.replace(/^[\s:：,，。.!?？、]+/u, '');
          changed = q !== before;
        }

        q = q.trim();
        if (q.length >= 2) return q;
        return original.trim() || null;
      };

      return normalize(extractTextFromContent(userMsg?.content));
    };

    const extractLastUserText = (msgs) => {
      if (!Array.isArray(msgs)) return '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === 'user') return extractTextFromContent(m.content);
      }
      return '';
    };

    const buildWebSearchSummary = (query, results) => {
      const list = Array.isArray(results?.results) ? results.results : [];
      let summary = `Here are the search results for \"${query}\":\n\n`;

      if (list.length > 0) {
        for (let i = 0; i < list.length; i++) {
          const r = list[i] || {};
          const title = (r.title || '').toString();
          const url = (r.url || '').toString();
          const snippet = r.snippet != null ? String(r.snippet) : '';

          summary += `${i + 1}. **${title}**\n`;
          if (snippet) {
            const truncated = snippet.length > 200 ? `${snippet.slice(0, 200)}...` : snippet;
            summary += `   ${truncated}\n`;
          }
          summary += `   Source: ${url}\n\n`;
        }
      } else {
        summary += 'No results found.\n';
      }

      summary += '\nPlease note that these are web search results and may not be fully accurate or up-to-date.';
      return summary;
    };

    // 将搜索结果喂回模型，让模型生成最终回答（而不是直接把结果列表回传给用户）
    const buildWebSearchAnswerPrompt = (question, query, results) => {
      const q = String(query || '').trim();
      const questionText = String(question || '').trim() || q;
      const list = Array.isArray(results?.results) ? results.results : [];

      const items = list.slice(0, 8).map((r, i) => {
        const title = (r?.title || '').toString();
        const url = (r?.url || '').toString();
        const snippet = r?.snippet != null ? String(r.snippet) : '';
        const truncated = snippet.length > 400 ? `${snippet.slice(0, 400)}...` : snippet;

        let block = `${i + 1}. ${title}\nSource: ${url}`;
        if (truncated) block = `${i + 1}. ${title}\n${truncated}\nSource: ${url}`;
        return block;
      }).join('\n\n');

      return [
        '你将获得一组网页搜索结果（可能不完全准确）。请严格基于这些结果回答用户问题，避免编造。',
        '要求：用与用户问题相同的语言回答；引用具体事实时在句末附上来源链接（URL）；输出最终答案，不要原样复述搜索结果列表。',
        '',
        `用户问题：${questionText}`,
        '',
        `搜索关键词：${q}`,
        '',
        '搜索结果：',
        items || '(无结果)'
      ].join('\n');
    };

    if (stream) {
      // 流式响应
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      let hasToolCall = false;
      let responseEnded = false;
      
      // 监听响应关闭事件
      res.on('close', () => {
        responseEnded = true;
      });

      try {
        let effectiveMessages = messages;
        let effectiveOptions = options;
        let accountOverride = null;

        if (isWebSearchOnly) {
          const query = extractWebSearchQuery(messages);
          if (!query) {
            responseEnded = true;
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: '\n\n错误: 无法从 messages 中提取 web_search query' }, finish_reason: null }]
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          accountOverride = await kiroClient.getAvailableAccount(req.user.user_id, [], model);
          const mcp = await kiroClient.webSearch(query, model, req.user.user_id, accountOverride);
          const question = extractLastUserText(messages);
          const answerPrompt = buildWebSearchAnswerPrompt(question, mcp.query, mcp.results);

          effectiveMessages = [
            ...messages,
            { role: 'user', content: answerPrompt }
          ];
          effectiveOptions = { ...options, tools: [], tool_choice: 'none' };
        }

        await kiroClient.generateResponse(effectiveMessages, model, (data) => {
          // 如果响应已结束，不再写入数据
          if (responseEnded) {
            return;
          }
          
          try {
            if (data.type === 'tool_calls') {
              hasToolCall = true;
              res.write(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { tool_calls: data.tool_calls }, finish_reason: null }]
              })}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: data.content }, finish_reason: null }]
              })}\n\n`);
            }
          } catch (writeError) {
            logger.warn(`Kiro写入响应失败: ${writeError.message}`);
            responseEnded = true;
          }
        }, req.user.user_id, effectiveOptions, accountOverride);

        // 如果响应已结束，直接返回
        if (responseEnded) {
          return;
        }

        try {
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: hasToolCall ? 'tool_calls' : 'stop' }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (writeError) {
          logger.warn(`Kiro写入结束响应失败: ${writeError.message}`);
        }
      } catch (error) {
        // 如果响应已结束，直接返回
        if (responseEnded) {
          return;
        }
        
        logger.error('Kiro生成响应失败:', error.message);
        
        // 尝试转储错误现场（跳过常见错误）
        const skipDumpPatterns = ['Requested entity was not found', 'Prompt is too long', 'ILLEGAL_PROMPT'];
        const shouldSkipDump = skipDumpPatterns.some(pattern => error.message?.includes(pattern));
        if (!shouldSkipDump) {
          await dumpErrorArtifacts(req.body, { model, messages, options }, null, error.message);
        }

        try {
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: `\n\n错误: ${error.message}` }, finish_reason: null }]
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (writeError) {
          logger.warn(`Kiro写入错误响应失败: ${writeError.message}`);
        }
      }
    } else {
      // 非流式响应
      try {
        if (isWebSearchOnly) {
          const query = extractWebSearchQuery(messages);
          if (!query) {
            return res.status(400).json({ error: '无法从 messages 中提取 web_search query' });
          }

          const accountOverride = await kiroClient.getAvailableAccount(req.user.user_id, [], model);
          const mcp = await kiroClient.webSearch(query, model, req.user.user_id, accountOverride);
          const question = extractLastUserText(messages);
          const answerPrompt = buildWebSearchAnswerPrompt(question, mcp.query, mcp.results);

          const effectiveMessages = [
            ...messages,
            { role: 'user', content: answerPrompt }
          ];
          const effectiveOptions = { ...options, tools: [], tool_choice: 'none' };

          let fullContent = '';
          let toolCalls = [];

          await kiroClient.generateResponse(effectiveMessages, model, (data) => {
            if (data.type === 'tool_calls') {
              toolCalls = data.tool_calls;
            } else {
              fullContent += data.content;
            }
          }, req.user.user_id, effectiveOptions, accountOverride);

          const message = { role: 'assistant', content: fullContent };
          if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
          }

          return res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              message,
              finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
            }]
          });
        }

        let fullContent = '';
        let toolCalls = [];

        await kiroClient.generateResponse(messages, model, (data) => {
          if (data.type === 'tool_calls') {
            toolCalls = data.tool_calls;
          } else {
            fullContent += data.content;
          }
        }, req.user.user_id, options);

        const message = { role: 'assistant', content: fullContent };
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }

        res.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
          }]
        });
      } catch (error) {
        logger.error('Kiro生成响应失败:', error.message);
        
        // 尝试转储错误现场（跳过常见错误）
        const skipDumpPatterns = ['Requested entity was not found', 'Prompt is too long', 'ILLEGAL_PROMPT'];
        const shouldSkipDump = skipDumpPatterns.some(pattern => error.message?.includes(pattern));
        if (!shouldSkipDump) {
          await dumpErrorArtifacts(req.body, { model, messages, options }, null, error.message);
        }

        res.status(500).json({ error: error.message });
      }
    }
  } else {
    // 使用 antigravity 账号系统（默认）
    let account, requestBody, promptTokens;

    try {
      // 先获取账号信息以便传递给 generateRequestBody
      account = await multiAccountClient.getAvailableAccount(req.user.user_id, model, req.user);
      requestBody = await generateRequestBody(messages, model, params, tools, req.user.user_id, account);

      // 计算输入token数
      const inputText = messages.map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content.filter(c => c.type === 'text').map(c => c.text).join('');
        }
        return '';
      }).join('\n');
      promptTokens = countStringTokens(inputText, model);
    } catch (error) {
      logger.warn(`准备请求失败: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }

    if (stream) {
      // 流式响应始终返回200，错误通过流传递
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      let hasToolCall = false;
      let collectedImages = [];
      let fullContent = ''; // 累积输出内容用于计算token
      let toolCallArgs = ''; // 累积工具调用参数用于计算token

      let reasoningContent = ''; // 累积 reasoning_content
      let hasError = false; // 标记是否发生错误
      let responseEnded = false; // 标记响应是否已结束
      
      // 监听响应关闭事件
      res.on('close', () => {
        responseEnded = true;
      });
      
      try {
        await multiAccountClient.generateResponse(requestBody, async (data) => {
          // 如果响应已结束，不再写入数据
          if (responseEnded || hasError) {
            return;
          }
          
          if (data.type === 'error') {
            // 尝试转储错误现场（跳过常见错误：Requested entity was not found, Prompt is too long, ILLEGAL_PROMPT）
            const skipDumpPatterns = ['Requested entity was not found', 'Prompt is too long', 'Internal'];
            const shouldSkipDump = skipDumpPatterns.some(pattern => data.content?.includes(pattern));
            if (data.upstreamResponse && !shouldSkipDump) {
              await dumpErrorArtifacts(req.body, data.upstreamRequest || requestBody, data.upstreamResponse, data.content);
            }

            // 处理错误：在流中发送错误信息
            hasError = true;
            try {
              res.write(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: `\n\n错误: ${data.content}` }, finish_reason: null }]
              })}\n\n`);
              res.write(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (writeError) {
              logger.warn(`写入错误响应失败: ${writeError.message}`);
            }
            responseEnded = true;
            return;
          }
          
          // 再次检查响应状态
          if (responseEnded) {
            return;
          }
          
          if (data.type === 'tool_calls') {
            hasToolCall = true;
            // 累积工具调用内容用于token计算
            toolCallArgs += data.tool_calls.map(tc => tc.function?.name + (tc.function?.arguments || '')).join('');
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { tool_calls: data.tool_calls }, finish_reason: null }]
            })}\n\n`);
          } else if (data.type === 'image') {
            // 收集图像数据,稍后一起返回
            collectedImages.push(data.image);
          } else if (data.type === 'reasoning') {
            // Gemini 的思考内容转换为 OpenAI 兼容的 reasoning_content 格式
            reasoningContent += data.content || '';
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { reasoning_content: data.content }, finish_reason: null }]
            })}\n\n`);
          } else {
            fullContent += data.content || ''; // 累积内容
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: data.content }, finish_reason: null }]
            })}\n\n`);
          }
        }, req.user.user_id, model, req.user, account);

        // 如果已经发生错误并结束了响应，直接返回
        if (hasError || responseEnded) {
          return;
        }

        // 如果有生成的图像,在结束前以base64格式返回
        if (collectedImages.length > 0) {
          for (const img of collectedImages) {
            const imageUrl = `data:${img.mimeType};base64,${img.data}`;
            const imageContent = `\n![生成的图像](${imageUrl})\n`;
            fullContent += imageContent;
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: imageContent }, finish_reason: null }]
            })}\n\n`);
          }
        }

        // 计算输出token数（包括文本内容和工具调用参数）
        const completionTokens = countStringTokens(fullContent + toolCallArgs, model);
        const totalTokens = promptTokens + completionTokens;

        // 发送带usage的finish chunk
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: hasToolCall ? 'tool_calls' : 'stop' }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens
          }
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        // 如果已经在回调中处理过错误并结束了响应，直接返回
        if (hasError || responseEnded) {
          return;
        }

        // 流式错误处理：在流中发送错误信息
        logger.error('生成响应失败:', error.message);
        
        // 尝试转储错误现场（如果是 ApiError，通常包含了 responseText）
        // 跳过常见错误：Requested entity was not found, Prompt is too long, ILLEGAL_PROMPT
        const skipDumpPatterns = ['Requested entity was not found', 'Prompt is too long', 'ILLEGAL_PROMPT'];
        const shouldSkipDump = skipDumpPatterns.some(pattern =>
          error.message?.includes(pattern) || error.responseText?.includes(pattern)
        );
        if (error.name === 'ApiError' && error.responseText && !shouldSkipDump) {
           await dumpErrorArtifacts(req.body, requestBody, error.responseText, error.message);
        }

        try {
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: `\n\n错误: ${error.message}` }, finish_reason: null }]
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (writeError) {
          logger.warn(`写入错误响应失败: ${writeError.message}`);
        }
      }
    } else {
      // 非流式响应：正常错误处理
      try {
        let fullContent = '';
        let reasoningContent = ''; // 累积 reasoning_content
        let toolCalls = [];
        let collectedImages = [];
        let toolCallArgs = ''; // 累积工具调用参数用于计算token

        await multiAccountClient.generateResponse(requestBody, (data) => {
          if (data.type === 'tool_calls') {
            toolCalls = data.tool_calls;
            toolCallArgs += data.tool_calls.map(tc => tc.function?.name + (tc.function?.arguments || '')).join('');
          } else if (data.type === 'image') {
            collectedImages.push(data.image);
          } else if (data.type === 'reasoning') {
            // Gemini 的思考内容
            reasoningContent += data.content || '';
          } else {
            fullContent += data.content || '';
          }
        }, req.user.user_id, model, req.user, account);

        // 如果有生成的图像,将其添加到响应内容中
        if (collectedImages.length > 0) {
          fullContent += '\n\n';
          for (const img of collectedImages) {
            const imageUrl = `data:${img.mimeType};base64,${img.data}`;
            fullContent += `![生成的图像](${imageUrl})\n`;
          }
        }

        // 计算输出token数（包括文本内容和工具调用参数）
        const completionTokens = countStringTokens(fullContent + toolCallArgs, model);
        const totalTokens = promptTokens + completionTokens;

        const message = { role: 'assistant', content: fullContent };
        if (reasoningContent) {
          message.reasoning_content = reasoningContent;
        }
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }

        res.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
          }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens
          }
        });
      } catch (error) {
        logger.error('生成响应失败:', error.message);
        
        // 尝试转储错误现场（跳过常见错误：Requested entity was not found, Prompt is too long, ILLEGAL_PROMPT）
        const skipDumpPatterns = ['Requested entity was not found', 'Prompt is too long', 'Internal'];
        const shouldSkipDump = skipDumpPatterns.some(pattern =>
          error.message?.includes(pattern) || error.responseText?.includes(pattern)
        );
        if (error.name === 'ApiError' && error.responseText && !shouldSkipDump) {
           await dumpErrorArtifacts(req.body, requestBody, error.responseText, error.message);
        }

        const statusCode = error.statusCode || 500;
        const errorMessage = error.responseText || error.message;
        res.status(statusCode).json({ error: errorMessage });
      }
    }
  }
});

/**
 * Gemini 图片生成接口
 * POST /v1beta/models/{model}:generateContent
 * POST /v1beta/models/{model}:streamGenerateContent
 * Body: { contents, generationConfig }
 *
 * 直接返回 JSON 响应（非流式）
 *
 * 注意：streamGenerateContent 和 generateContent 使用相同的处理逻辑
 */
const handleGeminiImageGeneration = async (req, res) => {
  // 设置10分钟超时（图片生成可能需要较长时间）
  req.setTimeout(600000); // 10分钟 = 600000毫秒
  res.setTimeout(600000);
  
  let requestBody = null;
  
  try {
    const { model } = req.params;
    const { contents, generationConfig } = req.body;

    // 验证必需参数
    if (!contents || !Array.isArray(contents) || contents.length === 0) {
      return res.status(400).json({
        error: {
          code: 400,
          message: 'contents是必需的且必须是非空数组',
          status: 'INVALID_ARGUMENT'
        }
      });
    }

    // 提取提示词和图片（从用户消息中）
    let prompt = '';
    const images = [];
    
    for (const content of contents) {
      if (content.role === 'user' && content.parts) {
        for (const part of content.parts) {
          if (part.text) {
            prompt += part.text;
          } else if (part.inlineData) {
            // Gemini 原生格式的图片数据
            images.push({
              inlineData: {
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data
              }
            });
          }
        }
      }
    }

    // 至少需要文本提示词或图片
    if (!prompt && images.length === 0) {
      return res.status(400).json({
        error: {
          code: 400,
          message: '未找到有效的文本提示词或图片',
          status: 'INVALID_ARGUMENT'
        }
      });
    }

    // 提取 imageConfig 参数
    const imageConfig = {};
    if (generationConfig?.imageConfig) {
      if (generationConfig.imageConfig.aspectRatio) {
        imageConfig.aspect_ratio = generationConfig.imageConfig.aspectRatio;
      }
      if (generationConfig.imageConfig.imageSize) {
        imageConfig.image_size = generationConfig.imageConfig.imageSize;
      }
    }

    // 获取账号信息
    const account = await multiAccountClient.getAvailableAccount(req.user.user_id, model, req.user);
    
    // 生成请求体（包含图片数据用于图生图/图片编辑）
    const { generateImageRequestBody } = await import('../utils/utils.js');
    requestBody = generateImageRequestBody(prompt, model, imageConfig, account, images);

    // 调用图片生成API
    const data = await multiAccountClient.generateImage(
      requestBody,
      req.user.user_id,
      model,
      req.user,
      account
    );

    // 直接返回 JSON 响应
    res.json(data);
  } catch (error) {
    logger.error('图片生成失败:', error.message);
    
    // 尝试转储错误现场（跳过常见错误）
    const skipDumpPatterns = ['Requested entity was not found', 'Prompt is too long', 'ILLEGAL_PROMPT'];
    const shouldSkipDump = skipDumpPatterns.some(pattern =>
      error.message?.includes(pattern) || error.responseText?.includes(pattern)
    );
    if (error.name === 'ApiError' && error.responseText && !shouldSkipDump) {
      await dumpErrorArtifacts(req.body, requestBody, error.responseText, error.message);
    }

    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: {
        code: statusCode,
        message: error.message,
        status: 'INTERNAL'
      }
    });
  }
};

// 注册 Gemini 图片生成路由（支持两种端点）
router.post('/v1beta/models/:model\\:generateContent', authenticateApiKey, handleGeminiImageGeneration);
router.post('/v1beta/models/:model\\:streamGenerateContent', authenticateApiKey, handleGeminiImageGeneration);

export default router;
