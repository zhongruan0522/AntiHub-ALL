import express from 'express';
import kiroAccountService from '../services/kiro_account.service.js';
import kiroService from '../services/kiro.service.js';
import kiroClient from '../api/kiro_client.js';
import kiroConsumptionService from '../services/kiro_consumption.service.js';
import kiroSubscriptionModelService from '../services/kiro_subscription_model.service.js';
import userService from '../services/user.service.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import { countStringTokens } from '../utils/token_counter.js';

const router = express.Router();

const decodeBase64UrlToString = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
};

const tryDecodeJwtPayload = (token) => {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payloadString = decodeBase64UrlToString(parts[1]);
  if (!payloadString) return null;
  try {
    return JSON.parse(payloadString);
  } catch {
    return null;
  }
};

/**
 * API Key认证中间件
 */
const authenticateApiKey = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '缺少Authorization请求头' });
  }

  const apiKey = authHeader.slice(7);
  
  // 检查是否是管理员API Key
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

// ==================== Kiro OAuth API ====================

/**
 * 获取Kiro Social登录URL（自动生成machineid）
 * POST /api/kiro/oauth/authorize
 * Body: { provider, is_shared }
 */
router.post('/api/kiro/oauth/authorize', authenticateApiKey, async (req, res) => {
  try {
    const { provider = 'Google', is_shared = 0 } = req.body;

    if (!['Google', 'Github'].includes(provider)) {
      return res.status(400).json({ error: 'provider必须是Google或Github' });
    }

    if (is_shared !== 0 && is_shared !== 1) {
      return res.status(400).json({ error: 'is_shared必须是0或1' });
    }

    // 获取Bearer token
    const bearerToken = req.headers.authorization.slice(7); // 去掉'Bearer '前缀

    // 自动生成machineid，存储到Redis（包含bearer_token）
    const result = await kiroService.generateSocialLoginUrl(provider, req.user.user_id, is_shared, bearerToken);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('生成Kiro登录URL失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 轮询Kiro OAuth登录状态
 * GET /api/kiro/oauth/status/:state
 * 无需认证（state中已包含用户信息）
 */
router.get('/api/kiro/oauth/status/:state', async (req, res) => {
  try {
    const { state } = req.params;

    if (!state) {
      return res.status(400).json({ error: '缺少state参数' });
    }

    // 从Redis获取OAuth状态信息
    const stateInfo = await kiroService.getOAuthStateInfo(state);
    
    if (!stateInfo) {
      return res.status(404).json({
        error: '无效或已过期的state参数',
        status: 'expired'
      });
    }

    // 检查是否已完成
    if (stateInfo.callback_completed) {
      return res.json({
        success: true,
        status: 'completed',
        data: stateInfo.account_data || null,
        message: '登录已完成'
      });
    }

    // 检查是否有错误
    if (stateInfo.error) {
      return res.json({
        success: false,
        status: 'error',
        error: stateInfo.error,
        message: '登录失败'
      });
    }

    // 还在等待中
    res.json({
      success: true,
      status: 'pending',
      message: '等待用户完成登录...'
    });
  } catch (error) {
    logger.error('查询OAuth状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Kiro OAuth手动回调处理（解析kiro://回调URL）
 * POST /api/kiro/oauth/callback
 * Body: { callback_url } 或 { code, state }
 */
router.post('/api/kiro/oauth/callback', async (req, res) => {
  try {
    let code, state;

    // 支持两种方式：直接传callback_url或分别传code和state
    if (req.body.callback_url) {
      // 解析kiro://回调URL
      const parsed = kiroService.parseCallbackUrl(req.body.callback_url);
      code = parsed.code;
      state = parsed.state;
    } else {
      code = req.body.code;
      state = req.body.state;
    }

    if (!code || !state) {
      return res.status(400).json({ error: '缺少必需字段: code, state 或 callback_url' });
    }

    // 从Redis获取OAuth状态信息（包含bearer_token和user_id）
    const stateInfo = await kiroService.getOAuthStateInfo(state);
    if (!stateInfo) {
      return res.status(400).json({ error: '无效或已过期的state参数' });
    }

    // 从stateInfo中获取用户信息（不需要认证）
    const userId = stateInfo.user_id;

    // 交换授权码获取token（使用machineid设置user-agent）
    logger.info('交换Kiro授权码...');
    const tokenData = await kiroService.exchangeCodeForToken(code, stateInfo.code_verifier, stateInfo.machineid);

    const expires_at = Date.now() + (tokenData.expires_in * 1000);

    // 获取使用量信息（使用profileArn和machineid）
    logger.info('获取Kiro使用量信息...');
    let usageLimitsData = {};
    try {
      usageLimitsData = await kiroService.getUsageLimits(tokenData.access_token, tokenData.profile_arn, stateInfo.machineid);
      logger.info('使用量信息获取成功:', usageLimitsData);
    } catch (error) {
      logger.warn('获取使用量信息失败:', error.message);
    }

    // 创建账号（使用Redis中存储的user_id）
    // 如果有email则使用email作为account_name，否则使用默认名称
    const accountName = usageLimitsData.email || `Kiro ${stateInfo.provider}账号`;
    const account = await kiroAccountService.createAccount({
      user_id: userId,
      account_name: accountName,
      auth_method: 'Social',
      refresh_token: tokenData.refresh_token,
      access_token: tokenData.access_token,
      expires_at,
      profile_arn: tokenData.profile_arn,
      machineid: stateInfo.machineid,
      is_shared: stateInfo.is_shared,
      email: usageLimitsData.email,
      userid: usageLimitsData.userid,
      subscription: usageLimitsData.subscription || 'unknown',
      current_usage: usageLimitsData.current_usage || 0,
      reset_date: usageLimitsData.reset_date || new Date().toISOString(),
      usage_limit: usageLimitsData.usage_limit || 0,
      // 免费试用信息
      free_trial_status: usageLimitsData.free_trial_status || null,
      free_trial_usage: usageLimitsData.free_trial_usage || null,
      free_trial_expiry: usageLimitsData.free_trial_expiry || null,
      free_trial_limit: usageLimitsData.free_trial_limit || 0,
      // bonus信息
      bonus_usage: usageLimitsData.bonus_usage || 0,
      bonus_limit: usageLimitsData.bonus_limit || 0,
      bonus_available: usageLimitsData.bonus_available || 0,
      bonus_details: usageLimitsData.bonus_details || []
    });

    // 准备安全的账号数据
    const safeAccountData = {
      account_id: account.account_id,
      user_id: account.user_id,
      account_name: account.account_name,
      auth_method: account.auth_method,
      status: account.status,
      expires_at: account.expires_at,
      email: account.email,
      subscription: account.subscription,
      created_at: account.created_at
    };

    // 更新Redis中的OAuth状态（标记为已完成）
    await kiroService.updateOAuthState(state, {
      callback_completed: true,
      completed_at: Date.now(),
      account_data: safeAccountData
    });

    // 隐藏敏感信息
    const safeAccount = {
      account_id: account.account_id,
      user_id: account.user_id,
      account_name: account.account_name,
      auth_method: account.auth_method,
      status: account.status,
      expires_at: account.expires_at,
      email: account.email,
      subscription: account.subscription,
      created_at: account.created_at
    };

    res.json({
      success: true,
      message: '登录成功！',
      data: safeAccount
    });
  } catch (error) {
    logger.error('Login error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Kiro账号管理API ====================

/**
 * 创建Kiro账号（手动方式，需要提供refresh_token）
 * POST /api/kiro/accounts
 * Body: { account_name, auth_method, refresh_token, client_id?, client_secret?, machineid, is_shared, email?, userid, subscription, current_usage, reset_date, usage_limit }
 */
router.post('/api/kiro/accounts', authenticateApiKey, async (req, res) => {
  try {
    const {
      account_name, auth_method, refresh_token, client_id, client_secret,
      machineid, is_shared, email, userid,
      subscription, current_usage, reset_date, usage_limit
    } = req.body;

    if (!auth_method || !refresh_token) {
      return res.status(400).json({ error: '缺少必需字段: auth_method, refresh_token' });
    }

    // machineid和is_shared是必填的，其他字段可以从API自动获取
    if (!machineid || is_shared === undefined) {
      return res.status(400).json({ error: '缺少必需字段: machineid, is_shared' });
    }

    if (is_shared !== 0 && is_shared !== 1) {
      return res.status(400).json({ error: 'is_shared必须是0或1' });
    }

    if (!['Social', 'IdC'].includes(auth_method)) {
      return res.status(400).json({ error: 'auth_method必须是Social或IdC' });
    }

    if (auth_method === 'IdC' && (!client_id || !client_secret)) {
      return res.status(400).json({ error: 'IdC认证需要client_id和client_secret' });
    }

    // 先测试token是否有效
    logger.info('测试Kiro token有效性...');
    const tokenData = await kiroService.refreshToken({
      machineid,
      auth: auth_method,
      refreshToken: refresh_token,
      clientId: client_id,
      clientSecret: client_secret
    });

    const expires_at = Date.now() + (tokenData.expires_in * 1000);

    // 获取使用量信息（自动填充部分字段）
    logger.info('获取Kiro使用量信息...');
    let usageLimitsData = {};
    try {
      usageLimitsData = await kiroService.getUsageLimits(
        tokenData.access_token,
        tokenData.profile_arn,
        machineid
      );
      logger.info('使用量信息获取成功:', usageLimitsData);
    } catch (error) {
      logger.warn('获取使用量信息失败，使用请求中提供的值:', error.message);
    }

    // 合并使用量数据（请求中的值优先，如果没有则使用API获取的值）
    const finalEmail = email || usageLimitsData.email;
    let finalUserid = userid || usageLimitsData.userid;
    if (!finalUserid && typeof tokenData.profile_arn === 'string') {
      const extracted = tokenData.profile_arn.split('/').pop();
      if (extracted) finalUserid = extracted;
    }
    if (!finalUserid) {
      const payload = tryDecodeJwtPayload(tokenData.access_token);
      finalUserid = payload?.userId || payload?.userid || payload?.user_id || payload?.sub || null;
    }
    if (!finalUserid) {
      return res.status(400).json({ error: '无法从token解析userid，请在请求体中手动提供userid' });
    }
    const finalSubscription = subscription || usageLimitsData.subscription || 'unknown';
    const finalCurrentUsage = current_usage !== undefined ? current_usage : (usageLimitsData.current_usage || 0);
    const finalResetDate = reset_date || usageLimitsData.reset_date || new Date().toISOString();
    const finalUsageLimit = usage_limit !== undefined ? usage_limit : (usageLimitsData.usage_limit || 0);

    // 创建账号
    const account = await kiroAccountService.createAccount({
      user_id: req.user.user_id,
      account_name,
      auth_method,
      refresh_token,
      access_token: tokenData.access_token,
      expires_at,
      client_id,
      client_secret,
      profile_arn: tokenData.profile_arn,
      machineid,
      is_shared,
      email: finalEmail,
      userid: finalUserid,
      subscription: finalSubscription,
      current_usage: finalCurrentUsage,
      reset_date: finalResetDate,
      usage_limit: finalUsageLimit,
      bonus_usage: usageLimitsData.bonus_usage || 0,
      bonus_limit: usageLimitsData.bonus_limit || 0,
      bonus_available: usageLimitsData.bonus_available || 0,
      bonus_details: usageLimitsData.bonus_details || []
    });

    // 隐藏敏感信息
    const safeAccount = {
      account_id: account.account_id,
      user_id: account.user_id,
      account_name: account.account_name,
      auth_method: account.auth_method,
      status: account.status,
      expires_at: account.expires_at,
      created_at: account.created_at
    };

    res.json({
      success: true,
      message: '登录成功！',
      data: safeAccount
    });
  } catch (error) {
    logger.error('Login error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取当前用户的Kiro账号列表
 * GET /api/kiro/accounts
 */
router.get('/api/kiro/accounts', authenticateApiKey, async (req, res) => {
  try {
    const accounts = await kiroAccountService.getAccountsByUserId(req.user.user_id);

    // 隐藏敏感信息
    const safeAccounts = accounts.map(acc => ({
      account_id: acc.account_id,
      user_id: acc.user_id,
      account_name: acc.account_name,
      auth_method: acc.auth_method,
      status: acc.status,
      expires_at: acc.expires_at,
      created_at: acc.created_at,
      updated_at: acc.updated_at
    }));

    res.json({
      success: true,
      data: safeAccounts
    });
  } catch (error) {
    logger.error('获取Kiro账号列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取单个Kiro账号信息
 * GET /api/kiro/accounts/:account_id
 */
router.get('/api/kiro/accounts/:account_id', authenticateApiKey, async (req, res) => {
  try {
    const { account_id } = req.params;
    const account = await kiroAccountService.getAccountById(account_id);

    if (!account) {
      return res.status(404).json({ error: 'Kiro账号不存在' });
    }

    // 检查权限
    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号' });
    }

    // 隐藏敏感信息
    const safeAccount = {
      account_id: account.account_id,
      user_id: account.user_id,
      account_name: account.account_name,
      auth_method: account.auth_method,
      status: account.status,
      expires_at: account.expires_at,
      created_at: account.created_at,
      updated_at: account.updated_at
    };

    res.json({
      success: true,
      data: safeAccount
    });
  } catch (error) {
    logger.error('获取Kiro账号信息失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 导出Kiro账号凭证（敏感信息）
 * GET /api/kiro/accounts/:account_id/credentials
 *
 * 说明：
 * - 仅账号所有者/管理员可访问
 * - 用于前端“复制凭证为JSON”
 */
router.get('/api/kiro/accounts/:account_id/credentials', authenticateApiKey, async (req, res) => {
  try {
    const { account_id } = req.params;
    const account = await kiroAccountService.getAccountById(account_id);

    if (!account) {
      return res.status(404).json({ error: 'Kiro账号不存在' });
    }

    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号' });
    }

    const credentials = {
      type: 'kiro',
      auth_method: account.auth_method,
      refresh_token: account.refresh_token,
      access_token: account.access_token,
      expires_at: account.expires_at,
      client_id: account.client_id,
      client_secret: account.client_secret,
      machineid: account.machineid,
      profile_arn: account.profile_arn,
      userid: account.userid,
      is_shared: account.is_shared,
    };

    const exportData = Object.fromEntries(
      Object.entries(credentials).filter(([, value]) => {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string' && value.trim() === '') return false;
        return true;
      })
    );

    res.json({ success: true, data: exportData });
  } catch (error) {
    logger.error('导出Kiro账号凭证失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新Kiro账号状态
 * PUT /api/kiro/accounts/:account_id/status
 * Body: { status }
 */
router.put('/api/kiro/accounts/:account_id/status', authenticateApiKey, async (req, res) => {
  try {
    const { account_id } = req.params;
    const { status } = req.body;

    if (status !== 0 && status !== 1) {
      return res.status(400).json({ error: 'status必须是0或1' });
    }

    // 检查权限
    const existingAccount = await kiroAccountService.getAccountById(account_id);
    if (!existingAccount) {
      return res.status(404).json({ error: 'Kiro账号不存在' });
    }
    if (!req.isAdmin && existingAccount.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权修改此账号' });
    }

    const account = await kiroAccountService.updateAccountStatus(account_id, status);

    res.json({
      success: true,
      message: `Kiro账号状态已更新为${status === 1 ? '启用' : '禁用'}`,
      data: {
        account_id: account.account_id,
        status: account.status
      }
    });
  } catch (error) {
    logger.error('更新Kiro账号状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新Kiro账号名称
 * PUT /api/kiro/accounts/:account_id/name
 * Body: { account_name }
 */
router.put('/api/kiro/accounts/:account_id/name', authenticateApiKey, async (req, res) => {
  try {
    const { account_id } = req.params;
    const { account_name } = req.body;

    if (!account_name) {
      return res.status(400).json({ error: '缺少account_name参数' });
    }

    // 检查权限
    const existingAccount = await kiroAccountService.getAccountById(account_id);
    if (!existingAccount) {
      return res.status(404).json({ error: 'Kiro账号不存在' });
    }
    if (!req.isAdmin && existingAccount.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权修改此账号' });
    }

    const account = await kiroAccountService.updateAccountName(account_id, account_name);

    res.json({
      success: true,
      message: 'Kiro账号名称已更新',
      data: {
        account_id: account.account_id,
        account_name: account.account_name
      }
    });
  } catch (error) {
    logger.error('更新Kiro账号名称失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取账号余额（刷新使用量信息）
 * GET /api/kiro/accounts/:account_id/balance
 */
router.get('/api/kiro/accounts/:account_id/balance', authenticateApiKey, async (req, res) => {
  try {
    const { account_id } = req.params;

    // 获取账号信息
    let account = await kiroAccountService.getAccountById(account_id);
    if (!account) {
      return res.status(404).json({ error: 'Kiro账号不存在' });
    }

    // 检查权限
    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号余额' });
    }

    // 检查token是否过期，如果过期则刷新
    if (kiroAccountService.isTokenExpired(account)) {
      logger.info(`Kiro账号token已过期，正在刷新: account_id=${account.account_id}`);
      
      const tokenData = await kiroService.refreshToken({
        machineid: account.machineid,
        auth: account.auth_method,
        refreshToken: account.refresh_token,
        clientId: account.client_id,
        clientSecret: account.client_secret
      });
      
      const expires_at = Date.now() + (tokenData.expires_in * 1000);
      await kiroAccountService.updateAccountToken(
        account.account_id,
        tokenData.access_token,
        expires_at,
        tokenData.profile_arn
      );
      
      account.access_token = tokenData.access_token;
      account.expires_at = expires_at;
    }

    // 获取最新的使用量信息
    logger.info(`获取Kiro账号使用量信息: account_id=${account_id}`);
    const usageLimitsData = await kiroService.getUsageLimits(
      account.access_token,
      account.profile_arn,
      account.machineid
    );

    // 更新数据库中的使用量信息
    account = await kiroAccountService.updateAccountUsage(account_id, {
      email: usageLimitsData.email,
      userid: usageLimitsData.userid,
      subscription: usageLimitsData.subscription,
      current_usage: usageLimitsData.current_usage,
      reset_date: usageLimitsData.reset_date,
      usage_limit: usageLimitsData.usage_limit,
      // 免费试用信息
      free_trial_status: usageLimitsData.free_trial_status,
      free_trial_usage: usageLimitsData.free_trial_usage,
      free_trial_expiry: usageLimitsData.free_trial_expiry,
      free_trial_limit: usageLimitsData.free_trial_limit,
      // bonus信息
      bonus_usage: usageLimitsData.bonus_usage,
      bonus_limit: usageLimitsData.bonus_limit,
      bonus_available: usageLimitsData.bonus_available,
      bonus_details: usageLimitsData.bonus_details
    });

    // 计算可用额度
    const balance = kiroAccountService.calculateAvailableBalance(account);

    res.json({
      success: true,
      data: {
        account_id: account.account_id,
        account_name: account.account_name,
        email: account.email,
        subscription: account.subscription,
        subscription_type: usageLimitsData.subscription_type,
        balance: {
          available: balance.available,
          total_limit: balance.total_limit,
          current_usage: balance.current_usage,
          base_available: balance.base_available,
          bonus_available: balance.bonus_available,
          reset_date: balance.reset_date
        },
        // 免费试用信息
        free_trial: {
          status: balance.free_trial_status,
          usage: balance.free_trial_usage,
          limit: balance.free_trial_limit,
          available: balance.free_trial_available,
          expiry: balance.free_trial_expiry
        },
        bonus_details: balance.bonus_details
      }
    });
  } catch (error) {
    logger.error('获取Kiro账号余额失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 删除Kiro账号
 * DELETE /api/kiro/accounts/:account_id
 */
router.delete('/api/kiro/accounts/:account_id', authenticateApiKey, async (req, res) => {
  try {
    const { account_id } = req.params;

    // 检查权限
    const existingAccount = await kiroAccountService.getAccountById(account_id);
    if (!existingAccount) {
      return res.status(404).json({ error: 'Kiro账号不存在' });
    }
    if (!req.isAdmin && existingAccount.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权删除此账号' });
    }

    await kiroAccountService.deleteAccount(account_id);

    res.json({
      success: true,
      message: 'Kiro账号已删除'
    });
  } catch (error) {
    logger.error('删除Kiro账号失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Kiro消费记录API ====================

/**
 * 获取账号消费记录
 * GET /api/kiro/accounts/:account_id/consumption
 * Query: limit, offset, start_date, end_date
 */
router.get('/api/kiro/accounts/:account_id/consumption', authenticateApiKey, async (req, res) => {
  try {
    const { account_id } = req.params;
    const { limit = 100, offset = 0, start_date, end_date } = req.query;

    // 检查账号是否存在
    const account = await kiroAccountService.getAccountById(account_id);
    if (!account) {
      return res.status(404).json({ error: 'Kiro账号不存在' });
    }

    // 检查权限
    if (!req.isAdmin && account.user_id !== req.user.user_id) {
      return res.status(403).json({ error: '无权访问此账号的消费记录' });
    }

    // 获取消费记录（通过用户ID过滤，确保只能看到自己的记录）
    const consumptionLogs = await kiroConsumptionService.getUserConsumption(
      account.user_id,
      { limit: parseInt(limit), offset: parseInt(offset) }
    );

    // 只返回指定账号的记录
    const filteredLogs = consumptionLogs.filter(log => log.account_id === account_id);

    // 如果指定了日期范围，进一步过滤
    let finalLogs = filteredLogs;
    if (start_date || end_date) {
      finalLogs = filteredLogs.filter(log => {
        const consumedAt = new Date(log.consumed_at);
        if (start_date && consumedAt < new Date(start_date)) return false;
        if (end_date && consumedAt > new Date(end_date)) return false;
        return true;
      });
    }

    // 获取统计信息
    const stats = await kiroConsumptionService.getAccountStats(account_id, {
      start_date,
      end_date
    });

    res.json({
      success: true,
      data: {
        account_id,
        account_name: account.account_name,
        logs: finalLogs,
        stats: stats,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: finalLogs.length
        }
      }
    });
  } catch (error) {
    logger.error('获取账号消费记录失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取用户总消费统计
 * GET /api/kiro/consumption/stats
 * Query: start_date, end_date
 */
router.get('/api/kiro/consumption/stats', authenticateApiKey, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const stats = await kiroConsumptionService.getUserTotalStats(req.user.user_id, {
      start_date,
      end_date
    });

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('获取用户消费统计失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Kiro 订阅层 -> 可用模型（管理员配置） ====================

/**
 * 获取订阅层可用模型配置（管理员）
 * GET /api/kiro/admin/subscription-models
 */
router.get('/api/kiro/admin/subscription-models', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const rules = await kiroSubscriptionModelService.listSubscriptionModelRules();
    res.json({ success: true, data: rules });
  } catch (error) {
    logger.error('获取订阅层可用模型配置失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 设置订阅层可用模型配置（管理员）
 * PUT /api/kiro/admin/subscription-models
 * Body: { subscription, model_ids }，model_ids 为 null 表示删除配置（回到默认放行）
 */
router.put('/api/kiro/admin/subscription-models', authenticateApiKey, requireAdmin, async (req, res) => {
  try {
    const subscription = req.body?.subscription;
    const modelIds = req.body?.model_ids ?? req.body?.modelIds ?? null;

    if (typeof subscription !== 'string' || !subscription.trim()) {
      return res.status(400).json({ error: 'subscription 是必填字段' });
    }

    if (modelIds !== null && !Array.isArray(modelIds)) {
      return res.status(400).json({ error: 'model_ids 必须是字符串数组或 null' });
    }

    const result = await kiroSubscriptionModelService.upsertSubscriptionModelRule(subscription, modelIds);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('设置订阅层可用模型配置失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Kiro OpenAI兼容接口 ====================

/**
 * 获取Kiro模型列表
 * GET /v1/kiro/models
 */
router.get('/v1/kiro/models', authenticateApiKey, async (req, res) => {
  try {
    const models = kiroClient.getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取Kiro模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Kiro聊天补全
 * POST /v1/kiro/chat/completions
 * Body: { messages, model, stream, tools, ... }
 */
router.post('/v1/kiro/chat/completions', authenticateApiKey, async (req, res) => {
  // 设置10分钟超时（避免长对话被断开）
  req.setTimeout(600000); // 10分钟 = 600000毫秒
  res.setTimeout(600000);

  const { messages, model, stream = true, tools, tool_choice, conversationState, conversation_state } = req.body;
  const rawConversationState = conversationState || conversation_state;
  const hasConversationState = rawConversationState && typeof rawConversationState === 'object';

  if (!messages && !hasConversationState) {
    return res.status(400).json({ error: 'messages是必需的' });
  }

  if (!model) {
    return res.status(400).json({ error: 'model是必需的' });
  }

  const options = { tools, tool_choice };

  // 模型内置联网（对接 Kiro MCP web_search）
  // 参考 kiro.rs：仅当 tools 只包含一个 web_search 时，走内置 WebSearch 分支。
  const getToolName = (t) => (t?.function?.name || t?.name || t?.toolSpecification?.name || t?.tool_specification?.name || '').toString();
  const effectiveTools = hasConversationState
    ? rawConversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools
    : tools;
  const isWebSearchOnly =
    Array.isArray(effectiveTools) &&
    effectiveTools.length === 1 &&
    getToolName(effectiveTools[0]).trim().toLowerCase() === 'web_search';

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

      // Claude WebSearch 常见前缀（kiro.rs 同款）
      const PREFIX = 'Perform a web search for the query: ';
      if (q.startsWith(PREFIX)) q = q.slice(PREFIX.length).trim();

      // 可选：显式 query 格式
      const m = q.match(/^(?:query|关键词|搜索|查询)\s*[:：]\s*(.+)$/i);
      if (m && m[1]) q = String(m[1]).trim();

      const original = q;

      // 极简中文口头语清理（保守：清理后太短则回退）
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

  const extractLastUserText = (msgs) => {
    if (!Array.isArray(msgs)) return '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'user') return extractTextFromContent(m.content);
    }
    return '';
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

  // 计算输入token数
  const buildPseudoMessagesFromConversationState = (cs) => {
    const out = [];
    const history = Array.isArray(cs?.history) ? cs.history : [];

    for (const h of history) {
      if (h?.userInputMessage) {
        out.push({ role: 'user', content: h.userInputMessage.content ?? '' });
      } else if (h?.assistantResponseMessage) {
        out.push({ role: 'assistant', content: h.assistantResponseMessage.content ?? '' });
      }
    }

    out.push({
      role: 'user',
      content: typeof cs?.currentMessage?.userInputMessage?.content === 'string' ? cs.currentMessage.userInputMessage.content : ''
    });

    return out;
  };

  const promptMessages = hasConversationState ? buildPseudoMessagesFromConversationState(rawConversationState) : messages;
  const inputText = promptMessages.map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter(c => c.type === 'text').map(c => c.text).join('');
    }
    return '';
  }).join('\n');
  const promptTokens = countStringTokens(inputText, model);

  if (stream) {
    // 流式响应
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let hasToolCall = false;
    let fullContent = ''; // 累积输出内容用于计算token
    let toolCallArgs = ''; // 累积工具调用参数用于计算token
    let toolCallIndex = 0; // 跟踪工具调用索引
    let responseEnded = false; // 标记响应是否已结束
    let keepAliveTimer = null;

    try {
      // 先尝试获取账号（能提前拦截“该订阅层不可用此模型”，避免先返回200的SSE）
      const preselectedAccount = await kiroClient.getAvailableAccount(req.user.user_id, [], model);

      // 设置流式响应头
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      res.write(': ok\n\n');

      keepAliveTimer = setInterval(() => {
        if (responseEnded) return;
        try {
          res.write(': keep-alive\n\n');
        } catch (e) {
          responseEnded = true;
        }
      }, 15000);

      // 监听响应关闭事件
      res.on('close', () => {
        responseEnded = true;
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
      });

      const onStreamData = (data) => {
        // 如果响应已结束，不再写入数据
        if (responseEnded) return;

        try {
          if (data.type === 'tool_call_start') {
            // OpenAI 流式格式：首次发送工具调用（包含 id, type, function.name）
            hasToolCall = true;
            const toolCalls = data.tool_calls.map((tc) => ({
              index: tc.index, // 使用从 kiro_client 传来的正确索引
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: ''
              }
            }));
            // 累积工具名称用于token计算
            toolCallArgs += data.tool_calls.map(tc => tc.function.name).join('');
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else if (data.type === 'tool_call_delta') {
            // OpenAI 流式格式：后续发送工具调用参数
            hasToolCall = true;
            // 累积工具参数用于token计算
            toolCallArgs += data.delta || '';
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: data.tool_call_index, // 使用正确的工具调用索引
                    id: data.tool_call_id, // 添加工具调用ID
                    function: {
                      arguments: data.delta
                    }
                  }]
                },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else if (data.type === 'tool_calls') {
            // 兼容旧格式：一次性发送完整的工具调用
            hasToolCall = true;
            // 累积工具调用内容用于token计算
            toolCallArgs += data.tool_calls.map(tc => tc.function?.name + (tc.function?.arguments || '')).join('');
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { tool_calls: data.tool_calls }, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else if (data.type === 'text') {
            fullContent += data.content; // 累积内容
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: data.content }, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        } catch (writeError) {
          logger.warn(`Kiro写入响应失败: ${writeError.message}`);
          responseEnded = true;
        }
      };

      // WebSearch: 先走 Kiro MCP，然后把结果喂回模型生成最终回答
      if (isWebSearchOnly) {
        const query = extractWebSearchQuery(promptMessages);
        if (!query) {
          responseEnded = true;
          if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
          }
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

        const mcp = await kiroClient.webSearch(query, model, req.user.user_id, preselectedAccount);
        const question = extractLastUserText(promptMessages);
        const answerPrompt = buildWebSearchAnswerPrompt(question, mcp.query, mcp.results);

        const effectiveMessages = [
          ...promptMessages,
          { role: 'user', content: answerPrompt }
        ];
        const effectiveOptions = { ...options, tools: [], tool_choice: 'none' };

        const effectiveInputText = effectiveMessages.map(m => {
          if (typeof m.content === 'string') return m.content;
          if (Array.isArray(m.content)) {
            return m.content.filter(c => c.type === 'text').map(c => c.text).join('');
          }
          return '';
        }).join('\n');
        const effectivePromptTokens = countStringTokens(effectiveInputText, model);

        await kiroClient.generateResponse(
          effectiveMessages,
          model,
          onStreamData,
          req.user.user_id,
          effectiveOptions,
          preselectedAccount
        );

        // 如果响应已结束，直接返回
        if (responseEnded) return;

        // 计算输出token数（包括文本内容和工具调用参数）
        const completionTokens = countStringTokens(fullContent + toolCallArgs, model);
        const totalTokens = effectivePromptTokens + completionTokens;

        // 发送带usage的finish chunk
        try {
          if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
          }
          const finishChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: hasToolCall ? 'tool_calls' : 'stop' }],
            usage: {
              prompt_tokens: effectivePromptTokens,
              completion_tokens: completionTokens,
              total_tokens: totalTokens
            }
          };
          res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (writeError) {
          logger.warn(`Kiro写入结束响应失败: ${writeError.message}`);
        }
        return;
      }

      const generate = hasConversationState
        ? kiroClient.generateResponseWithCwRequest.bind(kiroClient, { conversationState: rawConversationState })
        : kiroClient.generateResponse.bind(kiroClient, messages);

      await generate(model, onStreamData, req.user.user_id, options, preselectedAccount);

      // 如果响应已结束，直接返回
      if (responseEnded) {
        return;
      }

      // 计算输出token数（包括文本内容和工具调用参数）
      const completionTokens = countStringTokens(fullContent + toolCallArgs, model);
      const totalTokens = promptTokens + completionTokens;

      // 发送带usage的finish chunk
      try {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        const finishChunk = {
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
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
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

      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }

      logger.error('Kiro生成响应失败:', error.message);

      // 根据错误类型返回适当的状态码
      let statusCode = 500;
      let errorMessage = error.message;
      let errorType = 'api_error';
      
      // 订阅层无可用账号支持该模型
      const modelNotAllowedMarker = '没有可用的Kiro账号可用于模型:';
      if (typeof error.message === 'string' && error.message.includes(modelNotAllowedMarker)) {
        statusCode = 403; // Forbidden
        const modelId = error.message
          .split(modelNotAllowedMarker)[1]
          ?.split('（')[0]
          ?.trim();
        errorMessage = modelId ? `无可用账号可用于模型: ${modelId}` : '无可用账号可用于所选模型';
        errorType = 'model_not_allowed';
      }
      // 配额耗尽或无可用账号（非模型权限问题）
      else if (error.message.includes('没有可用的Kiro账号') ||
          error.message.includes('配额') ||
          error.message.includes('quota') ||
          error.message.includes('limit')) {
        statusCode = 429; // Too Many Requests
        errorMessage = '所有账号配额已耗尽，请稍后再试';
        errorType = 'insufficient_quota';
      } else if (error.message.includes('认证') ||
                 error.message.includes('授权') ||
                 error.message.includes('token')) {
        statusCode = 401; // Unauthorized
        errorType = 'authentication_error';
      }
      
      // 对于流式响应，如果还没有发送响应头，则设置状态码
      if (!res.headersSent) {
        res.status(statusCode).json({
          error: errorMessage,
          type: errorType
        });
      } else {
        // 如果已经开始发送流式数据，则在流中发送错误信息
        try {
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: `\n\n错误: ${errorMessage}` }, finish_reason: null }]
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
    }
  } else {
    // 非流式响应
    try {
      if (isWebSearchOnly) {
        const query = extractWebSearchQuery(promptMessages);
        if (!query) {
          return res.status(400).json({ error: '无法从 messages 中提取 web_search query' });
        }

        const accountOverride = await kiroClient.getAvailableAccount(req.user.user_id, [], model);
        const mcp = await kiroClient.webSearch(query, model, req.user.user_id, accountOverride);
        const question = extractLastUserText(promptMessages);
        const answerPrompt = buildWebSearchAnswerPrompt(question, mcp.query, mcp.results);

        const effectiveMessages = [
          ...promptMessages,
          { role: 'user', content: answerPrompt }
        ];
        const effectiveOptions = { ...options, tools: [], tool_choice: 'none' };

        const effectiveInputText = effectiveMessages.map(m => {
          if (typeof m.content === 'string') return m.content;
          if (Array.isArray(m.content)) {
            return m.content.filter(c => c.type === 'text').map(c => c.text).join('');
          }
          return '';
        }).join('\n');
        const effectivePromptTokens = countStringTokens(effectiveInputText, model);

        let fullContent = '';
        let toolCalls = [];
        let toolCallArgs = '';
        const toolCallsMap = new Map();

        await kiroClient.generateResponse(effectiveMessages, model, (data) => {
          if (data.type === 'tool_call_start') {
            const toolCall = data.tool_calls[0];
            toolCallsMap.set(toolCall.id, {
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.function.name,
                arguments: ''
              }
            });
            toolCallArgs += toolCall.function.name;
          } else if (data.type === 'tool_call_delta') {
            const toolCall = toolCallsMap.get(data.tool_call_id);
            if (toolCall) {
              toolCall.function.arguments += data.delta || '';
              toolCallArgs += data.delta || '';
            }
          } else if (data.type === 'tool_calls') {
            toolCalls = data.tool_calls;
            toolCallArgs += data.tool_calls.map(tc => tc.function?.name + (tc.function?.arguments || '')).join('');
          } else if (data.type === 'text') {
            fullContent += data.content;
          }
        }, req.user.user_id, effectiveOptions, accountOverride);

        if (toolCallsMap.size > 0) {
          toolCalls = Array.from(toolCallsMap.values());
        }

        const completionTokens = countStringTokens(fullContent + toolCallArgs, model);
        const totalTokens = effectivePromptTokens + completionTokens;

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
          }],
          usage: {
            prompt_tokens: effectivePromptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens
          }
        });
      }

      let fullContent = '';
      let toolCalls = [];
      let toolCallArgs = ''; // 累积工具调用参数用于token计算
      const toolCallsMap = new Map(); // 使用 Map 来跟踪多个工具调用

      const generate = hasConversationState
        ? kiroClient.generateResponseWithCwRequest.bind(kiroClient, { conversationState: rawConversationState })
        : kiroClient.generateResponse.bind(kiroClient, messages);

      await generate(model, (data) => {
        if (data.type === 'tool_call_start') {
          // 开始新的工具调用
          const toolCall = data.tool_calls[0];
          toolCallsMap.set(toolCall.id, {
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.function.name,
              arguments: ''
            }
          });
          toolCallArgs += toolCall.function.name;
        } else if (data.type === 'tool_call_delta') {
          // 累积工具调用参数到对应的工具调用
          const toolCall = toolCallsMap.get(data.tool_call_id);
          if (toolCall) {
            toolCall.function.arguments += data.delta || '';
            toolCallArgs += data.delta || '';
          }
        } else if (data.type === 'tool_calls') {
          // 兼容旧格式
          toolCalls = data.tool_calls;
          toolCallArgs += data.tool_calls.map(tc => tc.function?.name + (tc.function?.arguments || '')).join('');
        } else if (data.type === 'text') {
          fullContent += data.content;
        }
      }, req.user.user_id, options);

      // 将 Map 中的工具调用转换为数组
      if (toolCallsMap.size > 0) {
        toolCalls = Array.from(toolCallsMap.values());
      }

      // 计算输出token数（包括文本内容和工具调用参数）
      const completionTokens = countStringTokens(fullContent + toolCallArgs, model);
      const totalTokens = promptTokens + completionTokens;

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
        }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens
        }
      });
    } catch (error) {
      logger.error('Kiro生成响应失败:', error.message);
      
      // 根据错误类型返回适当的状态码
      let statusCode = 500;
      let errorMessage = error.message;
      let errorType = 'api_error';
      
      // 订阅层无可用账号支持该模型
      const modelNotAllowedMarker = '没有可用的Kiro账号可用于模型:';
      if (typeof error.message === 'string' && error.message.includes(modelNotAllowedMarker)) {
        statusCode = 403; // Forbidden
        const modelId = error.message
          .split(modelNotAllowedMarker)[1]
          ?.split('（')[0]
          ?.trim();
        errorMessage = modelId ? `无可用账号可用于模型: ${modelId}` : '无可用账号可用于所选模型';
        errorType = 'model_not_allowed';
      }
      // 配额耗尽或无可用账号（非模型权限问题）
      else if (error.message.includes('没有可用的Kiro账号') ||
          error.message.includes('配额') ||
          error.message.includes('quota') ||
          error.message.includes('limit')) {
        statusCode = 429; // Too Many Requests
        errorMessage = '所有账号配额已耗尽，请稍后再试';
        errorType = 'insufficient_quota';
      } else if (error.message.includes('认证') ||
                 error.message.includes('授权') ||
                 error.message.includes('token')) {
        statusCode = 401; // Unauthorized
        errorType = 'authentication_error';
      }
      
      res.status(statusCode).json({
        error: errorMessage,
        type: errorType
      });
    }
  }
});

export default router;
