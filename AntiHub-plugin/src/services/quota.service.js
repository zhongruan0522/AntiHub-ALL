import database from '../db/database.js';
import logger from '../utils/logger.js';

class QuotaService {
  /**
   * 定义配额共享组
   * 同一组内的模型共享配额池
   */
  getQuotaSharedGroups() {
    return {
      // Gemini 3 pro 系列共享配额
      'gemini-3-pro': ['gemini-3-pro-low', 'gemini-3-pro-high'],
      
      // Claude 系列共享配额
      'claude': [
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-thinking',
        'claude-opus-4-5-thinking',
        'claude-opus-4-6-thinking',
      ],
      
      // Gemini 2.5 pro 系列共享配额
      'gemini-2.5-pro': ['gemini-2.5-pro', 'gemini-2.5-pro-thinking'],
      
      // Claude 和 GPT-OSS 共享配额（antigravity）
      // 注意：这些模型在 antigravity 平台上共享同一个配额池
      'claude-gpt-oss': [
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-thinking',
        'claude-opus-4-5-thinking',
        'claude-opus-4-6-thinking',
        'gpt-oss-120b-medium'
      ],
    };
  }

  /**
   * 获取模型所属的配额共享组（返回该组的所有模型）
   * @param {string} model_name - 模型名称
   * @returns {Array<string>} 共享组中的所有模型名称（包括自己）
   */
  getQuotaSharedModels(model_name) {
    const sharedGroups = this.getQuotaSharedGroups();
    
    // 查找该模型属于哪个共享组
    for (const [groupName, models] of Object.entries(sharedGroups)) {
      if (models.includes(model_name)) {
        return models;
      }
    }
    
    // 如果不在任何共享组中，返回自己
    return [model_name];
  }

