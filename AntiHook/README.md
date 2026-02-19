# AntiHook (GUI)

AntiHook 现在是一个 **Tauri v2 + React + Vite** 的桌面配置工具，用于给用户部署的 AntiHub-ALL 填写 `KIRO_SERVER_URL`，并一键检测服务是否可用（请求 `GET /api/health`）。

> 旧版 Go CLI 实现已被归档到 `2-参考项目/AntiHook-legacy/`，便于后续参考/恢复逻辑。

## 功能（当前版本）

- 配置 `KIRO_SERVER_URL`（自动规范化：去掉末尾 `/`，只允许 `http/https`）
- 保存到本机配置文件：`~/.config/antihook/config.json`
- 检测服务连通性：`GET {KIRO_SERVER_URL}/api/health`

## 开发 & 构建

### 前置依赖

- Node.js 18+（建议 20+）
- Rust 工具链（Tauri v2）
- Windows 需要 WebView2 Runtime（通常系统已自带或可安装）

### 开发模式

```bash
cd AntiHook
npm install
npm run tauri dev
```

### 打包桌面应用（生成安装包/可执行文件）

```bash
cd AntiHook
npm install
npm run tauri build
```

### 仅构建前端（不打包桌面）

```bash
cd AntiHook
npm run build
```
