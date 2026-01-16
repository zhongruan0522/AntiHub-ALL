'use client';

import { useState, useRef, useEffect } from 'react';
import {
  createKiroAccount,
  getKiroAccountBalance,
  getKiroOAuthAuthorizeUrl,
  getOAuthAuthorizeUrl,
  pollKiroOAuthStatus,
  submitOAuthCallback,
  getQwenOAuthAuthorizeUrl,
  pollQwenOAuthStatus,
  importAccountByRefreshToken,
  importQwenAccount,
  kiroAwsIdcDeviceAuthorize,
  kiroAwsIdcDeviceStatus,
  importKiroAwsIdcAccount,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Button as StatefulButton } from '@/components/ui/stateful-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { IconExternalLink, IconCopy, IconX } from '@tabler/icons-react';
import { Qwen } from '@lobehub/icons';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Toaster, { ToasterRef } from '@/components/ui/toast';

interface AddAccountDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type KiroBatchImportStatus = 'pending' | 'success' | 'error';

interface KiroBatchImportResult {
  index: number;
  status: KiroBatchImportStatus;
  email?: string;
  available?: number;
  message?: string;
}

type AntiHookOS = 'windows' | 'darwin' | 'linux';
type AntiHookArch = 'amd64' | 'arm64';

const ANTIHOOK_DOWNLOAD_OPTIONS: Array<{
  label: string;
  os: AntiHookOS;
  arch: AntiHookArch;
}> = [
  { label: 'Windows x64', os: 'windows', arch: 'amd64' },
  { label: 'Windows ARM64', os: 'windows', arch: 'arm64' },
  { label: 'macOS Intel', os: 'darwin', arch: 'amd64' },
  { label: 'macOS Apple Silicon', os: 'darwin', arch: 'arm64' },
  { label: 'Linux x64', os: 'linux', arch: 'amd64' },
  { label: 'Linux ARM64', os: 'linux', arch: 'arm64' },
];

const getAntiHookAssetName = (os: AntiHookOS, arch: AntiHookArch) => {
  const ext = os === 'windows' ? '.exe' : '';
  return `antihook-${os}-${arch}${ext}`;
};

