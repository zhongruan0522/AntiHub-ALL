# Kiro Account Selection and Error Handling Improvements

## 概述

本 PR 改进了 Kiro 账号的选择逻辑和错误处理机制，提高了请求成功率和系统稳定性。

## 主要改进

### 1. 智能账号选择
- **额度检查**：自动检查账号的可用额度（付费 + 试用）
- **试用过期检查**：只在试用未过期时才计入试用额度
- **自动跳过**：跳过额度为 0 的账号，避免无效请求

### 2. 增强的错误处理
- **429 (Too Many Requests)**：自动切换到下一个账号
- **503 (Service Unavailable)**：自动切换到下一个账号
- **502 (Bad Gateway)**：自动切换到下一个账号
- **重试次数**：从 3 次增加到 10 次，充分利用所有可用账号

### 3. API 改进
- **expires_at 字段**：在余额 API 响应中添加 token 过期时间

## 技术细节

### 账号选择逻辑
```python
# 计算付费可用额度
paid_available = (usage_limit - current_usage) + (bonus_limit - bonus_usage)

# 计算试用可用额度（仅当未过期时）
if free_trial_status and free_trial_expiry > now:
    free_available = free_trial_limit - free_trial_usage
else:
    free_available = 0

# 只返回有可用额度的账号
if paid_available + free_available > 0:
    return account
```

### 错误处理流程
```
请求 → 选择有额度的账号 → 发送请求
         ↓ 429/503/502
      排除该账号 → 选择下一个账号 → 重试
         ↓ 重复最多10次
      所有账号都失败 → 返回错误
```

## 效果

- ✅ 提高请求成功率
- ✅ 自动负载均衡
- ✅ 减少用户感知的错误
- ✅ 充分利用所有可用账号
- ✅ 避免额度用完的账号被选中

## 测试建议

1. 测试多个账号的轮询
2. 测试额度用完后的自动跳过
3. 测试 429 错误的自动切换
4. 测试试用过期后的额度计算

## 兼容性

- ✅ 向后兼容
- ✅ 不影响现有功能
- ✅ 仅优化内部逻辑
