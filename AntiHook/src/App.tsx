import { invoke } from '@tauri-apps/api/core';
import React, { useEffect, useMemo, useState } from 'react';
import { OpenAI, Gemini } from '@lobehub/icons';
import { Settings as SettingsIcon, Terminal, Code } from 'lucide-react';
import './index.css';

type AppConfig = {
  kiro_server_url: string;
};

type HealthCheckResult = {
  request_url: string;
  ok: boolean;
  status_code?: number | null;
  elapsed_ms: number;
  payload?: unknown | null;
  error?: string | null;
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const KiroIconSvg = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <path
      d="M20 4C12 4 6 10 6 18C6 22 8 25 8 25C8 25 7 28 7 30C7 32 8 34 10 34C11 34 12 33 13 32C14 33 16 34 20 34C24 34 26 33 27 32C28 33 29 34 30 34C32 34 33 32 33 30C33 28 32 25 32 25C32 25 34 22 34 18C34 10 28 4 20 4ZM14 20C12.5 20 11 18.5 11 17C11 15.5 12.5 14 14 14C15.5 14 17 15.5 17 17C17 18.5 15.5 20 14 20ZM26 20C24.5 20 23 18.5 23 17C23 15.5 24.5 14 26 14C27.5 14 29 15.5 29 17C29 18.5 27.5 20 26 20Z"
      fill="currentColor"
    />
  </svg>
);

const CHANNELS = [
  { id: 'CodexCLI', label: 'CodexCLI', icon: () => <OpenAI size={18} /> },
  { id: 'KiroIDE', label: 'KiroIDE', icon: () => <KiroIconSvg size={18} /> },
  { id: 'KiroCLI', label: 'KiroCLI', icon: () => <Terminal size={18} /> },
  { id: 'GeminiCLI', label: 'GeminiCLI', icon: () => <Gemini.Color size={18} /> },
];