export function AddAccountDrawer({ open, onOpenChange, onSuccess }: AddAccountDrawerProps) {
  const toasterRef = useRef<ToasterRef>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const kiroBatchCancelRef = useRef(false);
  const [step, setStep] = useState<
    'platform' | 'kiro_provider' | 'method' | 'authorize'
  >('platform');
  const [platform, setPlatform] = useState<'antigravity' | 'kiro' | 'qwen' | ''>('');
  const [kiroProvider, setKiroProvider] = useState<'social' | 'aws_idc' | ''>('');
  const [loginMethod, setLoginMethod] = useState<'manual' | 'refresh_token' | ''>(''); // Antigravity 登录方式
  const [kiroLoginMethod, setKiroLoginMethod] = useState<'oauth' | 'refresh_token' | ''>('');
  const [kiroAwsIdcMethod, setKiroAwsIdcMethod] = useState<
    'device_code' | 'manual_import' | ''
  >('');
  const [qwenLoginMethod, setQwenLoginMethod] = useState<'oauth' | 'json'>('oauth');
  const [kiroImportRefreshToken, setKiroImportRefreshToken] = useState('');
  const [kiroImportClientId, setKiroImportClientId] = useState('');
  const [kiroImportClientSecret, setKiroImportClientSecret] = useState('');
  const [kiroImportAccountName, setKiroImportAccountName] = useState('');
  const [antigravityImportRefreshToken, setAntigravityImportRefreshToken] = useState('');
  const [qwenCredentialJson, setQwenCredentialJson] = useState('');
  const [qwenAccountName, setQwenAccountName] = useState('');
  const [oauthUrl, setOauthUrl] = useState('');
  const [oauthState, setOauthState] = useState(''); // Kiro OAuth state
  const [callbackUrl, setCallbackUrl] = useState('');
  const [countdown, setCountdown] = useState(600); // Kiro授权倒计时（600秒）
  const [isWaitingAuth, setIsWaitingAuth] = useState(false); // Kiro是否等待授权中
  const [currentOrigin, setCurrentOrigin] = useState('');
  const [antiHookOs, setAntiHookOs] = useState<AntiHookOS | ''>('');
  const [antiHookArch, setAntiHookArch] = useState<AntiHookArch | ''>('');
  const [showAntiHookDownloads, setShowAntiHookDownloads] = useState(false);

  const [kiroBatchJson, setKiroBatchJson] = useState('');
  const [kiroBatchResults, setKiroBatchResults] = useState<KiroBatchImportResult[]>([]);
  const [isKiroBatchImporting, setIsKiroBatchImporting] = useState(false);

  const [kiroAwsIdcStatus, setKiroAwsIdcStatus] = useState<
    'idle' | 'pending' | 'completed' | 'error' | 'expired'
  >('idle');
  const [kiroAwsIdcState, setKiroAwsIdcState] = useState('');
  const [kiroAwsIdcUserCode, setKiroAwsIdcUserCode] = useState('');
  const [kiroAwsIdcVerificationUri, setKiroAwsIdcVerificationUri] = useState('');
  const [kiroAwsIdcVerificationUriComplete, setKiroAwsIdcVerificationUriComplete] = useState('');
  const [kiroAwsIdcExpiresAt, setKiroAwsIdcExpiresAt] = useState('');
  const [kiroAwsIdcIntervalSeconds, setKiroAwsIdcIntervalSeconds] = useState(5);
  const [kiroAwsIdcMessage, setKiroAwsIdcMessage] = useState('');
  const [kiroAwsIdcResult, setKiroAwsIdcResult] = useState<any>(null);

  const recommendedAntiHook =
    antiHookOs !== '' && antiHookArch !== ''
      ? (ANTIHOOK_DOWNLOAD_OPTIONS.find(
          (item) => item.os === antiHookOs && item.arch === antiHookArch
        ) ?? null)
      : null;

  const recommendedAntiHookUrl = recommendedAntiHook
    ? `/antihook/${getAntiHookAssetName(recommendedAntiHook.os, recommendedAntiHook.arch)}`
    : '';

  // 清理定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  // 检测浏览器环境，用于推荐 AntiHook 下载版本
  useEffect(() => {
    if (typeof window === 'undefined') return;

    setCurrentOrigin(window.location.origin);

    const ua = window.navigator.userAgent || '';

    let os: AntiHookOS | '' = '';
    if (/windows/i.test(ua)) os = 'windows';
    else if (/macintosh|mac os/i.test(ua)) os = 'darwin';
    else if (/linux/i.test(ua)) os = 'linux';

    let arch: AntiHookArch | '' = '';
    if (/arm64|aarch64/i.test(ua)) arch = 'arm64';
    else if (/x86_64|amd64|win64|x64/i.test(ua)) arch = 'amd64';

    setAntiHookOs(os);
    setAntiHookArch(arch);

    const uaData: any = (window.navigator as any).userAgentData;
    if (uaData?.getHighEntropyValues) {
      uaData
        .getHighEntropyValues(['architecture'])
        .then((values: any) => {
          const value = String(values?.architecture || '').toLowerCase();
          if (value.includes('arm')) setAntiHookArch('arm64');
          if (value.includes('x86')) setAntiHookArch('amd64');
        })
        .catch(() => {});
    }

    if (!os || !arch) setShowAntiHookDownloads(true);
  }, []);

  const handleContinue = async () => {
    if (step === 'platform') {
      if (!platform) {
        toasterRef.current?.show({
          title: '选择平台',
          message: '请选择一个平台',
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }
      if (platform === 'kiro') {
        setStep('kiro_provider');
      } else {
        setStep('method');
      }
    } else if (step === 'kiro_provider') {
      if (!kiroProvider) {
        toasterRef.current?.show({
          title: '选择渠道',
          message: '请选择 Kiro 授权渠道',
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }

      if (kiroProvider === 'social') {
        setKiroLoginMethod('oauth');
        setOauthUrl('');
        setOauthState('');
        setCountdown(600);
        setIsWaitingAuth(false);
        setStep('method');
        return;
      }

      if (kiroProvider === 'aws_idc') {
        setKiroAwsIdcMethod('manual_import');
        setKiroAwsIdcStatus('idle');
        setKiroAwsIdcMessage('');
        setKiroAwsIdcResult(null);
        setKiroAwsIdcState('');
        setKiroAwsIdcUserCode('');
        setKiroAwsIdcVerificationUri('');
        setKiroAwsIdcVerificationUriComplete('');
        setKiroAwsIdcExpiresAt('');
        setKiroAwsIdcIntervalSeconds(5);
        setCountdown(600);
        setIsWaitingAuth(false);
        setStep('authorize');
        return;
      }

      setStep('method');
    } else if (step === 'method') {
      if (platform === 'kiro') {
        if (!kiroLoginMethod) {
          toasterRef.current?.show({
            title: '选择方式',
            message: '请选择添加方式',
            variant: 'warning',
            position: 'top-right',
          });
          return;
        }

        setOauthUrl('');
        setOauthState('');
        setCountdown(600);
        setIsWaitingAuth(false);
        setStep('authorize');
        return;
      }

      if (platform === 'qwen') {
        if (!qwenLoginMethod) {
          toasterRef.current?.show({
            title: '选择方式',
            message: '请选择添加方式',
            variant: 'warning',
            position: 'top-right',
          });
          return;
        }

        setOauthUrl('');
        setOauthState('');
        setCountdown(600);
        setIsWaitingAuth(false);
        setStep('authorize');
        return;
      }

      if (!loginMethod) {
        toasterRef.current?.show({
          title: '选择登录方式',
          message: '请选择一种登录方式',
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }

      // refresh_token 导入直接进入下一步
      if (loginMethod === 'refresh_token') {
        setOauthUrl('');
        setCallbackUrl('');
        setStep('authorize');
        return;
      }
      
      // 手动回调才需要获取授权链接并进入下一页
      try {
        const { auth_url } = await getOAuthAuthorizeUrl(0);
        setOauthUrl(auth_url);
        setStep('authorize');
      } catch (err) {
        toasterRef.current?.show({
          title: '获取失败',
          message: err instanceof Error ? err.message : '获取授权链接失败',
          variant: 'error',
          position: 'top-right',
        });
        throw err;
      }
    }
  };

  const handleBack = () => {
    if (step === 'kiro_provider') {
      setStep('platform');
      setKiroProvider('');
      setKiroLoginMethod('');
      setKiroAwsIdcMethod('');
    } else if (step === 'method') {
      if (platform === 'kiro') {
        setStep('kiro_provider');
        setKiroLoginMethod('');
        setKiroAwsIdcMethod('');
      } else {
        setStep('platform');
        if (platform === 'antigravity') {
          setLoginMethod('');
        }
      }
    } else if (step === 'authorize') {
      if (platform === 'kiro' || platform === 'qwen') {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setIsWaitingAuth(false);
        setCountdown(600);
      }

      if (platform === 'qwen') {
        setStep('method');
        setQwenLoginMethod('oauth');
      } else if (platform === 'antigravity') {
        setStep('method');
      } else {
        setStep('kiro_provider');
      }
      setOauthUrl('');
      setOauthState('');
      setCallbackUrl('');
      setAntigravityImportRefreshToken('');
      setQwenCredentialJson('');
      setQwenAccountName('');

      setKiroAwsIdcStatus('idle');
      setKiroAwsIdcMessage('');
      setKiroAwsIdcResult(null);
      setKiroAwsIdcState('');
      setKiroAwsIdcUserCode('');
      setKiroAwsIdcVerificationUri('');
      setKiroAwsIdcVerificationUriComplete('');
      setKiroAwsIdcExpiresAt('');
      setKiroAwsIdcIntervalSeconds(5);
    }
  };

  const handleOpenOAuthUrl = () => {
    window.open(oauthUrl, '_blank', 'width=600,height=700');
  };

  // 开始倒计时（从获取链接时就开始）
  const startCountdownTimer = (initialSeconds: number) => {
    // 清除之前的定时器
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    let currentSeconds = initialSeconds;

    timerRef.current = setInterval(() => {
      currentSeconds--;
      setCountdown(currentSeconds);

      if (currentSeconds <= 0) {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        setIsWaitingAuth(false);
        toasterRef.current?.show({
          title: '授权超时',
          message: '授权时间已过期，请重新开始',
          variant: 'warning',
          position: 'top-right',
        });
      }
    }, 1000);
  };

  // 轮询 Kiro AWS IdC（Builder ID）设备码登录状态
  const startPollingKiroAwsIdcStatus = (state: string, intervalSeconds: number) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    const intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));

    pollTimerRef.current = setInterval(async () => {
      try {
        const result = await kiroAwsIdcDeviceStatus(state);

        setKiroAwsIdcStatus(result.status);
        if (typeof result.message === 'string') {
          setKiroAwsIdcMessage(result.message);
        }

        if (result.status === 'pending') return;

        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }

        setIsWaitingAuth(false);

        if (result.status === 'completed') {
          setKiroAwsIdcResult(result.data ?? null);
          toasterRef.current?.show({
            title: '授权成功',
            message: '已完成授权，请点击“完成”结束流程',
            variant: 'success',
            position: 'top-right',
          });
          return;
        }

        if (result.status === 'expired') {
          toasterRef.current?.show({
            title: '授权已过期',
            message: result.message || '请返回重新开始',
            variant: 'warning',
            position: 'top-right',
          });
          return;
        }

        toasterRef.current?.show({
          title: '授权失败',
          message: result.message || (result as any).error || '授权失败，请重试',
          variant: 'error',
          position: 'top-right',
        });
      } catch (error) {
        console.error('轮询 AWS IdC 状态失败:', error);
      }
    }, intervalMs);
  };

  // 轮询 Kiro OAuth（Social）登录状态
  const startPollingKiroOAuthStatus = (state: string) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    pollTimerRef.current = setInterval(async () => {
      try {
        const result = await pollKiroOAuthStatus(state);

        if (result.status === 'pending') return;

        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }

        setIsWaitingAuth(false);

        if (result.status === 'completed') {
          toasterRef.current?.show({
            title: '授权成功',
            message: 'Kiro 账号已成功添加',
            variant: 'success',
            position: 'top-right',
          });

          window.dispatchEvent(new CustomEvent('accountAdded'));
          onOpenChange(false);
          resetState();
          onSuccess?.();
          return;
        }

        if (result.status === 'expired') {
          toasterRef.current?.show({
            title: '授权已过期',
            message: result.message || '请返回重新开始',
            variant: 'warning',
            position: 'top-right',
          });
          return;
        }

        toasterRef.current?.show({
          title: '授权失败',
          message:
            result.message ||
            (result as any).error ||
            '授权失败，请重试',
          variant: 'error',
          position: 'top-right',
        });
      } catch (error) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }

        setIsWaitingAuth(false);

        const message = error instanceof Error ? error.message : '轮询授权状态失败';
        const isExpired = /过期|expired|state/i.test(message);
        toasterRef.current?.show({
          title: isExpired ? '授权已过期' : '授权失败',
          message,
          variant: isExpired ? 'warning' : 'error',
          position: 'top-right',
        });
      }
    }, 3000);
  };

  // 轮询 Qwen OAuth（Device Flow）登录状态
  const startPollingQwenOAuthStatus = (state: string) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    pollTimerRef.current = setInterval(async () => {
      try {
        const result = await pollQwenOAuthStatus(state);

        if (result.status === 'completed') {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }

          toasterRef.current?.show({
            title: '授权成功',
            message: 'Qwen 账号已成功添加',
            variant: 'success',
            position: 'top-right',
          });

          window.dispatchEvent(new CustomEvent('accountAdded'));
          onOpenChange(false);
          resetState();
          onSuccess?.();
          return;
        }

        if (result.status === 'failed') {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          setIsWaitingAuth(false);
          toasterRef.current?.show({
            title: '授权失败',
            message: result.message || (result as any).error || '授权失败，请重试',
            variant: 'error',
            position: 'top-right',
          });
          return;
        }

        if (result.status === 'expired') {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          setIsWaitingAuth(false);
          toasterRef.current?.show({
            title: '授权已过期',
            message: '请返回重新开始',
            variant: 'warning',
            position: 'top-right',
          });
        }
      } catch (error) {
        console.error('轮询Qwen OAuth状态失败:', error);
      }
    }, 3000);
  };

  // 格式化倒计时显示
  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSubmitCallback = async () => {
    if (!callbackUrl.trim()) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请输入回调地址',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      await submitOAuthCallback(callbackUrl);
      toasterRef.current?.show({
        title: '添加成功',
        message: '账号已成功添加',
        variant: 'success',
        position: 'top-right',
      });
      // 触发账号列表刷新事件
      window.dispatchEvent(new CustomEvent('accountAdded'));
      // 成功后关闭 Drawer 并重置状态
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      toasterRef.current?.show({
        title: '提交失败',
        message: err instanceof Error ? err.message : '提交回调失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err; // 让 StatefulButton 处理错误状态
    }
  };

  const handleImportAntigravityAccount = async () => {
    const refreshToken = antigravityImportRefreshToken.trim();
    if (!refreshToken) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴 refresh_token',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      await importAccountByRefreshToken(refreshToken, 0);
      toasterRef.current?.show({
        title: '导入成功',
        message: '账号已成功添加',
        variant: 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      toasterRef.current?.show({
        title: '导入失败',
        message: err instanceof Error ? err.message : '导入账号失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleImportKiroAccount = async () => {
    const refreshToken = kiroImportRefreshToken.trim();
    if (!refreshToken) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴 refresh_token',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    const accountName = kiroImportAccountName.trim();

    try {
      await createKiroAccount({
        refresh_token: refreshToken,
        auth_method: 'Social',
        account_name: accountName || undefined,
        is_shared: 0,
      });

      toasterRef.current?.show({
        title: '添加成功',
        message: 'Kiro 账号已导入',
        variant: 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      toasterRef.current?.show({
        title: '导入失败',
        message: err instanceof Error ? err.message : '导入 Kiro 账号失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleBatchImportKiroAccounts = async () => {
    const raw = kiroBatchJson.replace(/^\uFEFF/, '').trim();
    if (!raw) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴批量 JSON 内容',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    if (isKiroBatchImporting) return;

    kiroBatchCancelRef.current = false;

    let parsed: unknown;
    const normalized = raw.replace(/，/g, ',');
    try {
      parsed = JSON.parse(normalized);
    } catch {
      try {
        parsed = JSON.parse(`[${normalized}]`);
      } catch {
        toasterRef.current?.show({
          title: 'JSON 格式错误',
          message: '请输入有效 JSON（支持 JSON 数组，或多个 JSON 对象用逗号分隔）',
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }
    }

    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0) {
      toasterRef.current?.show({
        title: '没有可导入项',
        message: 'JSON 为空，请检查输入内容',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    const extracted: Array<{ token: string; error?: string }> = items.map((item) => {
      if (typeof item === 'string' && item.trim()) return { token: item.trim() };

      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { token: '', error: '只支持对象或字符串' };
      }

      const obj = item as Record<string, unknown>;
      const direct =
        (obj.RT ?? obj.rt ?? obj.refresh_token ?? obj.refreshToken ?? obj.RefreshToken) as unknown;

      const tokenCandidate = (() => {
        if (typeof direct === 'string' && direct.trim()) return direct.trim();

        const values = Object.values(obj);
        let longest = '';
        for (const v of values) {
          if (typeof v !== 'string') continue;
          const trimmed = v.trim();
          if (!trimmed) continue;
          if (trimmed.length > longest.length) longest = trimmed;
        }
        return longest;
      })();

      if (typeof tokenCandidate !== 'string' || !tokenCandidate.trim()) {
        return { token: '', error: '找不到 RefreshToken（对象里必须至少有一个字符串值）' };
      }

      return { token: tokenCandidate.trim() };
    });

    setKiroBatchResults(
      extracted.map((entry, idx) => ({
        index: idx + 1,
        status: entry.token ? 'pending' : 'error',
        message: entry.token ? '等待导入' : entry.error || '解析失败',
      }))
    );

    setIsKiroBatchImporting(true);

    let successCount = 0;
    let failedCount = 0;

    const updateResult = (index: number, patch: Partial<KiroBatchImportResult>) => {
      setKiroBatchResults((prev) =>
        prev.map((r) => (r.index === index ? { ...r, ...patch } : r))
      );
    };

    for (let idx = 0; idx < extracted.length; idx++) {
      if (kiroBatchCancelRef.current) break;

      const item = extracted[idx];
      const index = idx + 1;

      if (!item.token) {
        failedCount++;
        updateResult(index, { status: 'error' });
        continue;
      }

      updateResult(index, { status: 'pending', message: '导入中...' });

      try {
        const account = await createKiroAccount({
          refresh_token: item.token,
          auth_method: 'Social',
          is_shared: 0,
        });

        let email = account.email ?? undefined;
        let available: number | undefined;

        try {
          const balance = await getKiroAccountBalance(account.account_id);
          if (typeof balance.email === 'string' && balance.email.trim()) {
            email = balance.email.trim();
          }
          if (typeof balance.balance?.available === 'number') {
            available = balance.balance.available;
          }
        } catch {}

        successCount++;
        updateResult(index, { status: 'success', email, available, message: '成功' });
      } catch (err) {
        failedCount++;
        updateResult(index, {
          status: 'error',
          message: err instanceof Error ? err.message : '导入失败',
        });
      }
    }

    setIsKiroBatchImporting(false);

    if (kiroBatchCancelRef.current) return;

    if (successCount > 0) {
      window.dispatchEvent(new CustomEvent('accountAdded'));
      onSuccess?.();
    }

    const variant =
      successCount === 0 ? 'error' : failedCount > 0 ? 'warning' : 'success';

    toasterRef.current?.show({
      title: '批量导入完成',
      message: `成功 ${successCount}，失败 ${failedCount}`,
      variant,
      position: 'top-right',
    });
  };

  const handleImportKiroAwsIdcAccount = async () => {
    const accountName = kiroImportAccountName.trim();
    const refreshToken = kiroImportRefreshToken.trim();
    const clientId = kiroImportClientId.trim();
    const clientSecret = kiroImportClientSecret.trim();

    if (!accountName) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请填写 account_name（用于区分你的 Builder ID 账号）',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }
    if (!refreshToken || !clientId || !clientSecret) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请填写 refresh_token / client_id / client_secret',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      await importKiroAwsIdcAccount({
        refreshToken,
        clientId,
        clientSecret,
        accountName,
        isShared: 0,
      });

      toasterRef.current?.show({
        title: '导入成功',
        message: 'AWS-IMA（Builder ID）账号已成功添加',
        variant: 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      toasterRef.current?.show({
        title: '导入失败',
        message: err instanceof Error ? err.message : '导入 AWS-IMA（Builder ID）账号失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleStartKiroOAuth = async (provider: 'Google' | 'Github') => {
    try {
      const result = await getKiroOAuthAuthorizeUrl(provider, 0);

      setOauthUrl(result.data.auth_url);
      setOauthState(result.data.state);
      setCountdown(result.data.expires_in);
      setIsWaitingAuth(true);
      startCountdownTimer(result.data.expires_in);
      startPollingKiroOAuthStatus(result.data.state);

      window.open(result.data.auth_url, '_blank', 'width=600,height=700');
    } catch (err) {
      toasterRef.current?.show({
        title: '获取授权链接失败',
        message: err instanceof Error ? err.message : '获取 Kiro 授权链接失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleStartKiroAwsIdcDevice = async () => {
    const accountName = kiroImportAccountName.trim();
    if (!accountName) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请先填写 account_name（用于区分你的 Builder ID 账号）',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      setKiroAwsIdcStatus('pending');
      setKiroAwsIdcMessage('');
      setKiroAwsIdcResult(null);
      setKiroAwsIdcState('');
      setKiroAwsIdcUserCode('');
      setKiroAwsIdcVerificationUri('');
      setKiroAwsIdcVerificationUriComplete('');
      setKiroAwsIdcExpiresAt('');
      setKiroAwsIdcIntervalSeconds(5);

      const result = await kiroAwsIdcDeviceAuthorize({
        account_name: accountName,
        is_shared: 0,
      });

      setKiroAwsIdcStatus(result.status);
      if (typeof result.message === 'string') {
        setKiroAwsIdcMessage(result.message);
      }

      setKiroAwsIdcState(result.data.state);
      setKiroAwsIdcUserCode(result.data.user_code);
      setKiroAwsIdcVerificationUri(result.data.verification_uri);
      setKiroAwsIdcVerificationUriComplete(result.data.verification_uri_complete);
      setKiroAwsIdcExpiresAt(result.data.expires_at);
      setKiroAwsIdcIntervalSeconds(result.data.interval);

      setCountdown(result.data.expires_in);
      setIsWaitingAuth(true);
      startCountdownTimer(result.data.expires_in);
      startPollingKiroAwsIdcStatus(result.data.state, result.data.interval);

      window.open(result.data.verification_uri_complete, '_blank', 'width=600,height=700');
    } catch (err) {
      setIsWaitingAuth(false);
      setKiroAwsIdcStatus('error');
      toasterRef.current?.show({
        title: '发起授权失败',
        message: err instanceof Error ? err.message : '发起 AWS-IMA（Builder ID）授权失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleFinishKiroAwsIdcDevice = () => {
    window.dispatchEvent(new CustomEvent('accountAdded'));
    onOpenChange(false);
    resetState();
    onSuccess?.();
  };

  const handleStartQwenOAuth = async () => {
    try {
      const accountName = qwenAccountName.trim();
      const result = await getQwenOAuthAuthorizeUrl(0, accountName || undefined);

      setOauthUrl(result.data.auth_url);
      setOauthState(result.data.state);
      setCountdown(result.data.expires_in);
      setIsWaitingAuth(true);
      startCountdownTimer(result.data.expires_in);
      startPollingQwenOAuthStatus(result.data.state);

      // 直接打开授权页面（Device Flow 不需要回填 callback）
      window.open(result.data.auth_url, '_blank', 'width=600,height=700');
    } catch (err) {
      toasterRef.current?.show({
        title: '获取授权链接失败',
        message: err instanceof Error ? err.message : '获取Qwen授权链接失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleImportQwenAccount = async () => {
    const credentialJson = qwenCredentialJson.replace(/^\uFEFF/, '').trim();
    if (!credentialJson) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴 QwenCli JSON 凭证',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      let parsed: any = JSON.parse(credentialJson);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('invalid-json');
      }

      if (Array.isArray(parsed)) {
        if (parsed.length === 1) parsed = parsed[0];
        else throw new Error('bulk-json');
      }

      const nestedCandidate =
        parsed && typeof parsed === 'object'
          ? (parsed.credential ?? parsed.token ?? parsed.auth ?? parsed.data)
          : null;
      const nested =
        nestedCandidate && typeof nestedCandidate === 'object' && !Array.isArray(nestedCandidate)
          ? nestedCandidate
          : null;

      const type = parsed?.type ?? nested?.type ?? parsed?.provider ?? nested?.provider;
      const accessToken =
        parsed?.access_token ??
        parsed?.accessToken ??
        nested?.access_token ??
        nested?.accessToken ??
        (typeof parsed?.token === 'string' ? parsed.token : undefined) ??
        nested?.token;

      if (typeof type === 'string' && type.trim() && type.trim().toLowerCase() !== 'qwen') {
        toasterRef.current?.show({
          title: '凭证类型不匹配',
          message: '此处只接受 Qwen 的凭证（type 应为 qwen）',
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }
      if (typeof accessToken !== 'string' || !accessToken.trim()) {
        toasterRef.current?.show({
          title: '凭证不完整',
          message: '凭证中缺少 access_token，请确认复制的是完整 JSON',
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'bulk-json') {
        toasterRef.current?.show({
          title: '暂不支持批量导入',
          message: '你粘贴的是一个 JSON 数组（多个账号），目前仅支持单个账号导入',
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }
      toasterRef.current?.show({
        title: '凭证格式错误',
        message: '请输入有效的 JSON（建议直接粘贴 QwenCli 导出的原始内容）',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    const accountName = qwenAccountName.trim();

    try {
      await importQwenAccount({
        credential_json: credentialJson,
        is_shared: 0,
        account_name: accountName || undefined,
      });

      toasterRef.current?.show({
        title: '导入成功',
        message: 'Qwen 账号已成功添加',
        variant: 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      toasterRef.current?.show({
        title: '导入失败',
        message: err instanceof Error ? err.message : '导入 Qwen 账号失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const resetState = () => {
    // 清除所有定时器
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    kiroBatchCancelRef.current = true;

    setStep('platform');
    setPlatform('');
    setKiroProvider('');
    setLoginMethod('');
    setKiroLoginMethod('');
    setKiroAwsIdcMethod('');
    setQwenLoginMethod('oauth');
    setKiroImportRefreshToken('');
    setKiroImportClientId('');
    setKiroImportClientSecret('');
    setKiroImportAccountName('');
    setKiroBatchJson('');
    setKiroBatchResults([]);
    setIsKiroBatchImporting(false);
    setAntigravityImportRefreshToken('');
    setQwenCredentialJson('');
    setQwenAccountName('');
    setOauthUrl('');
    setOauthState('');
    setCallbackUrl('');
    setCountdown(600);
    setIsWaitingAuth(false);

    setKiroAwsIdcStatus('idle');
    setKiroAwsIdcState('');
    setKiroAwsIdcUserCode('');
    setKiroAwsIdcVerificationUri('');
    setKiroAwsIdcVerificationUriComplete('');
    setKiroAwsIdcExpiresAt('');
    setKiroAwsIdcIntervalSeconds(5);
    setKiroAwsIdcMessage('');
    setKiroAwsIdcResult(null);
  };

  const handleClose = () => {
    // 立即清理定时器
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    kiroBatchCancelRef.current = true;

    onOpenChange(false);
    // 延迟重置状态，等待动画完成
    setTimeout(resetState, 300);
  };

  return (
    <Drawer
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          // drawer关闭时立即清理
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          kiroBatchCancelRef.current = true;
          // 延迟重置状态
          setTimeout(resetState, 300);
        }
        onOpenChange(isOpen);
      }}
      dismissible={false}
      direction="right"
    >
      <DrawerContent>
        <DrawerHeader className="relative">
          <DrawerTitle>添加账号向导</DrawerTitle>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4 h-8 w-8 rounded-full"
            onClick={handleClose}
          >
            <IconX className="h-4 w-4" />
            <span className="sr-only">关闭</span>
          </Button>
        </DrawerHeader>

        <Toaster ref={toasterRef} defaultPosition="top-right" />

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6 space-y-6">
          {/* 步骤 1: 选择平台 */}
          {step === 'platform' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                你希望添加哪种类型的账号？
              </p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    platform === 'antigravity' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="platform"
                    value="antigravity"
                    checked={platform === 'antigravity'}
                    onChange={(e) => setPlatform(e.target.value as 'antigravity')}
                    className="w-4 h-4"
                  />
                  <img
                    src="/antigravity-logo.png"
                    alt="Antigravity"
                    className="w-10 h-10 rounded-lg"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">Antigravity</h3>
                      <Badge variant="secondary">可用</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      OAuth 授权登录
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    platform === 'kiro' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="platform"
                    value="kiro"
                    checked={platform === 'kiro'}
                    onChange={(e) => setPlatform(e.target.value as 'kiro')}
                    className="w-4 h-4"
                  />
                  <img
                    src="/kiro.png"
                    alt="Kiro"
                    className="w-10 h-10 rounded-lg"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">Kiro</h3>
                      <Badge variant="secondary">可用</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Refresh Token 导入或 AWS-IMA（Builder ID）
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    platform === 'qwen' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="platform"
                    value="qwen"
                    checked={platform === 'qwen'}
                    onChange={(e) => setPlatform(e.target.value as 'qwen')}
                    className="w-4 h-4"
                  />
                  <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                    <Qwen className="size-6 text-foreground" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">Qwen</h3>
                      <Badge variant="secondary">可用</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      QwenCli JSON 凭证导入
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* 步骤 2: 选择 Kiro 授权渠道 */}
          {step === 'kiro_provider' && platform === 'kiro' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                你希望通过哪条链路添加 Kiro 账号？
              </p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroProvider === 'social'
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50'
                  )}
                >
                  <input
                    type="radio"
                    name="kiroProvider"
                    value="social"
                    checked={kiroProvider === 'social'}
                    onChange={() => {
                      setKiroProvider('social');
                      setKiroLoginMethod('oauth');
                      setKiroAwsIdcMethod('');
                    }}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">Kiro OAuth（社交登录）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      支持一键登录（OAuth）或 Refresh Token 导入
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroProvider === 'aws_idc'
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50'
                  )}
                >
                  <input
                    type="radio"
                    name="kiroProvider"
                    value="aws_idc"
                    checked={kiroProvider === 'aws_idc'}
                    onChange={() => {
                      setKiroProvider('aws_idc');
                      setKiroLoginMethod('');
                      setKiroAwsIdcMethod('manual_import');
                    }}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">AWS-IMA（Builder ID / AWS IdC）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      手动导入（refresh_token + client）
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* 选择添加方式 (Qwen) */}
          {step === 'method' && platform === 'qwen' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                选择添加方式
              </p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    qwenLoginMethod === 'oauth' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="qwenLoginMethod"
                    value="oauth"
                    checked={qwenLoginMethod === 'oauth'}
                    onChange={() => setQwenLoginMethod('oauth')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">一键登录（OAuth，推荐）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      打开授权页面后自动轮询完成登录
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    qwenLoginMethod === 'json' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="qwenLoginMethod"
                    value="json"
                    checked={qwenLoginMethod === 'json'}
                    onChange={() => setQwenLoginMethod('json')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">凭证 JSON 导入</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      适合你已经从 QwenCli 导出了 credential_json
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* 选择添加方式 (Kiro Social) */}
          {step === 'method' && platform === 'kiro' && kiroProvider === 'social' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                选择添加方式
              </p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroLoginMethod === 'oauth' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="kiroLoginMethod"
                    value="oauth"
                    checked={kiroLoginMethod === 'oauth'}
                    onChange={() => setKiroLoginMethod('oauth')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">一键登录（OAuth，推荐）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      需要安装并配置 AntiHook 来接管 kiro:// 回调
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroLoginMethod === 'refresh_token' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="kiroLoginMethod"
                    value="refresh_token"
                    checked={kiroLoginMethod === 'refresh_token'}
                    onChange={() => setKiroLoginMethod('refresh_token')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">Refresh Token 导入</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      适合你已经能拿到 RefreshToken 的场景
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {step === 'method' && platform === 'antigravity' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                选择登录方式
              </p>

              <div className="space-y-3">
                {/* 手动提交回调 */}
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    loginMethod === 'manual' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="loginMethod"
                    value="manual"
                    checked={loginMethod === 'manual'}
                    onChange={() => setLoginMethod('manual')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">手动提交回调</h3>
                  </div>
                </label>

                {/* Refresh Token 导入 */}
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    loginMethod === 'refresh_token' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="loginMethod"
                    value="refresh_token"
                    checked={loginMethod === 'refresh_token'}
                    onChange={() => setLoginMethod('refresh_token')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">Refresh Token 导入</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      直接粘贴 refresh_token 导入账号（适合已有 Token）
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* 步骤 5: OAuth 授权 */}
          {step === 'authorize' && (
            <div className="space-y-6">
              {platform === 'qwen' ? (
                <>
                  <div className="space-y-3">
                    <Label htmlFor="qwen-account-name" className="text-base font-semibold">
                      账号名称（可选）
                    </Label>
                    <Input
                      id="qwen-account-name"
                      placeholder="给这个账号起个名字（可不填）"
                      value={qwenAccountName}
                      onChange={(e) => setQwenAccountName(e.target.value)}
                      className="h-12"
                    />
                  </div>

                  {qwenLoginMethod === 'json' ? (
                    <>
                      <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                        <p className="text-xs text-yellow-600 dark:text-yellow-400">
                          <strong>提示</strong>
                          <br />
                          凭证包含敏感 token，请只在可信环境中粘贴，并避免截图/外发。
                        </p>
                      </div>
                      <div className="space-y-3">
                        <Label htmlFor="qwen-credential-json" className="text-base font-semibold">
                          credential_json
                        </Label>
                        <Textarea
                          id="qwen-credential-json"
                          placeholder="在此粘贴 QwenCli 导出的 JSON"
                          value={qwenCredentialJson}
                          onChange={(e) => setQwenCredentialJson(e.target.value)}
                          className="font-mono text-sm min-h-[220px]"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-3">
                        <Label className="text-base font-semibold">OAuth 授权</Label>
                        <p className="text-sm text-muted-foreground">
                          点击生成授权链接后，在打开的页面完成授权；系统会自动轮询并写入账号。
                        </p>
                      </div>

                      <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                        <p className="text-xs text-yellow-600 dark:text-yellow-400">
                          <strong>提示</strong>
                          <br />
                          授权成功后不会在页面展示 token，服务端会安全保存并用于模型调用。
                        </p>
                      </div>

                      <div className="space-y-3">
                        <Label className="text-base font-semibold">授权操作</Label>

                        <div className="flex gap-2">
                          <StatefulButton
                            onClick={handleStartQwenOAuth}
                            disabled={isWaitingAuth && countdown > 0}
                            className="flex-1 cursor-pointer"
                          >
                            {oauthUrl ? '重新生成并打开' : '生成并打开授权页面'}
                          </StatefulButton>

                          <Button
                            onClick={handleOpenOAuthUrl}
                            variant="outline"
                            size="lg"
                            disabled={!oauthUrl}
                          >
                            <IconExternalLink className="size-4 mr-2" />
                            打开
                          </Button>

                          <Button
                            onClick={() => {
                              if (oauthUrl) {
                                navigator.clipboard.writeText(oauthUrl);
                                toasterRef.current?.show({
                                  title: '复制成功',
                                  message: '授权链接已复制到剪贴板',
                                  variant: 'success',
                                  position: 'top-right',
                                });
                              }
                            }}
                            variant="outline"
                            size="lg"
                            disabled={!oauthUrl}
                          >
                            <IconCopy className="size-4 mr-2" />
                            复制
                          </Button>
                        </div>

                        {isWaitingAuth && countdown > 0 && (
                          <p className="text-sm text-muted-foreground">
                            正在等待授权... 剩余 {formatCountdown(countdown)}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </>
              ) : platform === 'antigravity' && loginMethod === 'refresh_token' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">Refresh Token 导入</Label>
                    <p className="text-sm text-muted-foreground">
                      粘贴 refresh_token 后，服务端会校验并自动拉取账号信息与配额。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="antigravity-refresh-token" className="text-base font-semibold">
                      refresh_token
                    </Label>
                    <Textarea
                      id="antigravity-refresh-token"
                      placeholder="在此粘贴 refresh_token"
                      value={antigravityImportRefreshToken}
                      onChange={(e) => setAntigravityImportRefreshToken(e.target.value)}
                      className="font-mono text-sm [field-sizing:fixed] min-h-[96px] max-h-[180px] overflow-y-auto"
                    />
                  </div>
                </>
              ) : platform === 'kiro' && kiroProvider === 'aws_idc' && kiroAwsIdcMethod === 'device_code' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">AWS-IMA（Builder ID）设备码授权</Label>
                    <p className="text-sm text-muted-foreground">
                      生成设备码后在打开的页面完成授权；系统会自动轮询直到成功。
                    </p>
                  </div>

                  <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                    <p className="text-xs text-yellow-600 dark:text-yellow-400">
                      <strong>提示</strong>
                      <br />
                      token 不会回传到前端；服务端仅在短 TTL 状态中暂存并安全落库。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-aws-idc-device-account-name" className="text-base font-semibold">
                      account_name
                    </Label>
                    <Input
                      id="kiro-aws-idc-device-account-name"
                      placeholder="例如：my-builder-id"
                      value={kiroImportAccountName}
                      onChange={(e) => setKiroImportAccountName(e.target.value)}
                      className="h-12"
                    />
                  </div>

                  <div className="space-y-3">
                    <Label className="text-base font-semibold">授权操作</Label>
                    <div className="flex gap-2">
                      <StatefulButton
                        onClick={handleStartKiroAwsIdcDevice}
                        disabled={isWaitingAuth && countdown > 0}
                        className="flex-1 cursor-pointer"
                      >
                        {kiroAwsIdcState ? '重新生成并打开' : '生成并打开授权页面'}
                      </StatefulButton>

                      <Button
                        onClick={() => {
                          if (kiroAwsIdcVerificationUriComplete) {
                            window.open(kiroAwsIdcVerificationUriComplete, '_blank', 'width=600,height=700');
                          }
                        }}
                        variant="outline"
                        size="lg"
                        disabled={!kiroAwsIdcVerificationUriComplete}
                      >
                        <IconExternalLink className="size-4 mr-2" />
                        打开
                      </Button>

                      <Button
                        onClick={() => {
                          if (kiroAwsIdcVerificationUriComplete) {
                            navigator.clipboard.writeText(kiroAwsIdcVerificationUriComplete);
                            toasterRef.current?.show({
                              title: '复制成功',
                              message: '授权链接已复制到剪贴板',
                              variant: 'success',
                              position: 'top-right',
                            });
                          }
                        }}
                        variant="outline"
                        size="lg"
                        disabled={!kiroAwsIdcVerificationUriComplete}
                      >
                        <IconCopy className="size-4 mr-2" />
                        复制
                      </Button>
                    </div>

                    {kiroAwsIdcVerificationUriComplete && (
                      <Input
                        value={kiroAwsIdcVerificationUriComplete}
                        readOnly
                        className="font-mono text-xs h-10"
                      />
                    )}

                    {isWaitingAuth && countdown > 0 && (
                      <p className="text-sm text-muted-foreground">
                        正在等待授权... 剩余 {formatCountdown(countdown)}
                      </p>
                    )}
                  </div>

                  {kiroAwsIdcUserCode && (
                    <div className="space-y-3">
                      <Label className="text-base font-semibold">user_code</Label>
                      <div className="flex gap-2">
                        <Input value={kiroAwsIdcUserCode} readOnly className="h-12 font-mono text-sm" />
                        <Button
                          onClick={() => {
                            navigator.clipboard.writeText(kiroAwsIdcUserCode);
                            toasterRef.current?.show({
                              title: '复制成功',
                              message: 'user_code 已复制到剪贴板',
                              variant: 'success',
                              position: 'top-right',
                            });
                          }}
                          variant="outline"
                          size="lg"
                        >
                          <IconCopy className="size-4 mr-2" />
                          复制
                        </Button>
                      </div>
                      {kiroAwsIdcVerificationUri && (
                        <p className="text-sm text-muted-foreground">
                          如果页面没有自动填充，请在 {kiroAwsIdcVerificationUri} 输入上述 code。
                        </p>
                      )}
                    </div>
                  )}

                  {kiroAwsIdcStatus === 'completed' && (
                    <div className="p-4 bg-green-500/10 rounded-lg border border-green-500/20">
                      <p className="text-sm text-green-700 dark:text-green-400">
                        授权已完成，可以点击右下角“完成”结束流程。
                      </p>
                      {kiroAwsIdcResult?.account_id && (
                        <p className="text-xs text-muted-foreground mt-2">
                          account_id: <span className="font-mono">{kiroAwsIdcResult.account_id}</span>
                        </p>
                      )}
                    </div>
                  )}

                  {(kiroAwsIdcStatus === 'error' || kiroAwsIdcStatus === 'expired' || countdown === 0) && (
                    <div className="p-4 bg-destructive/10 rounded-lg border border-destructive/20">
                      <p className="text-sm text-destructive text-center">
                        {kiroAwsIdcMessage || '授权已结束，请返回重新开始'}
                      </p>
                    </div>
                  )}
                </>
              ) : platform === 'kiro' && kiroProvider === 'aws_idc' && kiroAwsIdcMethod === 'manual_import' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">AWS-IMA（Builder ID）手动导入</Label>
                    <p className="text-sm text-muted-foreground">
                      提供 refresh_token + client_id + client_secret；服务端不会回传 token。
                    </p>
                  </div>

                  <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                    <p className="text-xs text-yellow-600 dark:text-yellow-400">
                      <strong>提示</strong>
                      <br />
                      refresh_token / client_secret 属于敏感信息，请只在可信环境中粘贴，并避免截图/外发。
                      <br />
                      <br />
                      <strong>从 AWS SSO 缓存提取参数</strong>
                      <br />
                      1. 前往 <span className="font-mono">~/.aws/sso/cache</span>（Windows：<span className="font-mono">%USERPROFILE%\.aws\sso\cache</span>）
                      <br />
                      2. 打开目录下最近更新的两个 JSON 文件
                      <br />
                      3. 在 JSON 中搜索 <span className="font-mono">refreshToken</span> / <span className="font-mono">clientId</span> / <span className="font-mono">clientSecret</span>
                      <br />
                      4. 将其值分别填写到下方的 <span className="font-mono">refresh_token</span> / <span className="font-mono">client_id</span> / <span className="font-mono">client_secret</span>
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-aws-idc-import-account-name" className="text-base font-semibold">
                      account_name（必填）
                    </Label>
                    <Input
                      id="kiro-aws-idc-import-account-name"
                      placeholder="例如：my-builder-id"
                      value={kiroImportAccountName}
                      onChange={(e) => setKiroImportAccountName(e.target.value)}
                      className="h-12"
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="kiro-client-id" className="text-base font-semibold">
                        client_id
                      </Label>
                      <Input
                        id="kiro-client-id"
                        placeholder="请输入 client_id"
                        value={kiroImportClientId}
                        onChange={(e) => setKiroImportClientId(e.target.value)}
                        className="h-12 font-mono text-sm"
                        autoComplete="off"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="kiro-client-secret" className="text-base font-semibold">
                        client_secret
                      </Label>
                      <Input
                        id="kiro-client-secret"
                        placeholder="请输入 client_secret"
                        value={kiroImportClientSecret}
                        onChange={(e) => setKiroImportClientSecret(e.target.value)}
                        className="h-12 font-mono text-sm"
                        autoComplete="off"
                        type="password"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-refresh-token" className="text-base font-semibold">
                      refresh_token
                    </Label>
                    <Textarea
                      id="kiro-refresh-token"
                      placeholder="在此粘贴 refresh_token"
                      value={kiroImportRefreshToken}
                      onChange={(e) => setKiroImportRefreshToken(e.target.value)}
                      className="font-mono text-sm [field-sizing:fixed] min-h-[80px] max-h-[160px] overflow-y-auto"
                    />
                  </div>
                </>
              ) : platform === 'kiro' && kiroProvider === 'social' && kiroLoginMethod === 'oauth' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">OAuth 授权</Label>
                    <p className="text-sm text-muted-foreground">
                      点击生成并打开授权页面后完成登录；浏览器会跳转到 kiro:// 回调，由 AntiHook 转发到服务端并自动落库。
                    </p>
                  </div>

                  <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                    <p className="text-xs text-yellow-600 dark:text-yellow-400">
                      <strong>提示</strong>
                      <br />
                      未安装 AntiHook 时，kiro:// 回调不会被转发，状态会一直停留在等待中。
                    </p>
                  </div>

                  <div className="p-4 bg-muted/30 border border-border rounded-lg space-y-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">AntiHook 配置</p>
                      <p className="text-xs text-muted-foreground">
                        AntiHook 首次运行会提示配置 <span className="font-mono">KIRO_SERVER_URL</span>（建议填当前站点地址）。
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <Input
                        value={currentOrigin}
                        readOnly
                        className="font-mono text-xs h-10"
                        placeholder="当前站点地址"
                      />
                      <Button
                        onClick={() => {
                          if (!currentOrigin) return;
                          navigator.clipboard.writeText(currentOrigin);
                          toasterRef.current?.show({
                            title: '复制成功',
                            message: 'KIRO_SERVER_URL 已复制到剪贴板',
                            variant: 'success',
                            position: 'top-right',
                          });
                        }}
                        variant="outline"
                        size="lg"
                        disabled={!currentOrigin}
                      >
                        <IconCopy className="size-4 mr-2" />
                        复制
                      </Button>
                    </div>

                    <div className="space-y-2">
                      <p className="text-sm font-medium">下载 AntiHook</p>

                      {recommendedAntiHookUrl ? (
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="lg" className="flex-1 cursor-pointer min-w-[160px]">
                            <a href={recommendedAntiHookUrl} download>
                              下载（推荐：{recommendedAntiHook?.label}）
                            </a>
                          </Button>

                          <Button
                            onClick={() => setShowAntiHookDownloads((v) => !v)}
                            variant="outline"
                            size="lg"
                          >
                            {showAntiHookDownloads ? '收起版本列表' : '选择其他版本'}
                          </Button>
                        </div>
                      ) : (
                        <Button onClick={() => setShowAntiHookDownloads(true)} variant="outline" size="lg">
                          选择版本下载
                        </Button>
                      )}

                      {showAntiHookDownloads && (
                        <div className="grid grid-cols-2 gap-2">
                          {ANTIHOOK_DOWNLOAD_OPTIONS.map((item) => {
                            const href = `/antihook/${getAntiHookAssetName(item.os, item.arch)}`;
                            const isRecommended =
                              recommendedAntiHook?.os === item.os && recommendedAntiHook?.arch === item.arch;

                            return (
                              <Button
                                key={`${item.os}-${item.arch}`}
                                asChild
                                variant={isRecommended ? 'secondary' : 'outline'}
                                size="lg"
                              >
                                <a href={href} download>
                                  {item.label}
                                </a>
                              </Button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label className="text-base font-semibold">授权操作</Label>

                    <div className="flex flex-wrap gap-2">
                      <StatefulButton
                        onClick={() => handleStartKiroOAuth('Google')}
                        disabled={isWaitingAuth && countdown > 0}
                        className="flex-1 cursor-pointer min-w-[140px]"
                      >
                        {oauthUrl ? '重新生成（Google）' : '生成并打开（Google）'}
                      </StatefulButton>

                      <StatefulButton
                        onClick={() => handleStartKiroOAuth('Github')}
                        disabled={isWaitingAuth && countdown > 0}
                        className="flex-1 cursor-pointer min-w-[140px]"
                      >
                        {oauthUrl ? '重新生成（GitHub）' : '生成并打开（GitHub）'}
                      </StatefulButton>

                      <Button
                        onClick={handleOpenOAuthUrl}
                        variant="outline"
                        size="lg"
                        disabled={!oauthUrl}
                      >
                        <IconExternalLink className="size-4 mr-2" />
                        打开
                      </Button>

                      <Button
                        onClick={() => {
                          if (oauthUrl) {
                            navigator.clipboard.writeText(oauthUrl);
                            toasterRef.current?.show({
                              title: '复制成功',
                              message: '授权链接已复制到剪贴板',
                              variant: 'success',
                              position: 'top-right',
                            });
                          }
                        }}
                        variant="outline"
                        size="lg"
                        disabled={!oauthUrl}
                      >
                        <IconCopy className="size-4 mr-2" />
                        复制
                      </Button>
                    </div>

                    {oauthUrl && (
                      <Input
                        value={oauthUrl}
                        readOnly
                        className="font-mono text-xs h-10"
                      />
                    )}

                    {isWaitingAuth && countdown > 0 && (
                      <p className="text-sm text-muted-foreground">
                        正在等待授权... 剩余 {formatCountdown(countdown)}
                      </p>
                    )}
                  </div>
                </>
              ) : platform === 'kiro' && kiroProvider === 'social' && kiroLoginMethod === 'refresh_token' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">Refresh Token 导入</Label>
                    <p className="text-sm text-muted-foreground">
                      粘贴 refresh_token 后，服务端会校验并自动拉取账号信息。
                    </p>
                  </div>

                  <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                    <p className="text-xs text-yellow-600 dark:text-yellow-400">
                      <strong>获取 RefreshToken（Kiro Web）</strong>
                      <br />
                      1. 打开{' '}
                      <a
                        href="https://app.kiro.dev/account/usage"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono underline underline-offset-2"
                      >
                        https://app.kiro.dev/account/usage
                      </a>{' '}
                      并登录
                      <br />
                      2. 按 <span className="font-mono">F12</span> 打开开发者工具
                      <br />
                      3. 点击 应用/Application 标签页
                      <br />
                      4. 左侧展开 存储/Storage → Cookie
                      <br />
                      5. 选择{' '}
                      <a
                        href="https://app.kiro.dev"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono underline underline-offset-2"
                      >
                        https://app.kiro.dev
                      </a>
                      <br />
                      6. 找到名称为 <span className="font-mono">RefreshToken</span> 的条目，复制其 值/Value
                      <br />
                      <br />
                      RefreshToken 属于敏感信息，请只在可信环境中粘贴，并避免截图/外发。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-account-name" className="text-base font-semibold">
                      账号名称（可选）
                    </Label>
                    <Input
                      id="kiro-account-name"
                      placeholder="给这个账号起个名字（可不填）"
                      value={kiroImportAccountName}
                      onChange={(e) => setKiroImportAccountName(e.target.value)}
                      className="h-12"
                    />
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-refresh-token" className="text-base font-semibold">
                      refresh_token
                    </Label>
                    <Textarea
                      id="kiro-refresh-token"
                      placeholder="在此粘贴 refresh_token"
                      value={kiroImportRefreshToken}
                      onChange={(e) => setKiroImportRefreshToken(e.target.value)}
                      className="font-mono text-sm [field-sizing:fixed] min-h-[80px] max-h-[160px] overflow-y-auto"
                    />
                  </div>

                  <div className="border-t pt-6 space-y-3">
                    <Label className="text-base font-semibold">批量导入（JSON）</Label>
                    <p className="text-sm text-muted-foreground">
                      支持 JSON 数组，或多个 JSON 对象用逗号分隔；每一项里随便一个字段的 value 是 RefreshToken 即可（导入顺序按 JSON 顺序）。
                    </p>

                    <Textarea
                      id="kiro-refresh-token-batch"
                      placeholder='示例：[{\"RT\":\"xxxx\"},{\"随便写\":\"yyyy\"}]'
                      value={kiroBatchJson}
                      onChange={(e) => setKiroBatchJson(e.target.value)}
                      className="font-mono text-sm [field-sizing:fixed] min-h-[140px] max-h-[260px] overflow-y-auto"
                    />

                    <Button
                      onClick={handleBatchImportKiroAccounts}
                      disabled={!kiroBatchJson.trim() || isKiroBatchImporting}
                      className="w-full cursor-pointer"
                    >
                      {isKiroBatchImporting ? '批量导入中...' : '批量解析并导入'}
                    </Button>
                  </div>

                  {kiroBatchResults.length > 0 && (
                    <div className="space-y-3">
                      <Label className="text-base font-semibold">导入清单</Label>
                      <div className="space-y-2">
                        {kiroBatchResults.map((r) => (
                          <div
                            key={r.index}
                            className="flex items-start justify-between gap-3 rounded-lg border p-3"
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <p className="text-sm">
                                <span className="font-mono text-xs text-muted-foreground mr-2">
                                  #{r.index}
                                </span>
                                <span className={r.email ? '' : 'text-muted-foreground'}>
                                  {r.email || '（未获取邮箱）'}
                                </span>
                              </p>
                              {typeof r.available === 'number' && (
                                <p className="text-xs text-muted-foreground">
                                  余额（available）：<span className="font-mono">{r.available}</span>
                                </p>
                              )}
                              {r.message && (
                                <p className="text-xs text-muted-foreground">
                                  {r.message}
                                </p>
                              )}
                            </div>

                            <Badge
                              variant={
                                r.status === 'success'
                                  ? 'secondary'
                                  : r.status === 'error'
                                  ? 'destructive'
                                  : 'outline'
                              }
                            >
                              {r.status === 'success'
                                ? '成功'
                                : r.status === 'error'
                                ? '失败'
                                : '处理中'}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : platform === 'kiro' ? (
                <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <p className="text-sm text-yellow-600 dark:text-yellow-400">
                    请返回选择 Kiro 授权渠道与添加方式
                  </p>
                </div>
              ) : (
                // Antigravity账号 - 手动提交回调
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">账号授权</Label>
                    <p className="text-sm text-muted-foreground">
                      请完成 OAuth 授权。
                    </p>
                    <div className="flex gap-2">
                      <Button
                        onClick={handleOpenOAuthUrl}
                        className="flex-1"
                        size="lg"
                        disabled={!oauthUrl}
                      >
                        <IconExternalLink className="size-4 mr-2" />
                        打开授权页面
                      </Button>
                      <Button
                        onClick={() => {
                          if (oauthUrl) {
                            navigator.clipboard.writeText(oauthUrl);
                            toasterRef.current?.show({
                              title: '复制成功',
                              message: '授权链接已复制到剪贴板',
                              variant: 'success',
                              position: 'top-right',
                            });
                          }
                        }}
                        variant="outline"
                        size="lg"
                        disabled={!oauthUrl}
                      >
                        <IconCopy className="size-4 mr-2" />
                        复制链接
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="callback-url" className="text-base font-semibold">
                      回调地址
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      请粘贴完成授权后浏览器地址栏的完整 URL。
                    </p>
                    <Input
                      id="callback-url"
                      placeholder="在此处粘贴回调地址"
                      value={callbackUrl}
                      onChange={(e) => setCallbackUrl(e.target.value)}
                      className="font-mono text-sm h-12"
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <DrawerFooter className="flex flex-row gap-2">
          {step !== 'platform' && (
            <Button
              variant="outline"
              onClick={handleBack}
              className="flex-1 cursor-pointer"
              disabled={(platform === 'kiro' || platform === 'qwen') && isWaitingAuth && countdown > 0}
            >
              上一步
            </Button>
          )}

          {step === 'authorize' ? (
            platform === 'qwen' ? (
              qwenLoginMethod === 'json' ? (
                <StatefulButton
                  onClick={handleImportQwenAccount}
                  disabled={!qwenCredentialJson.trim()}
                  className="flex-1 cursor-pointer"
                >
                  完成导入
                </StatefulButton>
              ) : (
                <Button
                  onClick={handleClose}
                  disabled={isWaitingAuth && countdown > 0}
                  className="flex-1 cursor-pointer"
                >
                  {isWaitingAuth && countdown > 0 ? '等待授权中...' : '关闭'}
                </Button>
              )
            ) : platform === 'kiro' ? (
              kiroProvider === 'aws_idc' ? (
                kiroAwsIdcMethod === 'manual_import' ? (
                  <StatefulButton
                    onClick={handleImportKiroAwsIdcAccount}
                    disabled={
                      !kiroImportAccountName.trim() ||
                      !kiroImportRefreshToken.trim() ||
                      !kiroImportClientId.trim() ||
                      !kiroImportClientSecret.trim()
                    }
                    className="flex-1 cursor-pointer"
                  >
                    完成导入
                  </StatefulButton>
                ) : kiroAwsIdcMethod === 'device_code' ? (
                  kiroAwsIdcStatus === 'completed' ? (
                    <Button
                      onClick={handleFinishKiroAwsIdcDevice}
                      className="flex-1 cursor-pointer"
                    >
                      完成
                    </Button>
                  ) : (
                    <Button
                      onClick={handleClose}
                      disabled={isWaitingAuth && countdown > 0}
                      className="flex-1 cursor-pointer"
                    >
                      {isWaitingAuth && countdown > 0 ? '等待授权中...' : '关闭'}
                    </Button>
                  )
                ) : (
                  <Button
                    onClick={handleClose}
                    className="flex-1 cursor-pointer"
                  >
                    关闭
                  </Button>
                )
              ) : kiroProvider === 'social' ? (
                kiroLoginMethod === 'refresh_token' ? (
                  <StatefulButton
                    onClick={handleImportKiroAccount}
                    disabled={!kiroImportRefreshToken.trim()}
                    className="flex-1 cursor-pointer"
                  >
                    完成导入
                  </StatefulButton>
                ) : (
                  <Button
                    onClick={handleClose}
                    disabled={isWaitingAuth && countdown > 0}
                    className="flex-1 cursor-pointer"
                  >
                    {isWaitingAuth && countdown > 0 ? '等待授权中...' : '关闭'}
                  </Button>
                )
              ) : (
                <Button
                  onClick={handleClose}
                  className="flex-1 cursor-pointer"
                >
                  关闭
                </Button>
              )
            ) : (
              loginMethod === 'refresh_token' ? (
                <StatefulButton
                  onClick={handleImportAntigravityAccount}
                  disabled={!antigravityImportRefreshToken.trim()}
                  className="flex-1 cursor-pointer"
                >
                  完成导入
                </StatefulButton>
              ) : (
                // Antigravity账号需要提交回调
                <StatefulButton
                  onClick={handleSubmitCallback}
                  disabled={!callbackUrl.trim()}
                  className="flex-1 cursor-pointer"
                >
                  完成添加
                </StatefulButton>
              )
            )
          ) : step === 'method' ? (
            <Button
              onClick={handleContinue}
              disabled={
                platform === 'antigravity' ? !loginMethod :
                platform === 'qwen' ? !qwenLoginMethod :
                kiroProvider === 'social' ? !kiroLoginMethod :
                kiroProvider === 'aws_idc' ? !kiroAwsIdcMethod :
                true
              }
              className="flex-1 cursor-pointer"
            >
              继续
            </Button>
          ) : (
            <Button
              onClick={handleContinue}
              disabled={
                (step === 'platform' && !platform) ||
                (step === 'kiro_provider' && !kiroProvider)
              }
              className="flex-1 cursor-pointer"
            >
              继续
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
