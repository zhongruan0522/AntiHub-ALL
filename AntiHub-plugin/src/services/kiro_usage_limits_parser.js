export function parseKiroUsageLimits(data) {
  const toNumber = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  };

  const pickNumber = (...values) => {
    for (const value of values) {
      const parsed = toNumber(value);
      if (parsed !== null) return parsed;
    }
    return 0;
  };

  const userInfo = data?.userInfo || data?.user_info || {};
  const subscriptionInfo = data?.subscriptionInfo || data?.subscription_info || {};

  const resetSeconds = toNumber(data?.nextDateReset ?? data?.next_date_reset);

  const result = {
    email: userInfo?.email || null,
    userid: userInfo?.userId || userInfo?.user_id || null,
    subscription: subscriptionInfo?.subscriptionTitle || subscriptionInfo?.subscription_title || 'unknown',
    subscription_type: subscriptionInfo?.type || subscriptionInfo?.subscription_type || null,
    reset_date: resetSeconds ? new Date(resetSeconds * 1000).toISOString() : null,
    current_usage: 0,
    usage_limit: 0,
    // 免费试用相关字段
    free_trial_status: false, // 是否激活（布尔值）
    free_trial_usage: null,
    free_trial_expiry: null,
    free_trial_limit: 0,
    // bonus相关字段（只包含bonuses数组中的bonus，不包含免费试用）
    bonus_usage: 0,
    bonus_limit: 0,
    bonus_available: 0,
    bonus_details: []
  };

  const breakdownList = Array.isArray(data?.usageBreakdownList)
    ? data.usageBreakdownList
    : Array.isArray(data?.usage_breakdown_list)
      ? data.usage_breakdown_list
      : [];

  const getResourceType = (breakdown) => {
    const resourceType = breakdown?.resourceType ?? breakdown?.resource_type;
    if (typeof resourceType !== 'string') return null;
    const normalized = resourceType.trim().toUpperCase();
    return normalized || null;
  };

  const getCurrentUsage = (breakdown) => pickNumber(
    breakdown?.currentUsageWithPrecision,
    breakdown?.current_usage_with_precision,
    breakdown?.currentUsage,
    breakdown?.current_usage
  );

  const getUsageLimit = (breakdown) => pickNumber(
    breakdown?.usageLimitWithPrecision,
    breakdown?.usage_limit_with_precision,
    breakdown?.usageLimit,
    breakdown?.usage_limit
  );

  const pickPrimaryBreakdown = () => {
    if (!breakdownList.length) return null;

    const creditBreakdown = breakdownList.find(b => getResourceType(b) === 'CREDIT');
    if (creditBreakdown) return creditBreakdown;

    const findFirst = (predicate) => {
      for (const breakdown of breakdownList) {
        try {
          if (predicate(breakdown)) return breakdown;
        } catch {
          // ignore
        }
      }
      return null;
    };

    // 兼容某些 region / 版本：可能不返回 resourceType，或返回不同的 resourceType。
    // 根据参考项目的做法（kiro.rs 取第一个 breakdown），这里做更稳妥的优先级：
    // 1) 有 currency 的（通常代表额度类目）
    // 2) 有 freeTrialInfo / bonuses 的（也通常只出现在额度类目）
    // 3) 兜底取第一个 breakdown（与 kiro.rs 对齐）
    const currencyBreakdown = findFirst((b) => typeof b?.currency === 'string' && b.currency.trim());
    if (currencyBreakdown) return currencyBreakdown;

    const trialOrBonusBreakdown = findFirst((b) => {
      if (b?.freeTrialInfo || b?.free_trial_info) return true;
      if (Array.isArray(b?.bonuses) && b.bonuses.length > 0) return true;
      return false;
    });
    if (trialOrBonusBreakdown) return trialOrBonusBreakdown;

    return breakdownList[0];
  };

  const breakdown = pickPrimaryBreakdown();
  if (!breakdown) return result;

  result.current_usage = getCurrentUsage(breakdown);
  result.usage_limit = getUsageLimit(breakdown);

  // 处理免费试用信息（无论状态如何都返回数据）
  const freeTrialInfo = breakdown?.freeTrialInfo || breakdown?.free_trial_info;
  if (freeTrialInfo) {
    const freeTrialStatus = freeTrialInfo.freeTrialStatus ?? freeTrialInfo.free_trial_status;
    result.free_trial_status = freeTrialStatus === 'ACTIVE';
    result.free_trial_usage = pickNumber(
      freeTrialInfo.currentUsageWithPrecision,
      freeTrialInfo.current_usage_with_precision,
      freeTrialInfo.currentUsage,
      freeTrialInfo.current_usage
    );
    result.free_trial_limit = pickNumber(
      freeTrialInfo.usageLimitWithPrecision,
      freeTrialInfo.usage_limit_with_precision,
      freeTrialInfo.usageLimit,
      freeTrialInfo.usage_limit
    );
    const freeTrialExpirySeconds = toNumber(
      freeTrialInfo.freeTrialExpiry ?? freeTrialInfo.free_trial_expiry
    );
    if (freeTrialExpirySeconds) {
      // freeTrialExpiry是Unix时间戳（秒，可能带小数），需要乘以1000转为毫秒
      result.free_trial_expiry = new Date(freeTrialExpirySeconds * 1000).toISOString();
    }
  }

  let totalBonusUsage = 0;
  let totalBonusLimit = 0;
  const bonusDetails = [];

  // 处理bonuses数组（不包含免费试用，免费试用是单独的freeTrialInfo）
  if (Array.isArray(breakdown?.bonuses)) {
    for (const bonus of breakdown.bonuses) {
      if (bonus?.status === 'ACTIVE') {
        const bonusUsage = pickNumber(bonus?.currentUsage, bonus?.current_usage);
        const bonusLimit = pickNumber(bonus?.usageLimit, bonus?.usage_limit);

        totalBonusUsage += bonusUsage;
        totalBonusLimit += bonusLimit;

        bonusDetails.push({
          type: 'bonus',
          name: bonus.displayName || bonus.bonusCode,
          code: bonus.bonusCode,
          description: bonus.description,
          usage: bonusUsage,
          limit: bonusLimit,
          available: Math.max(0, bonusLimit - bonusUsage),
          status: bonus.status,
          expires_at: bonus.expiresAt ? new Date(bonus.expiresAt * 1000).toISOString() : null,
          redeemed_at: bonus.redeemedAt ? new Date(bonus.redeemedAt * 1000).toISOString() : null
        });
      }
    }
  }

  result.bonus_usage = totalBonusUsage;
  result.bonus_limit = totalBonusLimit;
  result.bonus_available = Math.max(0, totalBonusLimit - totalBonusUsage);
  result.bonus_details = bonusDetails;

  return result;
}

export default parseKiroUsageLimits;
