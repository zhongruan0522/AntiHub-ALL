# Kiro 企业账户导入与代理机制分析

> 参考项目：`2-参考项目/部署版kiro-account-manager-web-20260215`
> 分析日期：2026-02-21

---

## 一、项目架构概览

这是一个 Kiro 账号池管理 + API 代理系统，核心功能：
- 多账号池管理（导入、刷新、负载均衡）
- 兼容 OpenAI 格式的 API 代理（将请求转发到 Kiro/AWS 后端）
- 配额监控与自动切换

### 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| API 代理核心 | `dist/server/proxy/kiroApi.js` | 构建请求、端点管理、DNS 缓存 |
| Token 刷新 | `dist/server/services/tokenRefresh.js` | OIDC/Social Token 刷新 + 用量查询 |
| 凭证验证 | `dist/server/services/credentialService.js` | 凭证验证、SSO 导入、CBOR→REST 降级 |
| 账号池调度 | `dist/server/proxy/accountPool.js` | 智能负载均衡、零空档期保证 |
| 配额监控 | `dist/server/proxy/quotaMonitor.js` | 用量告警、趋势分析 |
| 自动刷新 | `dist/server/services/autoRefreshService.js` | 定时刷新 Token + 额度 |
| 账号路由 | `dist/server/routes/accounts.js` | REST API 接口 |
| OAuth 路由 | `dist/server/routes/oauth.js` | Builder ID / Social 登录流程 |

---

## 二、关键发现：区域分离策略

**"刷新配额用 eu-north-1，请求用 east"** — 代码中确认了这一设计：

### 2.1 Chat API 请求：固定 us-east-1

```
dist/server/proxy/kiroApi.js-9
```

```js
// Chat API 调用统一使用 us-east-1，账号的 region 只用于 token 刷新
const KIRO_API_REGION = 'us-east-1'; // Chat API 固定使用 us-east-1
```

API 端点硬编码为 `us-east-1`：

```
dist/server/proxy/kiroApi.js-232~243
```

