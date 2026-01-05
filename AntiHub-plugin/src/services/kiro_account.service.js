import database from '../db/database.js';
import logger from '../utils/logger.js';

class KiroAccountService {
  /**
   * 根据userid查找账号
   * @param {string} userid - Kiro用户ID
   * @returns {Promise<Object|null>} 账号信息
   */
  async getAccountByUserid(userid) {
    try {
      const result = await database.query(
        'SELECT * FROM kiro_accounts WHERE userid = $1',
        [userid]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('根据userid查询Kiro账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 创建或更新Kiro账号（根据userid判断）
   * @param {Object} accountData - 账号数据
   * @param {string} accountData.user_id - 用户ID
   * @param {string} accountData.account_name - 账号名称
   * @param {string} accountData.auth_method - 认证方式 (Social/IdC)
   * @param {string} accountData.refresh_token - 刷新令牌
   * @param {string} accountData.access_token - 访问令牌
   * @param {number} accountData.expires_at - 过期时间戳（毫秒）
   * @param {string} accountData.client_id - IdC的client_id
   * @param {string} accountData.client_secret - IdC的client_secret
   * @param {string} accountData.profile_arn - Social的profile_arn
   * @param {string} accountData.machineid - 机器ID（必填）
   * @param {number} accountData.is_shared - 是否共享（必填，0=专属, 1=共享）
   * @param {string} accountData.email - 账号邮箱（可选）
   * @param {string} accountData.userid - 用户ID标识（必填）
   * @param {string} accountData.subscription - 订阅类型（必填）
   * @param {number} accountData.current_usage - 当前使用量（必填）
   * @param {string} accountData.reset_date - 重置日期（必填）
   * @param {number} accountData.usage_limit - 使用限额（必填）
   * @param {boolean} accountData.free_trial_status - 免费试用状态（可选）
   * @param {number} accountData.free_trial_usage - 免费试用使用量（可选）
   * @param {string} accountData.free_trial_expiry - 免费试用过期时间（可选）
   * @param {number} accountData.free_trial_limit - 免费试用限额（可选）
   * @param {number} accountData.bonus_usage - Bonus使用量（可选）
   * @param {number} accountData.bonus_limit - Bonus限额（可选）
   * @param {number} accountData.bonus_available - Bonus可用额度（可选）
   * @param {Array} accountData.bonus_details - Bonus详情（可选）
   * @returns {Promise<Object>} 创建的账号信息
   */
  async createAccount(accountData) {
    const {
      user_id,
      account_name,
      auth_method,
      refresh_token,
      access_token = null,
      expires_at = null,
      client_id = null,
      client_secret = null,
      profile_arn = null,
      machineid,
      is_shared,
      email = null,
      userid,
      subscription,
      current_usage,
      reset_date,
      usage_limit,
      free_trial_status = false,
      free_trial_usage = null,
      free_trial_expiry = null,
      free_trial_limit = 0,
      bonus_usage = 0,
      bonus_limit = 0,
      bonus_available = 0,
      bonus_details = []
    } = accountData;

    // 验证必需字段
    if (!user_id || !auth_method || !refresh_token) {
      throw new Error('缺少必需字段: user_id, auth_method, refresh_token');
    }

    // 验证machineid和is_shared（这两个必须由用户提供）
    if (!machineid || is_shared === undefined) {
      throw new Error('缺少必需字段: machineid, is_shared');
    }

    // 验证is_shared值
    if (is_shared !== 0 && is_shared !== 1) {
      throw new Error('is_shared必须是0或1');
    }

    // 验证auth_method
    if (!['Social', 'IdC'].includes(auth_method)) {
      throw new Error('auth_method必须是Social或IdC');
    }

    // 验证IdC必需字段
    if (auth_method === 'IdC' && (!client_id || !client_secret)) {
      throw new Error('IdC认证需要client_id和client_secret');
    }

    try {
      // 检查是否已存在相同的userid
      const existingAccount = await this.getAccountByUserid(userid);

      if (existingAccount) {
        // 存在则更新
        logger.info(`检测到已存在的userid=${userid}，更新账号: account_id=${existingAccount.account_id}`);
        
        const result = await database.query(
          `UPDATE kiro_accounts
           SET user_id = $1, account_name = $2, auth_method = $3, refresh_token = $4,
               access_token = $5, expires_at = $6, client_id = $7, client_secret = $8,
               profile_arn = $9, machineid = $10, is_shared = $11, email = $12,
               subscription = $13, current_usage = $14, reset_date = $15,
               usage_limit = $16, free_trial_status = $17, free_trial_usage = $18,
               free_trial_expiry = $19, free_trial_limit = $20, bonus_usage = $21,
               bonus_limit = $22, bonus_available = $23, bonus_details = $24,
               updated_at = CURRENT_TIMESTAMP
           WHERE userid = $25
           RETURNING *`,
          [user_id, account_name, auth_method, refresh_token, access_token, expires_at,
           client_id, client_secret, profile_arn, machineid, is_shared, email,
           subscription, current_usage, reset_date, usage_limit, free_trial_status,
           free_trial_usage, free_trial_expiry, free_trial_limit, bonus_usage, bonus_limit,
           bonus_available, JSON.stringify(bonus_details), userid]
        );

        logger.info(`Kiro账号更新成功: account_id=${result.rows[0].account_id}, userid=${userid}`);
        return result.rows[0];
      } else {
        // 不存在则创建
        const result = await database.query(
          `INSERT INTO kiro_accounts
           (user_id, account_name, auth_method, refresh_token, access_token, expires_at,
            client_id, client_secret, profile_arn, machineid, is_shared, email, userid,
            subscription, current_usage, reset_date, usage_limit, free_trial_status,
            free_trial_usage, free_trial_expiry, free_trial_limit, bonus_usage, bonus_limit,
            bonus_available, bonus_details, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, 1)
           RETURNING *`,
          [user_id, account_name, auth_method, refresh_token, access_token, expires_at,
           client_id, client_secret, profile_arn, machineid, is_shared, email, userid,
           subscription, current_usage, reset_date, usage_limit, free_trial_status,
           free_trial_usage, free_trial_expiry, free_trial_limit, bonus_usage, bonus_limit,
           bonus_available, JSON.stringify(bonus_details)]
        );

        logger.info(`登录成功: account_id=${result.rows[0].account_id}, user_id=${user_id}, userid=${userid}`);
        return result.rows[0];
      }
    } catch (error) {
      logger.error('Login error:', error.message);
      throw error;
    }
  }

  /**
   * 根据account_id获取账号
   * @param {string} account_id - 账号ID
   * @returns {Promise<Object|null>} 账号信息
   */
  async getAccountById(account_id) {
    try {
      const result = await database.query(
        'SELECT * FROM kiro_accounts WHERE account_id = $1',
        [account_id]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('查询Kiro账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 根据用户ID获取账号列表
   * @param {string} user_id - 用户ID
   * @returns {Promise<Array>} 账号列表
   */
  async getAccountsByUserId(user_id) {
    try {
      const result = await database.query(
        `SELECT * FROM kiro_accounts 
         WHERE user_id = $1 
         ORDER BY created_at DESC`,
        [user_id]
      );
      return result.rows;
    } catch (error) {
      logger.error('查询用户Kiro账号列表失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取可用的账号（用于轮询）
   * @param {string} user_id - 用户ID（可选）
   * @returns {Promise<Array>} 可用账号列表
   */
  async getAvailableAccounts(user_id = null) {
    try {
      let query = 'SELECT * FROM kiro_accounts WHERE status = 1 AND need_refresh = FALSE';
      const params = [];

      if (user_id) {
        query += ' AND user_id = $1';
        params.push(user_id);
      }

      query += ' ORDER BY created_at ASC';

      const result = await database.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('查询可用Kiro账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新账号token
   * @param {string} account_id - 账号ID
   * @param {string} access_token - 新的访问令牌
   * @param {number} expires_at - 新的过期时间戳
   * @param {string} profile_arn - profile_arn（可选）
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateAccountToken(account_id, access_token, expires_at, profile_arn = null) {
    try {
      const result = await database.query(
        `UPDATE kiro_accounts 
         SET access_token = $1, expires_at = $2, profile_arn = COALESCE($3, profile_arn), 
             updated_at = CURRENT_TIMESTAMP
         WHERE account_id = $4
         RETURNING *`,
        [access_token, expires_at, profile_arn, account_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`Kiro账号不存在: account_id=${account_id}`);
      }

      logger.info(`Kiro账号token已更新: account_id=${account_id}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新Kiro账号token失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新账号状态
   * @param {string} account_id - 账号ID
   * @param {number} status - 状态 (0=禁用, 1=启用)
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateAccountStatus(account_id, status) {
    try {
      const result = await database.query(
        `UPDATE kiro_accounts 
         SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE account_id = $2
         RETURNING *`,
        [status, account_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`Kiro账号不存在: account_id=${account_id}`);
      }

      logger.info(`Kiro账号状态已更新: account_id=${account_id}, status=${status}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新Kiro账号状态失败:', error.message);
      throw error;
    }
  }

  /**
   * 标记账号需要重新刷新token（禁用账号并设置need_refresh=true）
   * @param {string} account_id - 账号ID
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async markAccountNeedRefresh(account_id) {
    try {
      const result = await database.query(
        `UPDATE kiro_accounts
         SET status = 0, need_refresh = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE account_id = $1
         RETURNING *`,
        [account_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`Kiro账号不存在: account_id=${account_id}`);
      }

      logger.warn(`Kiro账号已标记需要刷新: account_id=${account_id}`);
      return result.rows[0];
    } catch (error) {
      logger.error('标记Kiro账号需要刷新失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新账号名称
   * @param {string} account_id - 账号ID
   * @param {string} account_name - 新的账号名称
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateAccountName(account_id, account_name) {
    try {
      const result = await database.query(
        `UPDATE kiro_accounts 
         SET account_name = $1, updated_at = CURRENT_TIMESTAMP
         WHERE account_id = $2
         RETURNING *`,
        [account_name, account_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`Kiro账号不存在: account_id=${account_id}`);
      }

      logger.info(`Kiro账号名称已更新: account_id=${account_id}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新Kiro账号名称失败:', error.message);
      throw error;
    }
  }

  /**
   * 删除账号（先登出再删除数据库记录）
   * @param {string} account_id - 账号ID
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteAccount(account_id) {
    try {
      // 先获取账号信息以获得machineid
      const account = await this.getAccountById(account_id);
      if (!account) {
        logger.warn(`Kiro账号不存在，无法删除: account_id=${account_id}`);
        return false;
      }

      // 调用Kiro logout API
      if (account.machineid && account.refresh_token) {
        const kiroService = (await import('./kiro.service.js')).default;
        await kiroService.logout(account.refresh_token, account.machineid);
      }

      // 删除数据库记录
      const result = await database.query(
        'DELETE FROM kiro_accounts WHERE account_id = $1',
        [account_id]
      );

      const deleted = result.rowCount > 0;
      if (deleted) {
        logger.info(`Kiro账号已删除: account_id=${account_id}`);
      }
      return deleted;
    } catch (error) {
      logger.error('删除Kiro账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新账号使用量信息
   * @param {string} account_id - 账号ID
   * @param {Object} usageData - 使用量数据
   * @returns {Promise<Object>} 更新后的账号信息
   */
  async updateAccountUsage(account_id, usageData) {
    try {
      const {
        email,
        userid,
        subscription,
        current_usage,
        reset_date,
        usage_limit,
        free_trial_status,
        free_trial_usage,
        free_trial_expiry,
        free_trial_limit,
        bonus_usage,
        bonus_limit,
        bonus_available,
        bonus_details
      } = usageData;

      const result = await database.query(
        `UPDATE kiro_accounts
         SET email = COALESCE($1, email),
             userid = COALESCE($2, userid),
             subscription = COALESCE($3, subscription),
             current_usage = COALESCE($4, current_usage),
             reset_date = COALESCE($5, reset_date),
             usage_limit = COALESCE($6, usage_limit),
             free_trial_status = COALESCE($7, free_trial_status),
             free_trial_usage = COALESCE($8, free_trial_usage),
             free_trial_expiry = COALESCE($9, free_trial_expiry),
             free_trial_limit = COALESCE($10, free_trial_limit),
             bonus_usage = COALESCE($11, bonus_usage),
             bonus_limit = COALESCE($12, bonus_limit),
             bonus_available = COALESCE($13, bonus_available),
             bonus_details = COALESCE($14, bonus_details),
             updated_at = CURRENT_TIMESTAMP
         WHERE account_id = $15
         RETURNING *`,
        [email, userid, subscription, current_usage, reset_date,
         usage_limit, free_trial_status, free_trial_usage, free_trial_expiry,
         free_trial_limit, bonus_usage, bonus_limit, bonus_available,
         bonus_details ? JSON.stringify(bonus_details) : null, account_id]
      );

      if (result.rows.length === 0) {
        throw new Error(`Kiro账号不存在: account_id=${account_id}`);
      }

      logger.info(`Kiro账号使用量信息已更新: account_id=${account_id}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新Kiro账号使用量信息失败:', error.message);
      throw error;
    }
  }

  /**
   * 计算账号可用额度（免费试用额度 + bonus额度 + 基础额度）
   * @param {Object} account - 账号对象
   * @returns {Object} 可用额度信息
   */
  calculateAvailableBalance(account) {
    const {
      subscription,
      current_usage,
      usage_limit,
      free_trial_status,
      free_trial_usage,
      free_trial_expiry,
      free_trial_limit,
      bonus_usage,
      bonus_limit,
      bonus_available,
      bonus_details,
      reset_date
    } = account;

    // 计算基础账户可用额度
    const base_limit = usage_limit || 0;
    const base_used = current_usage || 0;
    const base_available = Math.max(0, base_limit - base_used);

    // 计算免费试用可用额度（如果有且未过期）
    // free_trial_status 是布尔值
    let free_trial_available = 0;
    let is_trial_active = false;
    
    if (free_trial_status && free_trial_expiry) {
      const now = new Date();
      const expiry = new Date(free_trial_expiry);
      if (now < expiry) {
        is_trial_active = true;
        const trial_limit = free_trial_limit || 0;
        const trial_used = free_trial_usage || 0;
        free_trial_available = Math.max(0, trial_limit - trial_used);
      }
    }

    // bonus可用额度（已经在API返回时计算好了）
    const bonusAvailable = bonus_available || 0;

    // 总可用额度 = 免费试用额度 + bonus额度 + 基础额度
    const available = free_trial_available + bonusAvailable + base_available;
    const total_limit = (is_trial_active ? (free_trial_limit || 0) : 0) + (bonus_limit || 0) + (usage_limit || 0);

    return {
      available,
      total_limit,
      current_usage: current_usage || 0,
      base_available,
      // 免费试用信息
      free_trial_status: is_trial_active, // 是否激活（布尔值）
      free_trial_usage: free_trial_usage || 0,
      free_trial_limit: free_trial_limit || 0,
      free_trial_available,
      free_trial_expiry: free_trial_expiry || null,
      // bonus信息
      bonus_usage: bonus_usage || 0,
      bonus_limit: bonus_limit || 0,
      bonus_available: bonusAvailable,
      bonus_details: bonus_details || [],
      subscription,
      reset_date
    };
  }

  /**
   * 检查账号token是否过期
   * @param {Object} account - 账号对象
   * @returns {boolean} 是否过期
   */
  isTokenExpired(account) {
    if (!account.expires_at) return true;
    // 提前5分钟认为过期
    return Date.now() >= account.expires_at - 300000;
  }
}

const kiroAccountService = new KiroAccountService();
export default kiroAccountService;
