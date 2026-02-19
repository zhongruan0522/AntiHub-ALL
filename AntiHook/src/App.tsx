import { invoke } from '@tauri-apps/api/core';
import React, { useEffect, useMemo, useState } from 'react';

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

export default function App() {
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">AntiHook</h1>
          <p className="mt-2 text-sm text-slate-300">
            配置用户部署的 AntiHub-ALL：设置 <span className="font-mono">KIRO_SERVER_URL</span> 并检测{' '}
            <span className="font-mono">/api/health</span>。
          </p>
        </header>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
          <label className="block text-sm font-medium text-slate-200">KIRO_SERVER_URL</label>
          <div className="mt-2 flex gap-3">
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://your-antihub.example.com"
              className="w-full rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3 font-mono text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-500 focus:border-indigo-400/60 focus:ring-4 focus:ring-indigo-500/20"
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
            <div className="mt-5 rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm text-slate-200">
              {message}
            </div>
          ) : null}
        </div>

        {health ? (
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
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
    </div>
  );
}