```js
const KIRO_ENDPOINTS = [
    {
        url: `https://codewhisperer.${KIRO_API_REGION}.amazonaws.com/generateAssistantResponse`,
        name: 'CodeWhisperer'
    },
    {
        url: `https://q.${KIRO_API_REGION}.amazonaws.com/generateAssistantResponse`,
        name: 'AmazonQ'
    }
];
```

### 2.2 Token 刷新：使用账号自身的 region

```
dist/server/services/tokenRefresh.js-108~109
```

```js
async function refreshOidcToken(refreshToken, clientId, clientSecret, region = 'us-east-1') {
    const url = `https://oidc.${region}.amazonaws.com/token`;
```

如果账号的 region 是 `eu-north-1`，Token 刷新就会请求 `https://oidc.eu-north-1.amazonaws.com/token`，而 Chat API 始终走 `us-east-1`。

---

## 三、账号导入方式（三种）

### 3.1 方式一：OIDC 手动导入

前端提供表单，用户手动填写 `refreshToken`、`clientId`、`clientSecret`、`region`、`authMethod`、`provider`。

后端验证接口：

```
dist/server/routes/accounts.js-625~649
```

```js
// POST /api/accounts/verify-credentials - 验证凭证并获取账号信息
router.post('/verify-credentials', async (req, res) => {
    const { refreshToken, clientId, clientSecret, region, authMethod, provider } = req.body;
    const result = await verifyAccountCredentials({ ... });
```

前端 Provider 下拉选项包含 `Enterprise`：

```
dist/public/assets/AccountManager-C6QW6_8u.js（前端编译产物，minified）
```

```js
// Provider 选项
options: [
    { value: "BuilderId", label: "Builder ID" },
    { value: "Enterprise", label: "Enterprise" },
    { value: "Github", label: "GitHub" },
    { value: "Google", label: "Google" }
]
```

### 3.2 方式二：SSO Token 导入（设备授权流程）

用户从浏览器 Cookie 获取 `aws-afi-session` Bearer Token，系统自动完成 7 步设备授权：

```
dist/server/routes/accounts.js-649~665
```

```js
// POST /api/accounts/import-sso-token - 从 SSO Token 导入账号
router.post('/import-sso-token', async (req, res) => {
    const { bearerToken, region } = req.body;
    const result = await importFromSsoToken(bearerToken, region);
```

设备授权流程（7 步）：

```
dist/server/services/credentialService.js-305~420
```

1. 注册 OIDC 客户端 → `POST /client/register`
2. 发起设备授权 → `POST /device_authorization`
3. 验证 Bearer Token → `GET /token/whoAmI`
4. 获取设备会话令牌 → `POST /session/device`
5. 接受用户代码 → `POST /device_authorization/accept_user_code`
6. 批准授权 → `POST /device_authorization/associate_token`
7. 轮询获取 Token → `POST /token`（最长 2 分钟）

### 3.3 方式三：本地凭证文件导入

读取服务器本机的 Kiro IDE 凭证文件：

```
dist/server/routes/accounts.js-774~825
```

```js
// GET /api/accounts/load-kiro-credentials - 从服务器本地读取 Kiro 凭证文件
router.get('/load-kiro-credentials', async (req, res) => {
    // 从 ~/.aws/sso/cache/kiro-auth-token.json 读取 token
    const ssoCache = join(homedir(), '.aws', 'sso', 'cache');
    const tokenPath = join(ssoCache, 'kiro-auth-token.json');
```

读取逻辑：
1. 读取 `~/.aws/sso/cache/kiro-auth-token.json` 获取 refreshToken
2. 计算 clientIdHash，读取 `~/.aws/sso/cache/{clientIdHash}.json` 获取 clientId/clientSecret
3. 如果找不到对应文件，遍历 cache 目录搜索含 clientId 的 JSON 文件

---

## 四、企业账户特殊处理

### 4.1 Provider 识别

```
dist/server/services/credentialService.js-171~174
```

```js
const idp = provider && (provider === 'Enterprise' || provider === 'Github' || provider === 'Google')
    ? provider
    : 'BuilderId';
```

Enterprise 作为独立的 idp 类型传递给 Kiro API。

### 4.2 CBOR → REST API 降级

企业账户（IdC）可能无法使用 CBOR 协议的 API，系统自动降级到 REST API：

```
dist/server/services/credentialService.js-188~196
```

```js
catch (cborError) {
    const errorMsg = cborError instanceof Error ? cborError.message : '';
    // CBOR API 401/403 时自动 fallback 到 REST API（Enterprise/IdC 账号可能需要）
    if (errorMsg.includes('401') || errorMsg.includes('403')) {
        console.log(`[Verify] CBOR API failed (${errorMsg}), falling back to REST API...`);
        return await getUsageLimitsRest(refreshResult.accessToken, region);
    }
}
```

REST API 端点选择逻辑：

```
dist/server/services/credentialService.js-87~96
```

```js
function getRestApiEndpoint(ssoRegion) {
    if (ssoRegion?.startsWith('eu-')) return 'https://q.eu-central-1.amazonaws.com';
    return 'https://q.us-east-1.amazonaws.com';
}
function getFallbackRestApiEndpoint(ssoRegion) {
    // 主端点 403 时自动切换到备用端点
}
```

### 4.3 订阅类型识别

```
dist/server/services/credentialService.js-206~218
```

```js
if (titleUpper.includes('POWER')) {
    subscriptionType = 'Enterprise';
} else if (titleUpper.includes('ENTERPRISE')) {
    subscriptionType = 'Enterprise';
}
```

`POWER` 和 `ENTERPRISE` 关键字都映射为 Enterprise 类型。

---

## 五、账号池智能调度

### 5.1 三种负载均衡模式

```
dist/server/proxy/accountPool.js-20~21
```

```js
useSmartScheduling = true;  // 启用智能调度
loadBalancingMode = 'smart'; // 负载均衡模式：smart / priority / balanced
```

### 5.2 Smart 模式评分算法

```
dist/server/proxy/accountPool.js-223~296
```

评分因子：
- 基础分：健康分数（0-100）
- 并发感知：每个 inflight 请求扣 30 分
- 使用量均衡：基于滑动窗口（5 分钟）的近期请求数
- 空闲加分：最近未使用的账号加分
- 响应时间：快速响应的账号加分
- Token 过期：快过期的账号减分

选择策略：Top-N 随机选择（分数接近的候选者中随机挑选，防止惊群效应）

### 5.3 零空档期保证

```
dist/server/proxy/accountPool.js-298~340
```

当所有账号都不可用时，按优先级降级：
1. 冷却时间最短的账号（<5 秒直接使用）
2. 错误次数最少的账号（容忍超出 2 次）
3. 强制使用任意账号（绝对零空档期）

---

## 六、自动刷新机制

```
dist/server/services/autoRefreshService.js-5~11
```

```js
const DEFAULT_CONFIG = {
    enabled: true,
    intervalMinutes: 3,           // 每 3 分钟检查一次
    refreshBeforeExpiryMinutes: 10, // 过期前 10 分钟刷新
    concurrency: 2,               // 并发数
    maxRetries: 3,                // 最大重试 3 次
    retryDelayMs: 2000,           // 2 秒后重试（指数退避）
};
```

刷新时同时获取最新用量数据，满额自动禁用、额度恢复自动启用。

---

## 七、配额监控

```
dist/server/proxy/quotaMonitor.js-5~9
```

```js
const DEFAULT_MONITOR_CONFIG = {
    warningThreshold: 70,    // 70% 警告
    criticalThreshold: 90,   // 90% 严重
    checkIntervalMs: 60000,  // 1 分钟检查
    alertCooldownMs: 300000  // 5 分钟告警冷却
};
```

告警级别：`warning`（70%）→ `critical`（90%）→ `exhausted`（100%）→ `reset_soon`（重置前 1 小时）

配额历史追踪器（`QuotaHistoryTracker`）每 5 分钟采样，支持线性回归趋势分析。

---

## 八、MachineId 与 User-Agent 策略

```
dist/server/proxy/kiroApi.js-279~300
```

```js
function generateMachineIdFromRefreshToken(refreshToken) {
    hash.update(`KotlinNativeAPI/${refreshToken}`);
    return hash.digest('hex');
}
```

```
dist/server/proxy/kiroApi.js-310~330
```

根据 machineId 存在与否决定 User-Agent 格式：
- 有 machineId（IDE 登录）→ `KiroIDE-{version}-{machineId}` 格式
- 无 machineId（CLI 登录）→ `AmazonQ-For-CLI` 格式

---

## 九、OAuth 登录流程

### Builder ID 登录

```
dist/server/routes/oauth.js-21~100
```

标准 OIDC 设备授权流程：注册客户端 → 设备授权 → 轮询 Token

### Social 登录（Google/GitHub）

```
dist/server/routes/oauth.js-195~300
```

PKCE 流程：生成 code_verifier → 构建登录 URL → 用户授权 → 交换 Token

认证端点：`https://prod.us-east-1.auth.desktop.kiro.dev`

---

## 十、总结

| 特性 | 说明 |
|------|------|
| 企业账户支持 | Provider 选择 Enterprise，CBOR→REST 自动降级 |
| 区域分离 | Token 刷新用账号 region，Chat API 固定 us-east-1 |
| 导入方式 | OIDC 手动 / SSO Token / 本地凭证文件 |
| 负载均衡 | Smart 模式（健康分数 + 并发感知 + 使用量均衡） |
| 自动刷新 | 每 3 分钟，满额自动禁用/恢复 |
| 配额监控 | 70%/90%/100% 三级告警 + 趋势分析 |
| 零空档期 | 所有账号不可用时强制降级使用 |