export default function App() {
  const [activeChannel, setActiveChannel] = useState('设置');
  
  // Settings Hook state
  const [configPath, setConfigPath] = useState<string>('');
  const [serverUrl, setServerUrl] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [health, setHealth] = useState<HealthCheckResult | null>(null);

  const normalizedHint = useMemo(() => serverUrl.trim().replace(/\/+$/, ''), [serverUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const path = await invoke<string>('get_config_path');
        if (!cancelled) setConfigPath(path);

        const cfg = await invoke<AppConfig | null>('load_config');
        if (!cancelled && cfg?.kiro_server_url) {
          setServerUrl(cfg.kiro_server_url);
        }
      } catch (e) {
        if (!cancelled) setMessage(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    setMessage('');
    setHealth(null);
    setIsSaving(true);
    try {
      const normalized = await invoke<string>('save_config', { kiroServerUrl: serverUrl });
      setServerUrl(normalized);
      setMessage('已保存配置。');
    } catch (e) {
      setMessage(`保存失败：${String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function onCheck() {
    setMessage('');
    setHealth(null);
    setIsChecking(true);
    try {
      const result = await invoke<HealthCheckResult>('check_health', { baseUrl: serverUrl });
      setHealth(result);
      if (result.ok) setMessage('检测成功。');
      else setMessage('检测失败。');
    } catch (e) {
      setMessage(`检测失败：${String(e)}`);
    } finally {
      setIsChecking(false);
    }
  }

  const renderContent = () => {
    if (activeChannel === '设置') {
      return (
        <div className="mx-auto max-w-3xl px-6 py-10 animate-fade-in-up">
          <header className="mb-8">
            <h1 className="text-3xl font-semibold tracking-tight text-white">设置</h1>
            <p className="mt-2 text-sm text-slate-300">
              配置用户部署的 AntiHub-ALL：设置 <span className="font-mono text-indigo-300">KIRO_SERVER_URL</span> 并检测{' '}
              <span className="font-mono text-indigo-300">/api/health</span>。
            </p>
          </header>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
            <label className="block text-sm font-medium text-slate-200">KIRO_SERVER_URL</label>
            <div className="mt-2 flex gap-3">
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://your-antihub.example.com"
                className="w-full rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3 font-mono text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-500 focus:border-indigo-400/60 focus:ring-4 focus:ring-indigo-500/20 transition-all"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </div>

            <div className="mt-3 text-xs text-slate-400">
              规范化后将保存为：<span className="font-mono text-slate-200">{normalizedHint || '（空）'}</span>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                onClick={onSave}
                disabled={isSaving || isChecking}
                className="rounded-xl bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? '保存中…' : '保存配置'}
              </button>
              <button
                onClick={onCheck}
                disabled={isSaving || isChecking}
                className="rounded-xl border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isChecking ? '检测中…' : '检测健康状态'}
              </button>

              <div className="ml-auto text-xs text-slate-400">
                配置文件：<span className="font-mono text-slate-200">{configPath || '…'}</span>
              </div>
            </div>

            {message ? (
              <div className="mt-5 rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm text-slate-200 animate-fade-in-up">
                {message}
              </div>
            ) : null}
          </div>

          {health ? (
            <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur animate-fade-in-up delay-100">
              <div className="flex flex-wrap items-center gap-3">
                <div
                  className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                    health.ok ? 'bg-emerald-500/15 text-emerald-200' : 'bg-rose-500/15 text-rose-200'
                  }`}
                >
                  {health.ok ? 'Healthy' : 'Unhealthy'}
                </div>
                <div className="text-sm text-slate-300">
                  {health.status_code ? (
                    <>
                      HTTP <span className="font-mono text-slate-100">{health.status_code}</span>
                    </>
                  ) : (
                    <span className="text-slate-400">无状态码</span>
                  )}
                  <span className="mx-2 text-slate-600">•</span>
                  用时 <span className="font-mono text-slate-100">{formatElapsed(health.elapsed_ms)}</span>
                </div>
                <div className="ml-auto text-xs text-slate-400">
                  <span className="font-mono text-slate-200">{health.request_url}</span>
                </div>
              </div>

              {health.error ? (
                <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                  {health.error}
                </div>
              ) : null}

              {health.payload ? (
                <pre className="mt-4 max-h-80 overflow-auto rounded-xl border border-white/10 bg-slate-950/40 p-4 text-xs text-slate-200">
                  {JSON.stringify(health.payload, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : null}

          <footer className="mt-10 text-xs text-slate-500">
            提示：旧版 Go CLI 逻辑已归档到 <span className="font-mono text-slate-300">2-参考项目/AntiHook-legacy</span>。
          </footer>
        </div>
      );
    }

    // Default placeholder for other channels
    const currentChannel = CHANNELS.find(c => c.id === activeChannel);
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full text-slate-400 animate-fade-in-up">
        <div className="mb-4">
          {currentChannel?.id === 'CodexCLI' ? (
            <OpenAI size={56} />
          ) : currentChannel?.id === 'GeminiCLI' ? (
            <Gemini.Color size={56} />
          ) : currentChannel?.id === 'KiroIDE' ? (
            <Code size={56} />
          ) : currentChannel?.id === 'KiroCLI' ? (
            <Terminal size={56} />
          ) : (
            <KiroIconSvg size={56} />
          )}
        </div>
        <h2 className="text-2xl font-medium text-slate-200 mb-2">{activeChannel}</h2>
        <p className="text-sm">该渠道的功能还在开发中...</p>
      </div>
    );
  };

  return (
    <div className="flex h-screen bg-[#0f0f1a] text-[#e5e5e5] font-sans selection:bg-indigo-500/30 overflow-hidden">
      {/* Sidebar - Copied from Kiro Account Manager style */}
      <div className="w-56 bg-[#1a1a2e] border-r border-white/5 flex flex-col relative z-10 shadow-xl">
        <div className="p-5 pb-4">
          <div className="flex items-center gap-2.5 mb-1 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
            <div className="w-10 h-10 bg-indigo-500/20 text-indigo-400 rounded-xl flex items-center justify-center backdrop-blur-sm transition-transform hover:scale-110 hover:rotate-3 shadow-lg shadow-indigo-500/10">
              <KiroIconSvg size={24} />
            </div>
            <div>
              <span className="font-bold text-lg tracking-wide text-white">AntiHook</span>
              <p className="text-xs text-slate-400">Account Manager</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-1 mt-4">
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 mb-2">渠道列表</div>
          {CHANNELS.map((item, index) => {
            const Icon = item.icon;
            const isActive = activeChannel === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveChannel(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-all rounded-xl group animate-slide-in-left ${
                  isActive
                    ? 'bg-indigo-500/15 text-indigo-300 font-medium shadow-sm'
                    : 'text-slate-300 hover:bg-white/5 hover:text-white'
                }`}
                style={{ animationDelay: `${0.15 + index * 0.05}s` }}
              >
                <div className={`transition-transform flex-shrink-0 ${isActive ? '' : 'group-hover:scale-110'}`}>
                  <Icon />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm">{item.label}</span>
                </div>
                {isActive && <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.8)] animate-pulse" />}
              </button>
            );
          })}

          <div className="mt-6 mb-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3">系统</div>
          <button
            onClick={() => setActiveChannel('设置')}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-all rounded-xl group animate-slide-in-left ${
              activeChannel === '设置'
                ? 'bg-indigo-500/15 text-indigo-300 font-medium shadow-sm'
                : 'text-slate-300 hover:bg-white/5 hover:text-white'
            }`}
            style={{ animationDelay: `${0.15 + CHANNELS.length * 0.05}s` }}
          >
            <div className={`transition-transform flex-shrink-0 ${activeChannel === '设置' ? '' : 'group-hover:scale-110'}`}>
              <SettingsIcon size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm">系统设置</span>
            </div>
            {activeChannel === '设置' && <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.8)] animate-pulse" />}
          </button>
        </nav>
      </div>

      {/* Main Content */}
      <main className="flex-1 relative overflow-auto bg-gradient-to-br from-[#0f0f1a] via-[#131324] to-[#121021]">
        {/* Decorative background blurs */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-indigo-600/10 blur-[100px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-purple-600/10 blur-[100px] pointer-events-none" />
        
        <div className="relative z-10 h-full">
          {renderContent()}
        </div>
      </main>
    </div>
  );
}
