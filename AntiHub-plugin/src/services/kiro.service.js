import https from 'https';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import redisService from './redis.service.js';
import parseKiroUsageLimits from './kiro_usage_limits_parser.js';

/**
 * Kiro OAuth Redis Key前缀
 */
const KIRO_OAUTH_KEY_PREFIX = 'kiro:oauth:state:';

/**
 * Kiro API 端点
 */
const KIRO_ENDPOINTS = {
  SOCIAL_LOGIN: {
    hostname: 'prod.us-east-1.auth.desktop.kiro.dev',
    path: '/login'
  },
  SOCIAL_REFRESH: {
    hostname: 'prod.us-east-1.auth.desktop.kiro.dev',
    path: '/refreshToken'
  },
  SOCIAL_TOKEN: {
    hostname: 'prod.us-east-1.auth.desktop.kiro.dev',
    path: '/oauth/token'
  },
  IDC_REFRESH: {
    hostname: 'oidc.us-east-1.amazonaws.com',
    path: '/token'
  },
  CODEWHISPERER: {
    hostname: 'q.us-east-1.amazonaws.com',
    path: '/generateAssistantResponse'
  },
  MCP: {
    hostname: 'q.us-east-1.amazonaws.com',
    path: '/mcp'
  },
  USAGE_LIMITS: {
    hostname: 'q.us-east-1.amazonaws.com',
    path: '/getUsageLimits'
  }
};

// Kiro / AWS 端点默认区域（历史兼容：之前写死 us-east-1）
const DEFAULT_AWS_REGION = 'us-east-1';
const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

function normalizeAwsRegion(value) {
  if (typeof value !== 'string') return DEFAULT_AWS_REGION;
  const region = value.trim().toLowerCase();
  if (!region) return DEFAULT_AWS_REGION;
  if (!AWS_REGION_RE.test(region)) {
    throw new Error('region 格式不正确（例如 us-east-1 / ap-southeast-2）');
  }
  return region;
}

function buildAwsEndpoints(region) {
  const normalizedRegion = normalizeAwsRegion(region);
  const qHost = `q.${normalizedRegion}.amazonaws.com`;
  return {
    region: normalizedRegion,
    IDC_REFRESH: { hostname: `oidc.${normalizedRegion}.amazonaws.com`, path: '/token' },
    CODEWHISPERER: { hostname: qHost, path: '/generateAssistantResponse' },
    MCP: { hostname: qHost, path: '/mcp' },
    USAGE_LIMITS: { hostname: qHost, path: '/getUsageLimits' },
    LIST_AVAILABLE_MODELS: { hostname: qHost, path: '/ListAvailableModels' },
  };
}

/**
 * Kiro OAuth 重定向URI
 */
const KIRO_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success';

/**
 * Kiro 模型映射
 */
const KIRO_MODEL_MAP = {
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4.5',
  'claude-sonnet-4-20250514': 'claude-sonnet-4',
  'claude-opus-4-5-20251101': 'claude-opus-4.5',
  // Compat: accept both 4.6 and 4-6 spellings (always send claude-opus-4.6 as modelId)
  'claude-opus-4-6-20260205': 'claude-opus-4.6',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-haiku-4-5-20251001': 'claude-haiku-4.5'
};

/**
 * Kiro 默认配置
 */
const KIRO_DEFAULTS = {
  MAX_TOKENS: 8192,
  AGENT_TASK_TYPE: 'vibe',
  CHAT_TRIGGER_TYPE: 'MANUAL',
  ORIGIN: 'AI_EDITOR'
};

/**
 * Kiro IDE版本
 */
const DEFAULT_KIRO_IDE_VERSION = '0.9.2';
const KIRO_IDE_VERSION = (process.env.KIRO_IDE_VERSION || '').trim() || DEFAULT_KIRO_IDE_VERSION;

class KiroService {
  constructor() {
    // 存储kiro账号配置
    this.accounts = [];
    this.currentIndex = 0;
  }

  /**
   * 生成64字符的machineid
   * @returns {string} machineid (32字节的hex字符串)
   */
  generateMachineId() {
    return crypto.randomBytes(32).toString('hex').toLowerCase();
  }

  /**
   * 生成PKCE code_verifier
   * @returns {string} code_verifier (base64url编码)
   */
  generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * 生成PKCE code_challenge
   * @param {string} codeVerifier - code_verifier
   * @returns {string} code_challenge (base64url编码的SHA256哈希)
   */
  generateCodeChallenge(codeVerifier) {
    return crypto.createHash('sha256').update(codeVerifier).digest().toString('base64url');
  }

  /**
   * 生成OAuth state
   * @returns {string} 随机UUID
   */
  generateState() {
    return crypto.randomUUID();
  }

  /**
   * 生成Kiro Social登录URL（自动生成machineid，存储到Redis）
   * @param {string} provider - 登录提供商 (Google 或 Github)
   * @param {string} user_id - 用户ID
   * @param {number} is_shared - 是否共享
   * @param {string} bearer_token - 用户的Bearer token
   * @returns {Promise<Object>} 包含auth_url, state的对象
   */
  async generateSocialLoginUrl(provider, user_id, is_shared, bearer_token) {
    // 验证provider
    if (!['Google', 'Github'].includes(provider)) {
      throw new Error('provider必须是Google或Github');
    }

    // 自动生成machineid
    const machineid = this.generateMachineId();

    // 生成PKCE参数
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);
    const state = this.generateState();