  /**
   * 获取模型的配额基础名称（用于配额共享）
   * @param {string} model_name - 模型名称
   * @returns {string} 配额基础名称
   */
  getQuotaBaseName(model_name) {
    const sharedGroups = this.getQuotaSharedGroups();
    
    // 查找该模型属于哪个共享组
    for (const [groupName, models] of Object.entries(sharedGroups)) {
      if (models.includes(model_name)) {
        return groupName;
      }
    }
    
    // 如果不在任何共享组中，返回自己
    return model_name;
  }
  /**
   * 更新或创建模型配额
   * @param {string} cookie_id - Cookie ID
   * @param {string} model_name - 模型名称
   * @param {Object} quotaInfo - 配额信息
   * @param {number} quotaInfo.remainingFraction - 剩余配额比例
   * @param {string} quotaInfo.resetTime - 重置时间（ISO 8601格式）
   * @returns {Promise<Object>} 配额信息
   */
  async upsertQuota(cookie_id, model_name, quotaInfo) {
    const { remainingFraction, resetTime } = quotaInfo;
    const quota = remainingFraction !== undefined ? remainingFraction : 1.0;
    const status = quota > 0 ? 1 : 0;
    const reset_time = resetTime ? new Date(resetTime) : null;

    try {
      const result = await database.query(
        `INSERT INTO model_quotas (cookie_id, model_name, reset_time, quota, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cookie_id, model_name)
         DO UPDATE SET
           reset_time = EXCLUDED.reset_time,
           quota = EXCLUDED.quota,
           status = CASE
             WHEN model_quotas.status = 0 AND EXCLUDED.quota > 0 THEN 0
             WHEN EXCLUDED.quota > 0 THEN 1
             ELSE 0
           END,
           last_fetched_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [cookie_id, model_name, reset_time, quota, status]
      );
      return result.rows[0];
    } catch (error) {
      logger.error('更新配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 批量更新模型配额（从availableModels响应）
   * @param {string} cookie_id - Cookie ID
   * @param {Object} modelsData - 模型数据对象
   * @returns {Promise<Array>} 更新的配额列表
   */
  async updateQuotasFromModels(cookie_id, modelsData) {
    const results = [];
    
    try {
      for (const [modelName, modelInfo] of Object.entries(modelsData)) {
        if (modelInfo.quotaInfo) {
          const quota = await this.upsertQuota(cookie_id, modelName, modelInfo.quotaInfo);
          results.push(quota);
        }
      }

      logger.info(`批量更新配额成功: cookie_id=${cookie_id}, 更新了${results.length}个模型`);
      return results;
    } catch (error) {
      logger.error('批量更新配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取指定cookie和模型的配额
   * @param {string} cookie_id - Cookie ID
   * @param {string} model_name - 模型名称
   * @returns {Promise<Object|null>} 配额信息
   */
  async getQuota(cookie_id, model_name) {
    try {
      const result = await database.query(
        'SELECT * FROM model_quotas WHERE cookie_id = $1 AND model_name = $2',
        [cookie_id, model_name]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('查询配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取指定cookie的所有配额
   * @param {string} cookie_id - Cookie ID
   * @returns {Promise<Array>} 配额列表
   */
  async getQuotasByCookieId(cookie_id) {
    try {
      const result = await database.query(
        'SELECT * FROM model_quotas WHERE cookie_id = $1 ORDER BY quota ASC',
        [cookie_id]
      );
      return result.rows;
    } catch (error) {
      logger.error('查询cookie配额列表失败:', error.message);
      throw error;
    }
  }

  /**
   * 检查模型是否可用
   * @param {string} cookie_id - Cookie ID
   * @param {string} model_name - 模型名称
   * @returns {Promise<boolean>} 是否可用
   */
  async isModelAvailable(cookie_id, model_name) {
    try {
      const quota = await this.getQuota(cookie_id, model_name);
      
      // 如果没有配额记录，默认可用
      if (!quota) {
        return true;
      }

      // 检查状态和配额
      return quota.status === 1 && quota.quota > 0;
    } catch (error) {
      logger.error('检查模型可用性失败:', error.message);
      // 出错时默认可用，避免阻塞服务
      return true;
    }
  }

  /**
   * 更新指定cookie的指定模型的状态
   * @param {string} cookie_id - Cookie ID
   * @param {string} model_name - 模型名称
   * @param {number} status - 状态 (0=禁用, 1=启用)
   * @returns {Promise<Object>} 更新后的配额信息
   */
  async updateModelQuotaStatus(cookie_id, model_name, status) {
    try {
      const result = await database.query(
        `UPDATE model_quotas
         SET status = $1
         WHERE cookie_id = $2 AND model_name = $3
         RETURNING *`,
        [status, cookie_id, model_name]
      );

      if (result.rows.length === 0) {
        throw new Error(`配额记录不存在: cookie_id=${cookie_id}, model=${model_name}`);
      }

      logger.info(`模型配额状态已更新: cookie_id=${cookie_id}, model=${model_name}, status=${status}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新模型配额状态失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取可用的cookie列表（针对特定模型）
   * @param {string} model_name - 模型名称
   * @param {string} user_uuid - 用户UUID（可选）
   * @returns {Promise<Array>} 可用的cookie列表
   */
  async getAvailableCookiesForModel(model_name, user_uuid = null) {
    try {
      let query = `
        SELECT a.*, mq.quota, mq.reset_time
        FROM accounts a
        LEFT JOIN model_quotas mq ON a.cookie_id = mq.cookie_id AND mq.model_name = $1
        WHERE a.status = 1 
          AND (mq.status IS NULL OR mq.status = 1)
          AND (mq.quota IS NULL OR mq.quota > 0)
      `;
      const params = [model_name];

      if (user_uuid) {
        query += ' AND a.user_uuid = $2';
        params.push(user_uuid);
      }

      query += ' ORDER BY mq.quota DESC NULLS FIRST, a.created_at ASC';

      const result = await database.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('查询可用cookie失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取配额即将耗尽的模型列表
   * @param {number} threshold - 阈值（默认0.1，即10%）
   * @returns {Promise<Array>} 配额低的模型列表
   */
  async getLowQuotaModels(threshold = 0.1) {
    try {
      const result = await database.query(
        `SELECT mq.*, a.user_uuid, a.is_shared
         FROM model_quotas mq
         JOIN accounts a ON mq.cookie_id = a.cookie_id
         WHERE mq.quota < $1 AND mq.quota > 0 AND mq.status = 1
         ORDER BY mq.quota ASC`,
        [threshold]
      );
      return result.rows;
    } catch (error) {
      logger.error('查询低配额模型失败:', error.message);
      throw error;
    }
  }

  /**
   * 删除指定cookie的所有配额记录
   * @param {string} cookie_id - Cookie ID
   * @returns {Promise<number>} 删除的记录数
   */
  async deleteQuotasByCookieId(cookie_id) {
    try {
      const result = await database.query(
        'DELETE FROM model_quotas WHERE cookie_id = $1',
        [cookie_id]
      );
      logger.info(`删除配额记录成功: cookie_id=${cookie_id}, 删除了${result.rowCount}条记录`);
      return result.rowCount;
    } catch (error) {
      logger.error('删除配额记录失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新用户共享配额池上限（当用户添加/删除共享cookie时调用）
   * 注意：此方法只更新 max_quota，不更新 quota
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @returns {Promise<Object>} 更新后的配额池信息
   */
  async updateUserSharedQuotaMax(user_id, model_name) {
    try {
      await database.query(
        'SELECT update_user_shared_quota_max($1, $2)',
        [user_id, model_name]
      );
      
      const result = await database.query(
        'SELECT * FROM user_shared_quota_pool WHERE user_id = $1 AND model_name = $2',
        [user_id, model_name]
      );
      
      logger.info(`用户共享配额池上限已更新: user_id=${user_id}, model=${model_name}`);
      return result.rows[0];
    } catch (error) {
      logger.error('更新用户共享配额池上限失败:', error.message);
      throw error;
    }
  }

  /**
   * 增加用户共享配额池的配额（添加共享账号时调用）
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @param {number} account_quota - 账号的模型配额（0-1之间的小数）
   * @returns {Promise<Object>} 更新后的配额池信息
   */
  async addUserSharedQuota(user_id, model_name, account_quota) {
    try {
      // 增加的配额 = 账号配额 * 2
      const quota_to_add = parseFloat((account_quota * 2).toFixed(4));
      // 新的 max_quota 增量
      const max_quota_increment = 2;
      
      // 使用 UPSERT 来处理插入或更新
      const result = await database.query(
        `INSERT INTO user_shared_quota_pool (user_id, model_name, quota, max_quota)
         VALUES ($1::uuid, $2, LEAST($3::numeric, $4::numeric), $4::numeric)
         ON CONFLICT (user_id, model_name)
         DO UPDATE SET
           quota = LEAST(user_shared_quota_pool.quota + $3::numeric, user_shared_quota_pool.max_quota + $4::numeric),
           max_quota = user_shared_quota_pool.max_quota + $4::numeric,
           last_updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [user_id, model_name, quota_to_add, max_quota_increment]
      );
      
      logger.info(`用户共享配额已增加: user_id=${user_id}, model=${model_name}, added_quota=${quota_to_add}, quota=${result.rows[0].quota}, max_quota=${result.rows[0].max_quota}`);
      return result.rows[0];
    } catch (error) {
      logger.error('增加用户共享配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 减少用户共享配额池的配额（删除共享账号时调用）
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @param {number} account_quota - 账号的模型配额（0-1之间的小数）
   * @returns {Promise<Object|null>} 更新后的配额池信息
   */
  async removeUserSharedQuota(user_id, model_name, account_quota) {
    try {
      // 减少的配额 = 账号配额 * 2
      const quota_to_remove = parseFloat((account_quota * 2).toFixed(4));
      
      const result = await database.query(
        `UPDATE user_shared_quota_pool
         SET quota = GREATEST(quota - $3::numeric, 0),
             max_quota = GREATEST(max_quota - 2::numeric, 0),
             last_updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1::uuid AND model_name = $2
         RETURNING *`,
        [user_id, model_name, quota_to_remove]
      );
      
      if (result.rows.length > 0) {
        logger.info(`用户共享配额已减少: user_id=${user_id}, model=${model_name}, removed_quota=${quota_to_remove}, new_quota=${result.rows[0].quota}, new_max_quota=${result.rows[0].max_quota}`);
        return result.rows[0];
      }
      return null;
    } catch (error) {
      logger.error('减少用户共享配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取用户的共享配额池
   * @param {string} user_id - 用户ID
   * @returns {Promise<Array>} 用户共享配额池列表
   */
  async getUserSharedQuotaPool(user_id) {
    try {
      const result = await database.query(
        'SELECT * FROM user_shared_quota_pool WHERE user_id = $1 ORDER BY quota DESC',
        [user_id]
      );
      return result.rows;
    } catch (error) {
      logger.error('查询用户共享配额池失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取用户某个模型的共享配额池
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @returns {Promise<Object|null>} 配额池信息
   */
  async getUserModelSharedQuotaPool(user_id, model_name) {
    try {
      const result = await database.query(
        'SELECT * FROM user_shared_quota_pool WHERE user_id = $1 AND model_name = $2',
        [user_id, model_name]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('查询用户模型共享配额池失败:', error.message);
      throw error;
    }
  }

  /**
   * 扣减用户共享配额池
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @param {number} amount - 扣减数量
   * @returns {Promise<Object>} 更新后的配额池信息
   */
  async deductUserSharedQuota(user_id, model_name, amount) {
    try {
      const result = await database.query(
        `UPDATE user_shared_quota_pool
         SET quota = quota - $3,
             last_updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND model_name = $2
         RETURNING *`,
        [user_id, model_name, amount]
      );
      
      if (result.rows.length === 0) {
        logger.warn(`用户共享配额池不存在，跳过扣减: user_id=${user_id}, model=${model_name}`);
        return null;
      }
      
      logger.info(`用户共享配额已扣减: user_id=${user_id}, model=${model_name}, amount=${amount}`);
      return result.rows[0];
    } catch (error) {
      logger.error('扣减用户共享配额失败:', error.message);
      // 不抛出错误，以免影响主流程
      return null;
    }
  }

  /**
   * 恢复用户共享配额池（定时任务调用）
   * 每小时每模型恢复 = 0.012 * 免费账号数 + 0.4 * 付费账号数
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @returns {Promise<Object>} 更新后的配额池信息
   */
  async recoverUserSharedQuota(user_id, model_name) {
    try {
      // 获取用户有效的共享账号数量（分免费和付费）
      const countResult = await database.query(
        `SELECT
           COUNT(*) FILTER (WHERE paid_tier = false) as free_count,
           COUNT(*) FILTER (WHERE paid_tier = true) as paid_count
         FROM accounts
         WHERE user_id = $1::uuid
           AND is_shared = 1
           AND status = 1`,
        [user_id]
      );
      const freeCount = parseInt(countResult.rows[0].free_count) || 0;
      const paidCount = parseInt(countResult.rows[0].paid_count) || 0;
      
      // 计算恢复量：0.012 * 免费账号数 + 0.4 * 付费账号数
      const recoveryAmount = parseFloat((0.012 * freeCount + 0.4 * paidCount).toFixed(4));
      
      // 如果没有账号，不需要恢复
      if (recoveryAmount === 0) {
        logger.debug(`用户无有效共享账号，跳过恢复: user_id=${user_id}, model=${model_name}`);
        return null;
      }
      
      // 恢复配额（不超过上限）
      const result = await database.query(
        `UPDATE user_shared_quota_pool
         SET quota = LEAST(quota + $3::numeric, max_quota),
             last_recovered_at = CURRENT_TIMESTAMP,
             last_updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1::uuid AND model_name = $2
         RETURNING *`,
        [user_id, model_name, recoveryAmount]
      );
      
      if (result.rows.length > 0) {
        logger.info(`用户共享配额已恢复: user_id=${user_id}, model=${model_name}, amount=${recoveryAmount} (free=${freeCount}, paid=${paidCount})`);
      }
      
      return result.rows[0] || null;
    } catch (error) {
      logger.error('恢复用户共享配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 恢复所有用户的共享配额池（定时任务调用）
   * @returns {Promise<number>} 恢复的记录数
   */
  async recoverAllUserSharedQuotas() {
    try {
      // 获取所有需要恢复的配额池记录
      const poolsResult = await database.query(
        `SELECT DISTINCT user_id, model_name
         FROM user_shared_quota_pool
         WHERE quota < max_quota`
      );
      
      let recoveredCount = 0;
      for (const pool of poolsResult.rows) {
        await this.recoverUserSharedQuota(pool.user_id, pool.model_name);
        recoveredCount++;
      }
      
      logger.info(`批量恢复用户共享配额完成: 恢复了${recoveredCount}条记录`);
      return recoveredCount;
    } catch (error) {
      logger.error('批量恢复用户共享配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取用户的聚合配额（所有专属cookie的配额）
   * @param {string} user_id - 用户ID
   * @returns {Promise<Array>} 用户配额列表
   */
  async getUserQuotas(user_id) {
    try {
      return await this.getUserSharedQuotaPool(user_id);
    } catch (error) {
      logger.error('查询用户配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取共享池的聚合配额
   * @returns {Promise<Array>} 共享池配额列表
   */
  async getSharedPoolQuotas() {
    try {
      const result = await database.query(
        'SELECT * FROM shared_pool_quotas_view ORDER BY total_quota DESC'
      );
      return result.rows;
    } catch (error) {
      logger.error('查询共享池配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取配额已过期（reset_time 在当前时间之前）的共享账号列表
   * 这些账号的配额可能已经重置，需要重新获取最新数据
   * @returns {Promise<Array>} 需要刷新配额的账号列表（包含 cookie_id 和 access_token）
   */
  async getExpiredQuotaSharedAccounts() {
    try {
      const result = await database.query(
        `SELECT DISTINCT a.cookie_id, a.access_token, a.refresh_token, a.expires_at
         FROM accounts a
         JOIN model_quotas mq ON a.cookie_id = mq.cookie_id
         WHERE a.is_shared = 1
           AND a.status = 1
           AND a.need_refresh = FALSE
           AND mq.reset_time IS NOT NULL
           AND mq.reset_time < CURRENT_TIMESTAMP`
      );
      logger.info(`找到 ${result.rows.length} 个配额已过期的共享账号需要刷新`);
      return result.rows;
    } catch (error) {
      logger.error('查询过期配额账号失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取用户某个模型的配额
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @returns {Promise<Object|null>} 配额信息
   */
  async getUserModelQuota(user_id, model_name) {
    try {
      const result = await database.query(
        'SELECT * FROM user_quotas_view WHERE user_id = $1 AND model_name = $2',
        [user_id, model_name]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('查询用户模型配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取共享池某个模型的配额
   * @param {string} model_name - 模型名称
   * @returns {Promise<Object|null>} 配额信息
   */
  async getSharedPoolModelQuota(model_name) {
    try {
      const result = await database.query(
        'SELECT * FROM shared_pool_quotas_view WHERE model_name = $1',
        [model_name]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('查询共享池模型配额失败:', error.message);
      throw error;
    }
  }

  /**
   * 记录配额消耗
   * @param {string} user_id - 用户ID
   * @param {string} cookie_id - Cookie ID
   * @param {string} model_name - 模型名称
   * @param {number} quota_before - 消耗前的quota
   * @param {number} quota_after - 消耗后的quota
   * @param {number} is_shared - 是否使用共享cookie（1=共享，0=专属）
   * @returns {Promise<Object>} 消耗记录
   */
  async recordQuotaConsumption(user_id, cookie_id, model_name, quota_before, quota_after, is_shared = 1) {
    try {
      let quota_consumed = quota_before - quota_after;
      
      // 如果消耗为负数（配额在请求期间重置），记录为0
      if (quota_consumed < 0) {
        logger.info(`配额在请求期间重置，记录消耗为0: quota_before=${quota_before}, quota_after=${quota_after}`);
        quota_consumed = 0;
      }
      
      const result = await database.query(
        `INSERT INTO quota_consumption_log (user_id, cookie_id, model_name, quota_before, quota_after, quota_consumed, is_shared)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [user_id, cookie_id, model_name, quota_before, quota_after, quota_consumed, is_shared]
      );
      
      // 如果使用的是共享cookie，扣减用户共享配额池
      if (is_shared === 1 && quota_consumed > 0) {
        // 获取该模型所属的配额共享组
        const sharedModels = this.getQuotaSharedModels(model_name);
        
        // 同时扣减共享组中所有模型的用户配额
        for (const sharedModel of sharedModels) {
          await this.deductUserSharedQuota(user_id, sharedModel, quota_consumed);
          logger.info(`扣减共享配额: user_id=${user_id}, model=${sharedModel}, amount=${quota_consumed}`);
        }
        
        if (sharedModels.length > 1) {
          logger.info(`配额共享组: [${sharedModels.join(', ')}] - 已同时扣减${sharedModels.length}个模型的配额`);
        }
      }
      
      logger.info(`配额消耗已记录: user_id=${user_id}, model=${model_name}, consumed=${quota_consumed}, is_shared=${is_shared}`);
      return result.rows[0];
    } catch (error) {
      logger.error('记录配额消耗失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取用户的消耗记录
   * @param {string} user_id - 用户ID
   * @param {Object} options - 查询选项
   * @param {number} options.limit - 限制返回数量
   * @param {Date} options.start_date - 开始日期
   * @param {Date} options.end_date - 结束日期
   * @returns {Promise<Array>} 消耗记录列表
   */
  async getUserConsumption(user_id, options = {}) {
    try {
      let query = 'SELECT * FROM quota_consumption_log WHERE user_id = $1';
      const params = [user_id];
      let paramIndex = 2;

      if (options.start_date) {
        query += ` AND consumed_at >= $${paramIndex}`;
        params.push(options.start_date);
        paramIndex++;
      }

      if (options.end_date) {
        query += ` AND consumed_at <= $${paramIndex}`;
        params.push(options.end_date);
        paramIndex++;
      }

      query += ' ORDER BY consumed_at DESC';

      if (options.limit) {
        query += ` LIMIT $${paramIndex}`;
        params.push(options.limit);
      }

      const result = await database.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error('查询用户消耗记录失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取用户某个模型的消耗统计
   * @param {string} user_id - 用户ID
   * @param {string} model_name - 模型名称
   * @returns {Promise<Object>} 消耗统计
   */
  async getUserModelConsumptionStats(user_id, model_name) {
    try {
      const result = await database.query(
        `SELECT
           COUNT(*) as total_requests,
           SUM(quota_consumed) as total_quota_consumed,
           AVG(quota_consumed) as avg_quota_consumed,
           MAX(consumed_at) as last_used_at
         FROM quota_consumption_log
         WHERE user_id = $1 AND model_name = $2`,
        [user_id, model_name]
      );
      return result.rows[0];
    } catch (error) {
      logger.error('查询用户模型消耗统计失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取用户所有模型的共享配额消费统计
   * @param {string} user_id - 用户ID
   * @returns {Promise<Array>} 各模型的消费统计列表
   */
  async getUserSharedConsumptionStats(user_id) {
    try {
      const result = await database.query(
        `SELECT
           model_name,
           COUNT(*) as total_requests,
           SUM(quota_consumed) as total_quota_consumed,
           AVG(quota_consumed) as avg_quota_consumed,
           MAX(consumed_at) as last_used_at
         FROM quota_consumption_log
         WHERE user_id = $1::uuid AND is_shared = 1
         GROUP BY model_name
         ORDER BY total_quota_consumed DESC`,
        [user_id]
      );
      return result.rows;
    } catch (error) {
      logger.error('查询用户共享配额消费统计失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取用户所有配额消费总计（包括共享和专属账号）
   * @param {string} user_id - 用户ID
   * @returns {Promise<Object>} 消费总计
   */
  async getUserTotalConsumption(user_id) {
    try {
      const result = await database.query(
        `SELECT
           COUNT(*) as total_requests,
           COALESCE(SUM(quota_consumed), 0) as total_quota_consumed,
           COALESCE(SUM(CASE WHEN is_shared = 1 THEN quota_consumed ELSE 0 END), 0) as shared_quota_consumed,
           COALESCE(SUM(CASE WHEN is_shared = 0 THEN quota_consumed ELSE 0 END), 0) as private_quota_consumed
         FROM quota_consumption_log
         WHERE user_id = $1::uuid`,
        [user_id]
      );
      return result.rows[0];
    } catch (error) {
      logger.error('查询用户配额消费总计失败:', error.message);
      throw error;
    }
  }
}

const quotaService = new QuotaService();
export default quotaService;
