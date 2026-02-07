import assert from 'node:assert/strict';

import parseKiroUsageLimits from '../src/services/kiro_usage_limits_parser.js';

// Case 1: Prefer CREDIT resourceType when present.
{
  const data = {
    userInfo: { email: 'a@example.com', userId: 'u1' },
    subscriptionInfo: { subscriptionTitle: 'KIRO PRO+', type: 'PRO' },
    nextDateReset: 1730000000.5,
    usageBreakdownList: [
      {
        resourceType: 'MONTHLY_REQUEST_COUNT',
        currentUsageWithPrecision: 1,
        usageLimitWithPrecision: 999
      },
      {
        resourceType: 'CREDIT',
        currentUsageWithPrecision: 2.5,
        usageLimitWithPrecision: 20.0,
        freeTrialInfo: {
          freeTrialStatus: 'ACTIVE',
          currentUsageWithPrecision: 1,
          usageLimitWithPrecision: 5,
          freeTrialExpiry: 1730000010
        },
        bonuses: [
          {
            status: 'ACTIVE',
            currentUsage: 0.5,
            usageLimit: 1.5,
            bonusCode: 'B1',
            displayName: 'Bonus 1',
            expiresAt: 1730000020
          }
        ]
      }
    ]
  };

  const result = parseKiroUsageLimits(data);

  assert.equal(result.email, 'a@example.com');
  assert.equal(result.userid, 'u1');
  assert.equal(result.subscription, 'KIRO PRO+');
  assert.equal(result.subscription_type, 'PRO');
  assert.equal(result.current_usage, 2.5);
  assert.equal(result.usage_limit, 20.0);

  assert.equal(result.free_trial_status, true);
  assert.equal(result.free_trial_usage, 1);
  assert.equal(result.free_trial_limit, 5);
  assert.ok(typeof result.free_trial_expiry === 'string' && result.free_trial_expiry.includes('T'));

  assert.equal(result.bonus_usage, 0.5);
  assert.equal(result.bonus_limit, 1.5);
  assert.equal(result.bonus_available, 1.0);
  assert.equal(result.bonus_details.length, 1);
}

// Case 2: No resourceType -> pick breakdown with max usageLimit.
{
  const data = {
    usageBreakdownList: [
      { currentUsageWithPrecision: 0, usageLimitWithPrecision: 0 },
      {
        currentUsageWithPrecision: 3,
        usageLimitWithPrecision: 30,
        freeTrialInfo: {
          freeTrialStatus: 'EXPIRED',
          currentUsageWithPrecision: 0,
          usageLimitWithPrecision: 10,
          freeTrialExpiry: 1730000010
        }
      }
    ]
  };

  const result = parseKiroUsageLimits(data);
  assert.equal(result.current_usage, 3);
  assert.equal(result.usage_limit, 30);
  assert.equal(result.free_trial_status, false);
  assert.equal(result.free_trial_limit, 10);
}

// Case 3: snake_case payload (future/backward compatibility).
{
  const data = {
    user_info: { email: 'b@example.com', user_id: 'u2' },
    subscription_info: { subscription_title: 'KIRO FREE', subscription_type: 'FREE' },
    next_date_reset: '1730000000',
    usage_breakdown_list: [
      {
        current_usage: 4,
        usage_limit: 40,
        free_trial_info: {
          free_trial_status: 'ACTIVE',
          current_usage: 1,
          usage_limit: 2,
          free_trial_expiry: '1730000010'
        },
        bonuses: [
          { status: 'ACTIVE', current_usage: '1', usage_limit: '2', bonus_code: 'B2' }
        ]
      }
    ]
  };

  const result = parseKiroUsageLimits(data);
  assert.equal(result.email, 'b@example.com');
  assert.equal(result.userid, 'u2');
  assert.equal(result.subscription, 'KIRO FREE');
  assert.equal(result.subscription_type, 'FREE');
  assert.equal(result.current_usage, 4);
  assert.equal(result.usage_limit, 40);
  assert.equal(result.free_trial_status, true);
  assert.equal(result.free_trial_usage, 1);
  assert.equal(result.free_trial_limit, 2);
  assert.equal(result.bonus_usage, 1);
  assert.equal(result.bonus_limit, 2);
  assert.equal(result.bonus_available, 1);
}

// Case 4: No resourceType -> prefer currency breakdown (avoid picking request-count style limits).
{
  const data = {
    usageBreakdownList: [
      {
        displayName: 'Requests',
        unit: 'count',
        currentUsageWithPrecision: 1,
        usageLimitWithPrecision: 999
      },
      {
        displayName: 'Credits',
        currency: 'USD',
        currentUsageWithPrecision: 2,
        usageLimitWithPrecision: 20
      }
    ]
  };

  const result = parseKiroUsageLimits(data);
  assert.equal(result.current_usage, 2);
  assert.equal(result.usage_limit, 20);
}

console.log('PASS kiro_usage_limits_parser.test.js');