    // 构建登录URL
    const params = new URLSearchParams({
      idp: provider,
      redirect_uri: KIRO_REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: state
    });

    const authUrl = `https://${KIRO_ENDPOINTS.SOCIAL_LOGIN.hostname}${KIRO_ENDPOINTS.SOCIAL_LOGIN.path}?${params.toString()}`;

    // 保存OAuth状态到Redis（600秒过期），包含bearer_token
    const stateData = {
      code_verifier: codeVerifier,
      machineid,
      provider,
      user_id,
      is_shared,
      bearer_token,
      timestamp: Date.now()
    };

    await redisService.set(`${KIRO_OAUTH_KEY_PREFIX}${state}`, stateData, 600);

    logger.info(`生成Kiro Social登录URL: provider=${provider}, state=${state}, machineid=${machineid.substring(0, 8)}...`);

    return {
      auth_url: authUrl,
      state,
      expires_in: 600 // 10分钟后过期
    };
  }

  /**
   * 获取OAuth状态信息（从Redis）
   * @param {string} state - OAuth state
   * @returns {Promise<Object|null>} 状态信息或null
   */
  async getOAuthStateInfo(state) {
    try {
      const info = await redisService.get(`${KIRO_OAUTH_KEY_PREFIX}${state}`);
      return info;
    } catch (error) {
      logger.error('获取OAuth状态失败:', error.message);
      return null;
    }
  }

  /**
   * 更新OAuth状态（在Redis中）
   * @param {string} state - OAuth state
   * @param {Object} updates - 要更新的字段
   */
  async updateOAuthState(state, updates) {
    try {
      const info = await redisService.get(`${KIRO_OAUTH_KEY_PREFIX}${state}`);
      if (!info) {
        logger.warn(`OAuth状态不存在: state=${state}`);
        return false;
      }
      
      // 合并更新
      const updatedInfo = { ...info, ...updates };
      
      // 计算剩余TTL（如果有的话）
      const ttl = 600; // 默认10分钟
      await redisService.set(`${KIRO_OAUTH_KEY_PREFIX}${state}`, updatedInfo, ttl);
      
      logger.info(`OAuth状态已更新: state=${state}`);
      return true;
    } catch (error) {
      logger.error('更新OAuth状态失败:', error.message);
      return false;
    }
  }

  /**
   * 删除OAuth状态（从Redis）
   * @param {string} state - OAuth state
   */
  async deleteOAuthState(state) {
    try {
      await redisService.del(`${KIRO_OAUTH_KEY_PREFIX}${state}`);
    } catch (error) {
      logger.error('删除OAuth状态失败:', error.message);
    }
  }

  /**
   * 解析kiro://回调URL，提取code和state
   * @param {string} callbackUrl - 回调URL
   * @returns {Object} { code, state }
   */
  parseCallbackUrl(callbackUrl) {
    // 格式: kiro://kiro.kiroAgent/authenticate-success?code=xxx&state=xxx
    const url = new URL(callbackUrl);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      throw new Error('回调URL缺少code或state参数');
    }

    return { code, state };
  }

  /**
   * 使用授权码交换token (Social登录)
   * @param {string} code - 授权码
   * @param {string} codeVerifier - PKCE code_verifier
   * @param {string} machineid - 机器ID
   * @returns {Promise<Object>} Token数据
   */
  async exchangeCodeForToken(code, codeVerifier, machineid) {
    const requestId = crypto.randomUUID().substring(0, 8);
    logger.info(`[${requestId}] 开始交换Kiro Social授权码`);

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: KIRO_REDIRECT_URI
      });

      const options = {
        hostname: KIRO_ENDPOINTS.SOCIAL_TOKEN.hostname,
        path: KIRO_ENDPOINTS.SOCIAL_TOKEN.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'user-agent': `KiroIDE-${KIRO_IDE_VERSION}-${machineid}`
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              logger.info(`[${requestId}] Kiro Social授权码交换成功`);
              resolve({
                access_token: data.accessToken,
                refresh_token: data.refreshToken,
                expires_in: data.expiresIn,
                profile_arn: data.profileArn
              });
            } catch (error) {
              logger.error(`[${requestId}] JSON解析失败:`, error.message);
              reject(new Error(`JSON解析失败: ${error.message}`));
            }
          } else {
            logger.error(`[${requestId}] 授权码交换失败: HTTP ${res.statusCode} - ${body}`);
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error(`[${requestId}] 请求异常:`, error.message);
        reject(error);
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * 登出Kiro账号
   * @param {string} machineid - 机器ID
   * @returns {Promise<boolean>} 是否成功登出
   */
  async logout(refreshToken, machineid) {
    const requestId = crypto.randomUUID().substring(0, 8);
    logger.info(`[${requestId}] 开始Kiro账号登出`);

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ refreshToken });

      const options = {
        hostname: 'prod.us-east-1.auth.desktop.kiro.dev',
        path: '/logout',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'user-agent': `KiroIDE-${KIRO_IDE_VERSION}-${machineid}`
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            logger.info(`[${requestId}] Kiro账号登出成功`);
            resolve(true);
          } else {
            logger.warn(`[${requestId}] Kiro账号登出失败: HTTP ${res.statusCode} - ${body}`);
            // 即使登出失败也返回true，允许删除本地记录
            resolve(true);
          }
        });
      });

      req.on('error', (error) => {
        logger.error(`[${requestId}] 登出请求异常:`, error.message);
        // 网络错误也返回true，允许删除本地记录
        resolve(true);
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * 加载Kiro账号配置
   * @param {Array} configs - 账号配置数组
   */
  loadAccounts(configs) {
    this.accounts = configs.filter(c => !c.disabled);
    logger.info(`已加载 ${this.accounts.length} 个Kiro账号`);
  }

  /**
   * 刷新Social认证token
   * @param {string} refreshToken - 刷新令牌
   * @returns {Promise<Object>} Token数据
   */
  async refreshSocialToken(refreshToken, machineid) {
    const requestId = crypto.randomUUID().substring(0, 8);
    logger.info(`[${requestId}] 开始刷新Kiro Social Token`);

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ refreshToken });
      const kiroUserAgent = `KiroIDE-${KIRO_IDE_VERSION}-${machineid}`;

      const options = {
        hostname: KIRO_ENDPOINTS.SOCIAL_REFRESH.hostname,
        path: KIRO_ENDPOINTS.SOCIAL_REFRESH.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'user-agent': `${kiroUserAgent}`,
          'host': KIRO_ENDPOINTS.SOCIAL_REFRESH.hostname,
          'sec-fetch-mode': 'cors',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              logger.info(`[${requestId}] Kiro Social Token刷新成功, expires_in=${data.expiresIn}`);
              resolve({
                access_token: data.accessToken,
                expires_in: data.expiresIn,
                profile_arn: data.profileArn
              });
            } catch (error) {
              logger.error(`[${requestId}] JSON解析失败:`, error.message);
              reject(new Error(`JSON解析失败: ${error.message}`));
            }
          } else {
            logger.error(`[${requestId}] Kiro Social Token刷新失败: HTTP ${res.statusCode}`);
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error(`[${requestId}] 请求异常:`, error.message);
        reject(error);
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * 刷新IdC认证token
   * @param {string} refreshToken - 刷新令牌
   * @param {string} clientId - 客户端ID
   * @param {string} clientSecret - 客户端密钥
   * @returns {Promise<Object>} Token数据
   */
  async refreshIdCToken(refreshToken, clientId, clientSecret, region) {
    const requestId = crypto.randomUUID().substring(0, 8);
    const endpoints = buildAwsEndpoints(region);
    logger.info(`[${requestId}] 开始刷新Kiro IdC Token: region=${endpoints.region}`);

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        clientId,
        clientSecret,
        grantType: 'refresh_token',
        refreshToken
      });

      const options = {
        hostname: endpoints.IDC_REFRESH.hostname,
        path: endpoints.IDC_REFRESH.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Host': endpoints.IDC_REFRESH.hostname,
          'x-amz-user-agent': 'aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#3.738.0 m/E KiroIDE',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              logger.info(`[${requestId}] Kiro IdC Token刷新成功, expires_in=${data.expiresIn}`);
              resolve({
                access_token: data.accessToken,
                expires_in: data.expiresIn
              });
            } catch (error) {
              logger.error(`[${requestId}] JSON解析失败:`, error.message);
              reject(new Error(`JSON解析失败: ${error.message}`));
            }
          } else {
            logger.error(`[${requestId}] Kiro IdC Token刷新失败: HTTP ${res.statusCode}`);
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error(`[${requestId}] 请求异常:`, error.message);
        reject(error);
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * 刷新Kiro token（根据认证方式）
   * @param {Object} account - 账号配置
   * @returns {Promise<Object>} Token数据
   */
  async refreshToken(account) {
    if (account.auth === 'Social') {
      return await this.refreshSocialToken(account.refreshToken, account.machineid);
    } else if (account.auth === 'IdC') {
      if (!account.clientId || !account.clientSecret) {
        throw new Error('IdC认证需要clientId和clientSecret');
      }
      return await this.refreshIdCToken(account.refreshToken, account.clientId, account.clientSecret, account.region);
    } else {
      throw new Error(`未知的认证方式: ${account.auth}`);
    }
  }

  /**
   * 获取CodeWhisperer请求头
   * @param {string} accessToken - 访问令牌
   * @returns {Object} 请求头
   */
  getCodeWhispererHeaders(accessToken, machineid, region) {
    const invocationId = crypto.randomUUID();
    const endpoints = buildAwsEndpoints(region);
    const kiroUserAgent = `KiroIDE-${KIRO_IDE_VERSION}-${machineid}`;
    
    return {
      'Content-Type': 'application/json',
      'x-amzn-codewhisperer-optout': 'true',
      'x-amzn-kiro-agent-mode': 'vibe',
      'x-amz-user-agent': `aws-sdk-js/1.0.26 ${kiroUserAgent}`,
      'user-agent': `aws-sdk-js/1.0.26 ua/2.1os/win32#10.0.26100 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.26 m/E ${kiroUserAgent}`,
      'host': endpoints.CODEWHISPERER.hostname,
      'amz-sdk-invocation-id': invocationId,
      'amz-sdk-request': 'attempt=1; max=3',
      'Authorization': `Bearer ${accessToken}`
    };
  }

  /**
   * 获取 MCP 请求头（用于 /mcp tools/call）
   * @param {string} accessToken - 访问令牌
   * @param {string} machineid - 机器ID
   * @returns {Object} 请求头
   */
  getMcpHeaders(accessToken, machineid, region) {
    const invocationId = crypto.randomUUID();
    const endpoints = buildAwsEndpoints(region);
    const kiroUserAgent = `KiroIDE-${KIRO_IDE_VERSION}-${machineid}`;

    // MCP 端点参考 kiro.rs：不带 codewhisperer optout 等字段，避免触发上游校验
    return {
      'content-type': 'application/json',
      'x-amz-user-agent': `aws-sdk-js/1.0.26 ${kiroUserAgent}`,
      'user-agent': `aws-sdk-js/1.0.26 ua/2.1 os/win32#10.0.26100 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.26 m/E ${kiroUserAgent}`,
      'host': endpoints.MCP.hostname,
      'amz-sdk-invocation-id': invocationId,
      'amz-sdk-request': 'attempt=1; max=3',
      'Authorization': `Bearer ${accessToken}`,
      'Connection': 'close'
    };
  }

  /**
   * 获取Kiro模型ID
   * @param {string} model - 模型名称
   * @returns {string} Kiro模型ID
   */
  getKiroModelId(model) {
    const modelId = KIRO_MODEL_MAP[model];
    if (!modelId) {
      throw new Error(`未知的Kiro模型: ${model}，可用模型: ${Object.keys(KIRO_MODEL_MAP).join(', ')}`);
    }
    return modelId;
  }

  /**
   * 将 thinking part 转换为普通 text part，并移除 signature
   * Kiro 模型不支持 thinking 功能，需要将 thinking 内容转换为普通文本
   * @param {Array} messages - 消息数组
   * @returns {Array} 处理后的消息数组
   */
  patchThinkingParts(messages) {
    if (!Array.isArray(messages)) return messages;

    return messages.map(message => {
      // 如果消息没有 content 或 content 不是数组，直接返回
      if (!message.content || !Array.isArray(message.content)) {
        return message;
      }

      // 处理 content 数组中的每个 part
      const patchedContent = message.content.map(part => {
        // 检查是否是 thinking part（有 thought: true 属性）
        if (part && part.thought === true) {
          // 创建新对象，只保留 text 和 type 属性，移除 thought 和 thoughtSignature
          const patchedPart = { type: 'text' };
          if (part.text !== undefined) {
            patchedPart.text = part.text;
          }
          return patchedPart;
        }

        // 检查是否是 Anthropic 格式的 thinking block（type: 'thinking'）
        if (part && part.type === 'thinking') {
          // 转换为普通 text part，移除 signature
          const patchedPart = { type: 'text' };
          if (part.thinking !== undefined) {
            patchedPart.text = part.thinking;
          } else if (part.text !== undefined) {
            patchedPart.text = part.text;
          }
          // 不复制 signature 字段
          return patchedPart;
        }

        // 如果 part 有 thoughtSignature 属性，移除它
        if (part && part.thoughtSignature !== undefined) {
          const { thoughtSignature, ...rest } = part;
          return rest;
        }

        return part;
      });

      return {
        ...message,
        content: patchedContent
      };
    });
  }

  /**
   * 将OpenAI格式消息转换为CodeWhisperer格式
   * @param {Array} messages - OpenAI格式消息
   * @param {string} model - 模型名称
   * @param {Object} options - 其他选项
   * @returns {Object} CodeWhisperer请求体
   */
  convertToCodeWhispererRequest(messages, model, options = {}) {
    // 先处理 thinking parts，将其转换为普通 text parts
    const patchedMessages = this.patchThinkingParts(messages);
    
    const modelId = this.getKiroModelId(model);
    const conversationId = crypto.randomUUID();
    const agentContinuationId = crypto.randomUUID();

    // 提取系统消息（使用处理后的消息）
    const systemMessages = patchedMessages.filter(m => m.role === 'system');
    const nonSystemMessages = patchedMessages.filter(m => m.role !== 'system');

    // OpenAI 格式：多工具调用会产生连续多个 role=tool 的消息（每个 tool_call 一条）
    // Kiro/CodeWhisperer 更偏向一次性提交 toolResults 数组；这里把“末尾连续 tool 消息”整体收敛到一次处理里，避免拆成多段导致 400
    let tailToolMessages = [];
    let coreMessages = nonSystemMessages;
    if (nonSystemMessages.length > 0) {
      let idx = nonSystemMessages.length;
      while (idx > 0 && nonSystemMessages[idx - 1]?.role === 'tool') {
        tailToolMessages.unshift(nonSystemMessages[idx - 1]);
        idx--;
      }
      if (tailToolMessages.length > 0 && idx > 0) {
        coreMessages = nonSystemMessages.slice(0, idx);
      } else {
        tailToolMessages = [];
      }
    }

    // 构建历史记录
    const history = [];

    // 添加系统消息到历史
    if (systemMessages.length > 0) {
      const systemContent = systemMessages.map(m => 
        typeof m.content === 'string' ? m.content : 
        m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      ).join('\n');

      history.push({
        userInputMessage: {
          content: systemContent,
          modelId,
          origin: KIRO_DEFAULTS.ORIGIN,
          images: [],
          userInputMessageContext: {}
        }
      });

      history.push({
        assistantResponseMessage: {
          content: 'OK',
        }
      });
    }

    // 处理对话历史（除了最后一条消息）
    let userBuffer = [];
    const historyEndIndex = tailToolMessages.length > 0 ? coreMessages.length : coreMessages.length - 1;
    for (let i = 0; i < historyEndIndex; i++) {
      const msg = coreMessages[i];

      if (msg.role === 'user' || msg.role === 'tool') {
        userBuffer.push(msg);
      } else if (msg.role === 'assistant') {
        // 处理累积的用户消息（包括tool消息）
        if (userBuffer.length > 0) {
          const content = userBuffer
            .filter(m => m.role === 'user')
            .map(m => this.extractTextContent(m.content))
            .join('\n');
          const images = userBuffer
            .filter(m => m.role === 'user')
            .flatMap(m => this.extractImages(m.content));
          // 从user消息中提取tool_result块，以及从tool消息中提取工具结果
          const toolResults = [
            ...userBuffer.filter(m => m.role === 'user').flatMap(m => this.extractToolResults(m.content)),
            ...userBuffer.filter(m => m.role === 'tool').map(m => this.convertToolMessageToResult(m))
          ].filter(Boolean);

          history.push({
            userInputMessage: {
              content: toolResults.length > 0 ? '' : content,
              modelId,
              origin: KIRO_DEFAULTS.ORIGIN,
              images,
              userInputMessageContext: toolResults.length > 0 ? { toolResults } : {}
            }
          });

          userBuffer = [];
        }

        // 添加助手消息
        const textContent = this.extractTextContent(msg.content);
        // 同时支持 Anthropic 格式（content数组中的tool_use）和 OpenAI 格式（顶层tool_calls）
        const toolUses = this.extractToolUses(msg.content, msg.tool_calls);

        history.push({
          assistantResponseMessage: {
            content: (textContent || '').trim() || (toolUses.length > 0 ? 'There is a tool use.' : ''),
            ...(toolUses.length > 0 ? { toolUses } : {})
          }
        });
      }
    }

    // 处理末尾的孤立用户消息（包括tool消息）
    if (userBuffer.length > 0) {
      const content = userBuffer
        .filter(m => m.role === 'user')
        .map(m => this.extractTextContent(m.content))
        .join('\n');
      const images = userBuffer
        .filter(m => m.role === 'user')
        .flatMap(m => this.extractImages(m.content));
      // 从user消息中提取tool_result块，以及从tool消息中提取工具结果
      const toolResults = [
        ...userBuffer.filter(m => m.role === 'user').flatMap(m => this.extractToolResults(m.content)),
        ...userBuffer.filter(m => m.role === 'tool').map(m => this.convertToolMessageToResult(m))
      ].filter(Boolean);

      history.push({
        userInputMessage: {
          content: toolResults.length > 0 ? '' : content,
          modelId,
          origin: KIRO_DEFAULTS.ORIGIN,
          images,
          userInputMessageContext: toolResults.length > 0 ? { toolResults } : {}
        }
      });

      history.push({
        assistantResponseMessage: {
          content: 'OK',
        }
      });
    }

    // 处理当前消息（最后一条）
    const lastMessage = coreMessages[coreMessages.length - 1];
    
    // 检查最后一条消息是否是tool消息（OpenAI格式的工具结果）
    const isToolMessage = lastMessage.role === 'tool';
    
    let currentContent = isToolMessage ? '' : this.extractTextContent(lastMessage.content);
    const currentImages = isToolMessage ? [] : this.extractImages(lastMessage.content);
    
    // 提取工具结果：从user消息的content中提取tool_result块，或从tool消息转换
    let currentToolResults = [];
    if (tailToolMessages.length > 0) {
      currentToolResults = tailToolMessages
        .map(m => this.convertToolMessageToResult(m))
        .filter(Boolean);
    } else if (isToolMessage) {
      const toolResult = this.convertToolMessageToResult(lastMessage);
      if (toolResult) {
        currentToolResults = [toolResult];
      }
    } else {
      currentToolResults = this.extractToolResults(lastMessage.content);
    }

    // 如果最后一条消息包含工具结果，需要特殊处理
    if (currentToolResults.length > 0) {
      // 找到工具调用之前的用户消息（用于 currentMessage.content）
      let userContentBeforeToolCall = '';
      let imagesBeforeToolCall = [];
      for (let i = coreMessages.length - 1; i >= 0; i--) {
        const msg = coreMessages[i];
        if (msg.role === 'user') {
          const textContent = this.extractTextContent(msg.content);
          const toolResultsInMsg = this.extractToolResults(msg.content);
          // 找到一条有文本内容且不只是工具结果的用户消息
          if (textContent && toolResultsInMsg.length === 0) {
            userContentBeforeToolCall = textContent;
            imagesBeforeToolCall = this.extractImages(msg.content);
            break;
          }
        }
      }
      
      // 获取工具结果的文本内容（用于 history 中的 userInputMessage.content）
      if (!userContentBeforeToolCall && options.tools?.length > 0) {
        userContentBeforeToolCall = '鎵ц宸ュ叿浠诲姟';
      }

      const toolResultTextContent = currentToolResults.map(tr =>
        tr.content.map(c => c.text || '').join('')
      ).join('\n');

      // 在 history 末尾插入：
      // 1. 包含 toolResults 的 userInputMessage（content 是工具结果的文本）
      // 2. 助手确认消息
      history.push({
        userInputMessage: {
          content: toolResultTextContent,
          modelId,
          origin: KIRO_DEFAULTS.ORIGIN,
          userInputMessageContext: {
            toolResults: currentToolResults
          }
        }
      });
      
      history.push({
        assistantResponseMessage: {
          content: 'I will follow these instructions.'
        }
      });

      // currentMessage 的 userInputMessageContext 只包含 tools，不包含 toolResults
      const userInputMessageContext = {};
      if (options.tools?.length > 0) {
        userInputMessageContext.tools = this.convertToolsToCodeWhisperer(options.tools);
      }

      return {
        conversationState: {
          agentContinuationId,
          agentTaskType: KIRO_DEFAULTS.AGENT_TASK_TYPE,
          chatTriggerType: this.determineChatTriggerType(options),
          currentMessage: {
            userInputMessage: {
              userInputMessageContext,
              content: userContentBeforeToolCall,  // 工具调用之前的用户消息
              modelId,
              images: imagesBeforeToolCall.length > 0 ? imagesBeforeToolCall : currentImages,
              origin: KIRO_DEFAULTS.ORIGIN
            }
          },
          conversationId,
          history
        }
      };
    }

    // 普通情况：最后一条消息不包含工具结果
    // 如果没有内容但有工具，注入占位符
    if (!currentContent && !currentImages.length && options.tools?.length > 0) {
      currentContent = '执行工具任务';
    }

    const userInputMessageContext = {};
    if (options.tools?.length > 0) {
      userInputMessageContext.tools = this.convertToolsToCodeWhisperer(options.tools);
    }

    return {
      conversationState: {
        agentContinuationId,
        agentTaskType: KIRO_DEFAULTS.AGENT_TASK_TYPE,
        chatTriggerType: this.determineChatTriggerType(options),
        currentMessage: {
          userInputMessage: {
            userInputMessageContext,
            content: currentContent,
            modelId,
            images: currentImages,
            origin: KIRO_DEFAULTS.ORIGIN
          }
        },
        conversationId,
        history
      }
    };
  }

  /**
   * 提取文本内容
   */
  extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
    }
    return '';
  }

  /**
   * 提取图片
   * 支持两种格式：
   * 1. OpenAI格式: { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
   * 2. Anthropic格式: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
   */
  extractImages(content) {
    if (!Array.isArray(content)) return [];
    
    const images = [];
    
    for (const block of content) {
      // OpenAI格式: image_url
      if (block.type === 'image_url' && block.image_url?.url) {
        const url = block.image_url.url;
        
        // 处理base64 data URL
        if (url.startsWith('data:')) {
          const match = url.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const format = match[1] || 'png';
            const base64Data = match[2];
            images.push({
              format: format === 'jpeg' ? 'jpeg' : format,
              source: { bytes: base64Data }
            });
          }
        }
        // 处理普通URL（需要先下载，这里暂不支持，记录警告）
        else if (url.startsWith('http://') || url.startsWith('https://')) {
          logger.warn('Kiro不支持URL格式的图片，请使用base64格式');
        }
      }
      // Anthropic格式: image
      else if (block.type === 'image' && block.source) {
        images.push({
          format: block.source.media_type?.split('/')[1] || 'png',
          source: { bytes: block.source.data }
        });
      }
    }
    
    return images;
  }

  /**
   * 提取工具结果
   */
  extractToolResults(content) {
    if (!Array.isArray(content)) return [];
    return content
      .filter(b => b.type === 'tool_result' && b.tool_use_id)
      .map(b => {
        let contentArray = [];
        if (typeof b.content === 'string') {
          contentArray = [{ text: b.content }];
        } else if (Array.isArray(b.content)) {
          contentArray = b.content.map(item => 
            typeof item === 'string' ? { text: item } : item
          );
        } else if (b.content) {
          contentArray = [{ text: String(b.content) }];
        }
        if (contentArray.length === 0) contentArray = [{ text: '' }];

        return {
          toolUseId: b.tool_use_id,
          content: contentArray,
          status: b.is_error ? 'error' : 'success',
          isError: b.is_error || false
        };
      });
  }

  /**
   * 将OpenAI格式的tool消息转换为Kiro的toolResult格式
   * OpenAI格式: { role: 'tool', tool_call_id: 'xxx', content: '...' }
   * Kiro格式: { toolUseId: 'xxx', content: [{ text: '...' }], status: 'success', isError: false }
   * @param {Object} msg - OpenAI格式的tool消息
   * @returns {Object|null} Kiro格式的toolResult，或null如果转换失败
   */
  convertToolMessageToResult(msg) {
    if (!msg || msg.role !== 'tool' || !msg.tool_call_id) {
      return null;
    }

    let contentArray = [];
    if (typeof msg.content === 'string') {
      contentArray = [{ text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      contentArray = msg.content.map(item =>
        typeof item === 'string' ? { text: item } : (item.text ? { text: item.text } : item)
      );
    } else if (msg.content) {
      contentArray = [{ text: String(msg.content) }];
    }
    
    if (contentArray.length === 0) {
      contentArray = [{ text: '' }];
    }

    return {
      toolUseId: msg.tool_call_id,
      content: contentArray,
      status: 'success',
      isError: false
    };
  }

  /**
   * 提取工具调用
   * 支持两种格式：
   * 1. Anthropic格式: content数组中的 { type: 'tool_use', id, name, input }
   * 2. OpenAI格式: 消息顶层的 tool_calls 数组 [{ id, type: 'function', function: { name, arguments } }]
   * @param {string|Array} content - 消息内容
   * @param {Array} toolCalls - OpenAI格式的tool_calls数组（可选）
   */
  extractToolUses(content, toolCalls = null) {
    const results = [];
    
    // 处理Anthropic格式: content数组中的tool_use块
    if (Array.isArray(content)) {
      const anthropicToolUses = content
        .filter(b => b.type === 'tool_use' && b.id && b.name)
        .map(b => ({
          toolUseId: b.id,
          name: b.name,
          input: b.input || {}
        }));
      results.push(...anthropicToolUses);
    }
    
    // 处理OpenAI格式: 顶层的tool_calls数组
    if (Array.isArray(toolCalls)) {
      const openaiToolUses = toolCalls
        .filter(tc => tc.id && (tc.function?.name || tc.name))
        .map(tc => {
          let input = {};
          // 解析arguments（可能是JSON字符串）
          if (tc.function?.arguments) {
            try {
              input = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
            } catch (e) {
              input = { raw: tc.function.arguments };
            }
          } else if (tc.input) {
            input = tc.input;
          }
          
          return {
            toolUseId: tc.id,
            name: tc.function?.name || tc.name,
            input
          };
        });
      results.push(...openaiToolUses);
    }
    
    return results;
  }

  /**
   * 转换工具为CodeWhisperer格式
   */
  convertToolsToCodeWhisperer(tools) {
    const ensureObjectSchema = (schema) => {
      if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
      }
      if (schema.type == null) {
        return { ...schema, type: 'object', properties: schema.properties || {} };
      }
      return schema;
    };

    const ensureNonEmptyDescription = (value) => {
      const text = value == null ? '' : String(value);
      const trimmed = text.trim();
      return trimmed || '当前工具无说明';
    };

    if (!Array.isArray(tools)) return [];

    return tools.map(t => ({
      toolSpecification: {
        name: t?.function?.name || t?.name,
        description: ensureNonEmptyDescription(t?.function?.description ?? t?.description),
        inputSchema: { json: ensureObjectSchema(t?.function?.parameters || t?.input_schema) }
      }
    }));
  }

  /**
   * 确定聊天触发类型
   */
  determineChatTriggerType(_options) {
    // 经验结论：chatTriggerType= AUTO 在 Kiro / CodeWhisperer 上游会触发 400
    // 统一使用 MANUAL，避免 "Improperly formed request."
    return 'MANUAL';
  }

  /**
   * MCP WebSearch：调用 Kiro 的 /mcp tools/call(web_search)
   * @param {string} query - 搜索关键词
   * @param {string} accessToken - Kiro access token
   * @param {string} machineid - 机器ID
   * @returns {Promise<Object>} { toolUseId, query, results }
   */
  async mcpWebSearch(query, accessToken, machineid, region) {
    const trimmed = String(query || '').trim();
    if (!trimmed) {
      throw new Error('web_search query 不能为空');
    }

    const random22 = this._randomAlnum(22, true);
    const random8 = this._randomAlnum(8, false);
    const requestId = `web_search_tooluse_${random22}_${Date.now()}_${random8}`;
    const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, '')}`;

    const payload = {
      id: requestId,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'web_search',
        arguments: { query: trimmed }
      }
    };

    const requestBody = JSON.stringify(payload);
    const endpoints = buildAwsEndpoints(region);
    const headers = this.getMcpHeaders(accessToken, machineid, endpoints.region);
    headers['Content-Length'] = Buffer.byteLength(requestBody);

    const raw = await this._httpsJsonRequest({
      hostname: endpoints.MCP.hostname,
      path: endpoints.MCP.path,
      method: 'POST',
      headers
    }, requestBody);

    // MCP JSON-RPC response
    if (raw?.error) {
      const code = raw.error?.code ?? -1;
      const msg = raw.error?.message ?? 'Unknown MCP error';
      throw new Error(`MCP error: ${code} - ${msg}`);
    }

    const first = raw?.result?.content?.[0];
    const text = first && first.type === 'text' ? first.text : null;
    let results = null;
    if (typeof text === 'string' && text.trim()) {
      try {
        results = JSON.parse(text);
      } catch (e) {
        results = { results: [], error: 'Invalid MCP result JSON', raw: text };
      }
    } else {
      results = { results: [], error: 'Empty MCP result' };
    }

    return { toolUseId, query: trimmed, results };
  }

  _randomAlnum(length, mixedCase) {
    const charset = mixedCase
      ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      : 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i++) {
      const idx = crypto.randomInt(0, charset.length);
      out += charset[idx];
    }
    return out;
  }

  _httpsJsonRequest(options, body) {
    const requestId = crypto.randomUUID().substring(0, 8);

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            logger.error(`[${requestId}] MCP请求失败: HTTP ${res.statusCode} - ${raw}`);
            return reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            logger.error(`[${requestId}] MCP响应JSON解析失败: ${e.message}`);
            reject(new Error(`MCP响应JSON解析失败: ${e.message}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error(`[${requestId}] MCP请求异常:`, error.message);
        reject(error);
      });

      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * 从Kiro API获取可用模型列表
   * @param {string} accessToken - 访问令牌
   * @param {string} profileArn - Profile ARN
   * @param {string} machineid - 机器ID
   * @returns {Promise<Array>} 模型列表
   */
  async listAvailableModels(accessToken, profileArn, machineid, region) {
    const requestId = crypto.randomUUID().substring(0, 8);
    logger.info(`[${requestId}] 开始获取Kiro可用模型列表`);

    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({ origin: 'AI_EDITOR' });
      if (typeof profileArn === 'string' && profileArn.trim()) {
        params.append('profileArn', profileArn.trim());
      }

      const invocationId = crypto.randomUUID();
      const kiroUserAgent = `KiroIDE-${KIRO_IDE_VERSION}-${machineid}`;
      const endpoints = buildAwsEndpoints(region);

      const options = {
        hostname: endpoints.LIST_AVAILABLE_MODELS.hostname,
        path: `${endpoints.LIST_AVAILABLE_MODELS.path}?${params.toString()}`,
        method: 'GET',
        headers: {
          'x-amz-user-agent': `aws-sdk-js/1.0.0 ${kiroUserAgent}`,
          'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/win32#10.0.26100 lang/js md/nodejs#22.21.1 api/codewhispererruntime#1.0.0 m/E ${kiroUserAgent}`,
          'host': endpoints.LIST_AVAILABLE_MODELS.hostname,
          'amz-sdk-invocation-id': invocationId,
          'amz-sdk-request': 'attempt=1; max=1',
          'Authorization': `Bearer ${accessToken}`
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              logger.info(`[${requestId}] 获取模型列表成功`);
              resolve(data);
            } catch (error) {
              logger.error(`[${requestId}] JSON解析失败:`, error.message);
              reject(new Error(`JSON解析失败: ${error.message}`));
            }
          } else {
            logger.error(`[${requestId}] 获取模型列表失败: HTTP ${res.statusCode}`);
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error(`[${requestId}] 请求异常:`, error.message);
        reject(error);
      });
      req.end();
    });
  }

  /**
   * 获取可用的Kiro模型列表（静态列表，兼容旧接口）
   * @returns {Array} 模型列表
   */
  getAvailableModels() {
    return Object.keys(KIRO_MODEL_MAP).map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'anthropic'
    }));
  }

  /**
   * 获取使用量限制信息
   * @param {string} accessToken - 访问令牌
   * @param {string} profileArn - Profile ARN
   * @param {string} machineid - 机器ID
   * @returns {Promise<Object>} 使用量信息
   */
  async getUsageLimits(accessToken, profileArn, machineid, region) {
    const requestId = crypto.randomUUID().substring(0, 8);
    logger.info(`[${requestId}] 开始获取Kiro使用量信息`);
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        isEmailRequired: 'true',
        origin: 'AI_EDITOR',
        resourceType: 'AGENTIC_REQUEST'
      });
      if (typeof profileArn === 'string' && profileArn.trim()) {
        params.append('profileArn', profileArn.trim());
      }

      const invocationId = crypto.randomUUID();
      const kiroUserAgent = `KiroIDE-${KIRO_IDE_VERSION}-${machineid}`;
      const endpoints = buildAwsEndpoints(region);

      const options = {
        hostname: endpoints.USAGE_LIMITS.hostname,
        path: `${endpoints.USAGE_LIMITS.path}?${params.toString()}`,
        method: 'GET',
        headers: {
          'x-amz-user-agent': `aws-sdk-js/1.0.0 ${kiroUserAgent}`,
          'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/win32#10.0.26100 lang/js md/nodejs#22.21.1 api/codewhispererruntime#1.0.0 m/E ${kiroUserAgent}`,
          'host': endpoints.USAGE_LIMITS.hostname,
          'amz-sdk-invocation-id': invocationId,
          'amz-sdk-request': 'attempt=1; max=1',
          'Authorization': `Bearer ${accessToken}`
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              logger.info(`[${requestId}] 获取使用量信息成功`);
              
              // 解析使用量数据
              const result = this.parseUsageLimits(data);
              resolve(result);
            } catch (error) {
              logger.error(`[${requestId}] JSON解析失败:`, error.message);
              reject(new Error(`JSON解析失败: ${error.message}`));
            }
          } else {
            logger.error(`[${requestId}] 获取使用量失败: HTTP ${res.statusCode}`);
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        logger.error(`[${requestId}] 请求异常:`, error.message);
        reject(error);
      });
      req.end();
    });
  }

  /**
   * 解析使用量限制数据
   * @param {Object} data - 原始使用量数据
   * @returns {Object} 解析后的数据
   */
  parseUsageLimits(data) {
    return parseKiroUsageLimits(data);
  }

  /**
   * 计算可用额度
   * @param {Object} usageLimits - 使用量信息
   * @returns {number} 可用额度
   */
  calculateAvailableCount(usageLimits) {
    let totalAvailable = 0;

    // 添加bonus额度（包含免费试用和bonus）
    totalAvailable += usageLimits.bonus_available || 0;

    // 添加基础额度
    const baseAvailable = usageLimits.usage_limit - usageLimits.current_usage;
    totalAvailable += baseAvailable;

    return Math.max(0, totalAvailable);
  }
}

const kiroService = new KiroService();
export default kiroService;
export { KIRO_MODEL_MAP, KIRO_ENDPOINTS, KIRO_DEFAULTS };
