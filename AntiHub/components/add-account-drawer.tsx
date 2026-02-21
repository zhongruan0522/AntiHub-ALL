'use client';

import { useState, useRef, useEffect } from 'react';
import {
  createKiroAccount,
  getKiroAccountBalance,
  getKiroOAuthAuthorizeUrl,
  getOAuthAuthorizeUrl,
  pollKiroOAuthStatus,
  submitOAuthCallback,
  getCodexOAuthAuthorizeUrl,
  submitCodexOAuthCallback,
  importCodexAccount,
  getQwenOAuthAuthorizeUrl,
  pollQwenOAuthStatus,
  importAccountByRefreshToken,
  importQwenAccount,
  kiroAwsIdcDeviceAuthorize,
  kiroAwsIdcDeviceStatus,
  importKiroAwsIdcAccount,
  importKiroEnterpriseAccount,
  batchImportKiroEnterpriseAccounts,
  getGeminiCLIOAuthAuthorizeUrl,
  submitGeminiCLIOAuthCallback,
  importGeminiCLIAccount,
  createZaiTTSAccount,
  createZaiImageAccount,
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
import { Gemini, OpenAI, Qwen } from '@lobehub/icons';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Toaster, { ToasterRef, showToast } from '@/components/ui/toast';

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

type AwsIdcJsonImportStatus = 'pending' | 'success' | 'error';

interface AwsIdcJsonImportResult {
  index: number;
  status: AwsIdcJsonImportStatus;
  accountName?: string;
  message?: string;
}

type EnterpriseJsonImportStatus = 'pending' | 'success' | 'error';

interface EnterpriseJsonImportResult {
  index: number;
  status: EnterpriseJsonImportStatus;
  accountName?: string;
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
  { label: 'macOS Intel', os: 'darwin', arch: 'amd64' },
  { label: 'macOS Apple Silicon', os: 'darwin', arch: 'arm64' },
  { label: 'Linux x64', os: 'linux', arch: 'amd64' },
  { label: 'Linux ARM64', os: 'linux', arch: 'arm64' },
];

const getAntiHookAssetName = (os: AntiHookOS, arch: AntiHookArch) => {
  if (os === 'windows') return `antihook-windows-${arch}.exe`;
  if (os === 'darwin') return 'antihook-darwin-universal.dmg';
  return `antihook-linux-${arch}.AppImage`;
};

export function AddAccountDrawer({ open, onOpenChange, onSuccess }: AddAccountDrawerProps) {
  const toasterRef = useRef<ToasterRef>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const kiroBatchCancelRef = useRef(false);
  const kiroAwsIdcJsonCancelRef = useRef(false);
  const kiroEnterpriseJsonCancelRef = useRef(false);
  const [step, setStep] = useState<
    'platform' | 'kiro_provider' | 'method' | 'authorize'
  >('platform');
  const [platform, setPlatform] = useState<'antigravity' | 'kiro' | 'qwen' | 'codex' | 'gemini' | 'zai-tts' | 'zai-image' | ''>('');
  const [kiroProvider, setKiroProvider] = useState<'social' | 'aws_idc' | 'enterprise' | ''>('');
  const [loginMethod, setLoginMethod] = useState<'manual' | 'refresh_token' | ''>(''); // Antigravity 登录方式
  const [kiroLoginMethod, setKiroLoginMethod] = useState<'oauth' | 'refresh_token' | ''>('');
  const [kiroAwsIdcMethod, setKiroAwsIdcMethod] = useState<
    'device_code' | 'manual_import' | 'json_import' | ''
  >('');
  const [kiroEnterpriseMethod, setKiroEnterpriseMethod] = useState<'manual_import' | 'json_import' | ''>('');
  const [kiroEnterpriseRefreshToken, setKiroEnterpriseRefreshToken] = useState('');
  const [kiroEnterpriseClientId, setKiroEnterpriseClientId] = useState('');
  const [kiroEnterpriseClientSecret, setKiroEnterpriseClientSecret] = useState('');
  const [kiroEnterpriseRegion, setKiroEnterpriseRegion] = useState('us-east-1');
  const [kiroEnterpriseJsonText, setKiroEnterpriseJsonText] = useState('');
  const [kiroEnterpriseJsonResults, setKiroEnterpriseJsonResults] = useState<EnterpriseJsonImportResult[]>([]);
  const [isKiroEnterpriseJsonImporting, setIsKiroEnterpriseJsonImporting] = useState(false);
  const [kiroAwsIdcRegion, setKiroAwsIdcRegion] = useState('us-east-1');
  const [qwenLoginMethod, setQwenLoginMethod] = useState<'oauth' | 'json'>('oauth');
  const [codexLoginMethod, setCodexLoginMethod] = useState<'oauth' | 'json'>('oauth');
  const [geminiCliLoginMethod, setGeminiCliLoginMethod] = useState<'oauth' | 'json'>('oauth');
  const [geminiCliCredentialJson, setGeminiCliCredentialJson] = useState('');
  const [kiroImportRefreshToken, setKiroImportRefreshToken] = useState('');
  const [kiroImportClientId, setKiroImportClientId] = useState('');
  const [kiroImportClientSecret, setKiroImportClientSecret] = useState('');
  const [kiroAwsIdcUserId, setKiroAwsIdcUserId] = useState('');
  const [kiroAwsIdcJsonText, setKiroAwsIdcJsonText] = useState('');
  const [kiroAwsIdcJsonFieldMap, setKiroAwsIdcJsonFieldMap] = useState<{
    refresh_token: string;
    client_id: string;
    client_secret: string;
    region: string;
  }>({
    refresh_token: '',
    client_id: '',
    client_secret: '',
    region: '',
  });
  const [kiroAwsIdcJsonResults, setKiroAwsIdcJsonResults] = useState<AwsIdcJsonImportResult[]>([]);
  const [isKiroAwsIdcJsonImporting, setIsKiroAwsIdcJsonImporting] = useState(false);
  const [antigravityImportRefreshToken, setAntigravityImportRefreshToken] = useState('');
  const [qwenCredentialJson, setQwenCredentialJson] = useState('');
  const [qwenAccountName, setQwenAccountName] = useState('');
  const [codexCredentialJson, setCodexCredentialJson] = useState('');
  const [codexAccountName, setCodexAccountName] = useState('');
  const [zaiTtsAccountName, setZaiTtsAccountName] = useState('');
  const [zaiTtsUserId, setZaiTtsUserId] = useState('');
  const [zaiTtsToken, setZaiTtsToken] = useState('');
  const [zaiTtsVoiceId, setZaiTtsVoiceId] = useState('system_001');
  const [zaiImageAccountName, setZaiImageAccountName] = useState('');
  const [zaiImageToken, setZaiImageToken] = useState('');
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
      if (platform === 'zai-tts' || platform === 'zai-image') {
        setStep('authorize');
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
        setKiroAwsIdcRegion('us-east-1');
        setKiroAwsIdcJsonText('');
        setKiroAwsIdcJsonFieldMap({
          refresh_token: '',
          client_id: '',
          client_secret: '',
          region: '',
        });
        setKiroAwsIdcJsonResults([]);
        setIsKiroAwsIdcJsonImporting(false);
        setCountdown(600);
        setIsWaitingAuth(false);
        setStep('method');
        return;
      }

      if (kiroProvider === 'enterprise') {
        setKiroEnterpriseMethod('manual_import');
        setKiroEnterpriseRefreshToken('');
        setKiroEnterpriseClientId('');
        setKiroEnterpriseClientSecret('');
        setKiroEnterpriseRegion('us-east-1');
        setKiroEnterpriseJsonText('');
        setKiroEnterpriseJsonResults([]);
        setIsKiroEnterpriseJsonImporting(false);
        setStep('method');
        return;
      }

      setStep('method');
    } else if (step === 'method') {
      if (platform === 'kiro') {
        if (kiroProvider === 'social' && !kiroLoginMethod) {
          toasterRef.current?.show({
            title: '选择方式',
            message: '请选择添加方式',
            variant: 'warning',
            position: 'top-right',
          });
          return;
        }

        if (kiroProvider === 'aws_idc' && !kiroAwsIdcMethod) {
          toasterRef.current?.show({
            title: '选择方式',
            message: '请选择导入方式',
            variant: 'warning',
            position: 'top-right',
          });
          return;
        }

        if (kiroProvider === 'enterprise' && !kiroEnterpriseMethod) {
          toasterRef.current?.show({
            title: '选择方式',
            message: '请选择导入方式',
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

      if (platform === 'codex') {
        if (!codexLoginMethod) {
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
        setCallbackUrl('');
        setStep('authorize');
        return;
      }

      if (platform === 'gemini') {
        if (!geminiCliLoginMethod) {
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
        setCallbackUrl('');
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
      setKiroEnterpriseMethod('');
    } else if (step === 'method') {
      if (platform === 'kiro') {
        setStep('kiro_provider');
        setKiroLoginMethod('');
        setKiroAwsIdcMethod('');
        setKiroEnterpriseMethod('');
      } else {
        setStep('platform');
        if (platform === 'antigravity') {
          setLoginMethod('');
        }
        if (platform === 'codex') {
          setCodexLoginMethod('oauth');
        }
        if (platform === 'gemini') {
          setGeminiCliLoginMethod('oauth');
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

      kiroAwsIdcJsonCancelRef.current = true;
      setIsKiroAwsIdcJsonImporting(false);
      kiroEnterpriseJsonCancelRef.current = true;
      setIsKiroEnterpriseJsonImporting(false);

      if (platform === 'qwen') {
        setStep('method');
        setQwenLoginMethod('oauth');
      } else if (platform === 'zai-tts' || platform === 'zai-image') {
        setStep('platform');
      } else if (platform === 'codex') {
        setStep('method');
        setCodexLoginMethod('oauth');
      } else if (platform === 'gemini') {
        setStep('method');
        setGeminiCliLoginMethod('oauth');
      } else if (platform === 'antigravity') {
        setStep('method');
      } else if (platform === 'kiro') {
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
      setCodexCredentialJson('');
      setCodexAccountName('');

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

  const tryWarmupKiroAccountInfo = async (accountId: string) => {
    if (!accountId) return;
    try {
      await getKiroAccountBalance(accountId, { refresh: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '刷新账号信息失败（账号已添加）';
      toasterRef.current?.show({
        title: '同步账号信息失败',
        message,
        variant: 'warning',
        position: 'top-right',
      });
    }
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
          const accountId = (result.data as any)?.account_id;
          if (typeof accountId === 'string' && accountId.trim()) {
            await tryWarmupKiroAccountInfo(accountId.trim());
          }

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

    try {
      const created = await createKiroAccount({
        refresh_token: refreshToken,
        auth_method: 'Social',
        is_shared: 0,
      });

      if (created?.account_id) {
        await tryWarmupKiroAccountInfo(created.account_id);
      }

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
          const balance = await getKiroAccountBalance(account.account_id, { refresh: true });
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
    const refreshToken = kiroImportRefreshToken.trim();
    const clientId = kiroImportClientId.trim();
    const clientSecret = kiroImportClientSecret.trim();
    const region = kiroAwsIdcRegion.trim();
    const userId = kiroAwsIdcUserId.trim();

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
      const created = await importKiroAwsIdcAccount({
        refreshToken,
        clientId,
        clientSecret,
        userId: userId || undefined,
        isShared: 0,
        region: region || undefined,
      });

      if (created?.account_id) {
        await tryWarmupKiroAccountInfo(created.account_id);
      }

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

  const handleImportKiroEnterpriseAccount = async () => {
    const refreshToken = kiroEnterpriseRefreshToken.trim();
    const clientId = kiroEnterpriseClientId.trim();
    const clientSecret = kiroEnterpriseClientSecret.trim();
    const region = kiroEnterpriseRegion.trim();

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
      const created = await importKiroEnterpriseAccount({
        refreshToken,
        clientId,
        clientSecret,
        region: region || 'us-east-1',
        isShared: 0,
      });

      if (created?.account_id) {
        await tryWarmupKiroAccountInfo(created.account_id);
      }

      toasterRef.current?.show({
        title: '导入成功',
        message: '企业账户（Enterprise）已成功添加',
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
        message: err instanceof Error ? err.message : '导入企业账户失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleImportKiroEnterpriseJson = async () => {
    const raw = kiroEnterpriseJsonText.replace(/^\uFEFF/, '').trim();
    if (!raw) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴 JSON 内容',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    if (isKiroEnterpriseJsonImporting) return;

    kiroEnterpriseJsonCancelRef.current = false;

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
          message: '请输入有效 JSON（支持 JSON 对象或 JSON 数组；也支持多个对象用逗号分隔）',
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

    const toStringValue = (value: unknown) => {
      if (typeof value === 'string') return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return '';
    };

    const pickValue = (obj: Record<string, unknown>, keys: string[]) => {
      for (const key of keys) {
        const v = toStringValue(obj[key]);
        if (v) return v;
      }
      return '';
    };

    setKiroEnterpriseJsonResults(
      items.map((_, idx) => ({
        index: idx + 1,
        status: 'pending' as const,
        message: '等待导入',
      }))
    );
    setIsKiroEnterpriseJsonImporting(true);

    let successCount = 0;
    let failedCount = 0;

    const updateResult = (index: number, patch: Partial<EnterpriseJsonImportResult>) => {
      setKiroEnterpriseJsonResults((prev) =>
        prev.map((r) => (r.index === index ? { ...r, ...patch } : r))
      );
    };

    for (let idx = 0; idx < items.length; idx++) {
      if (kiroEnterpriseJsonCancelRef.current) break;

      const index = idx + 1;
      const item = items[idx];

      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        failedCount++;
        updateResult(index, { status: 'error', message: '仅支持 JSON 对象（或对象数组）' });
        continue;
      }

      const obj = item as Record<string, unknown>;

      const refreshToken = pickValue(obj, [
        'refresh_token', 'refreshToken', 'RefreshToken', 'rt', 'RT',
      ]);
      const clientId = pickValue(obj, [
        'client_id', 'clientId', 'cid', 'client-id',
      ]);
      const clientSecret = pickValue(obj, [
        'client_secret', 'clientSecret', 'csecret', 'client-secret',
      ]);
      const authRegion = pickValue(obj, [
        'auth_region',
        'authRegion',
        'sso_region',
        'ssoRegion',
        'oidc_region',
        'oidcRegion',
      ]);
      const apiRegion = pickValue(obj, ['api_region', 'apiRegion']);
      const region = pickValue(obj, ['region', 'aws_region', 'awsRegion', 'region-id', 'region_id']);
      const effectiveRegion = authRegion || region;

      if (!refreshToken || !clientId || !clientSecret) {
        failedCount++;
        updateResult(index, {
          status: 'error',
          message: '缺少 refresh_token / client_id / client_secret',
        });
        continue;
      }

      updateResult(index, { status: 'pending', message: '导入中...' });

      try {
        const account = await importKiroEnterpriseAccount({
          refreshToken,
          clientId,
          clientSecret,
          region: effectiveRegion || 'us-east-1',
          authRegion: authRegion || undefined,
          apiRegion: apiRegion || undefined,
          isShared: 0,
        });

        if (account?.account_id) {
          try {
            await getKiroAccountBalance(account.account_id, { refresh: true });
          } catch {}
        }

        successCount++;
        updateResult(index, {
          status: 'success',
          accountName: account.account_name || undefined,
          message: '成功',
        });
      } catch (err) {
        failedCount++;
        updateResult(index, {
          status: 'error',
          message: err instanceof Error ? err.message : '导入失败',
        });
      }
    }

    setIsKiroEnterpriseJsonImporting(false);

    if (kiroEnterpriseJsonCancelRef.current) return;

    if (successCount > 0) {
      window.dispatchEvent(new CustomEvent('accountAdded'));
      onSuccess?.();
    }

    // Single success: close drawer
    if (items.length === 1 && successCount === 1) {
      toasterRef.current?.show({
        title: '导入成功',
        message: '企业账户（Enterprise）已成功添加',
        variant: 'success',
        position: 'top-right',
      });
      onOpenChange(false);
      resetState();
      return;
    }

    const variant =
      successCount === 0 ? 'error' : failedCount > 0 ? 'warning' : 'success';

    toasterRef.current?.show({
      title: 'JSON 导入完成',
      message: `成功 ${successCount}，失败 ${failedCount}`,
      variant,
      position: 'top-right',
    });
  };

  const handleImportKiroAwsIdcJson = async () => {
    const raw = kiroAwsIdcJsonText.replace(/^\uFEFF/, '').trim();
    if (!raw) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴 JSON 内容',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    if (isKiroAwsIdcJsonImporting) return;

    kiroAwsIdcJsonCancelRef.current = false;

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
          message: '请输入有效 JSON（支持 JSON 对象或 JSON 数组；也支持多个对象用逗号分隔）',
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

    const toStringValue = (value: unknown) => {
      if (typeof value === 'string') return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return '';
    };

    const pickValue = (
      obj: Record<string, unknown>,
      mappedKeys: string,
      fallbacks: string[]
    ) => {
      const keys = mappedKeys
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      const candidates = keys.length > 0 ? keys : fallbacks;
      for (const key of candidates) {
        const v = toStringValue(obj[key]);
        if (v) return v;
      }
      return '';
    };

    setKiroAwsIdcJsonResults(
      items.map((_, idx) => ({
        index: idx + 1,
        status: 'pending',
        message: '等待导入',
      }))
    );
    setIsKiroAwsIdcJsonImporting(true);

    let successCount = 0;
    let failedCount = 0;

    const updateResult = (index: number, patch: Partial<AwsIdcJsonImportResult>) => {
      setKiroAwsIdcJsonResults((prev) =>
        prev.map((r) => (r.index === index ? { ...r, ...patch } : r))
      );
    };

    for (let idx = 0; idx < items.length; idx++) {
      if (kiroAwsIdcJsonCancelRef.current) break;

      const index = idx + 1;
      const item = items[idx];

      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        failedCount++;
        updateResult(index, { status: 'error', message: '仅支持 JSON 对象（或对象数组）' });
        continue;
      }

      const obj = item as Record<string, unknown>;

      const refreshToken = pickValue(obj, kiroAwsIdcJsonFieldMap.refresh_token, [
        'refresh_token',
        'refreshToken',
        'RefreshToken',
        'rt',
        'RT',
      ]);
      const clientId = pickValue(obj, kiroAwsIdcJsonFieldMap.client_id, [
        'client_id',
        'clientId',
        'cid',
        'client-id',
      ]);
      const clientSecret = pickValue(obj, kiroAwsIdcJsonFieldMap.client_secret, [
        'client_secret',
        'clientSecret',
        'csecret',
        'client-secret',
      ]);
      const regionFromItem = pickValue(obj, kiroAwsIdcJsonFieldMap.region, [
        'region',
        'aws_region',
        'awsRegion',
        'region-id',
        'region_id',
      ]);

      if (!refreshToken || !clientId || !clientSecret) {
        failedCount++;
        updateResult(index, {
          status: 'error',
          message: '缺少 refresh_token / client_id / client_secret（可通过字段映射指定字段名）',
        });
        continue;
      }

      updateResult(index, { status: 'pending', message: '导入中...' });

      try {
        const region = (regionFromItem || kiroAwsIdcRegion).trim();
        const account = await importKiroAwsIdcAccount({
          refreshToken,
          clientId,
          clientSecret,
          isShared: 0,
          region: region || undefined,
        });

        successCount++;
        updateResult(index, {
          status: 'success',
          accountName: account.account_name || undefined,
          message: '成功',
        });
      } catch (err) {
        failedCount++;
        updateResult(index, {
          status: 'error',
          message: err instanceof Error ? err.message : '导入失败',
        });
      }
    }

    setIsKiroAwsIdcJsonImporting(false);

    if (kiroAwsIdcJsonCancelRef.current) return;

    if (successCount > 0) {
      window.dispatchEvent(new CustomEvent('accountAdded'));
      onSuccess?.();
    }

    const variant =
      successCount === 0 ? 'error' : failedCount > 0 ? 'warning' : 'success';

    toasterRef.current?.show({
      title: 'JSON 导入完成',
      message: `成功 ${successCount}，失败 ${failedCount}`,
      variant,
      position: 'top-right',
    });
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
    const region = kiroAwsIdcRegion.trim();

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
        account_name: undefined,
        is_shared: 0,
        region: region || undefined,
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

  const handleFinishKiroAwsIdcDevice = async () => {
    const accountId = kiroAwsIdcResult?.account_id;
    if (typeof accountId === 'string' && accountId.trim()) {
      await tryWarmupKiroAccountInfo(accountId.trim());
    }

    window.dispatchEvent(new CustomEvent('accountAdded'));
    onOpenChange(false);
    resetState();
    onSuccess?.();
  };

  const handleStartCodexOAuth = async () => {
    try {
      const accountName = codexAccountName.trim();
      const result = await getCodexOAuthAuthorizeUrl({
        is_shared: 0,
        account_name: accountName || undefined,
      });

      setOauthUrl(result.auth_url);
      setOauthState(result.state);
      setCountdown(result.expires_in);
      setCallbackUrl('');

      window.open(result.auth_url, '_blank', 'width=600,height=700');
    } catch (err) {
      toasterRef.current?.show({
        title: '获取授权链接失败',
        message: err instanceof Error ? err.message : '获取 Codex 授权链接失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleSubmitCodexCallback = async () => {
    const url = callbackUrl.trim();
    if (!url) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴 callback_url',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      await submitCodexOAuthCallback(url);

      toasterRef.current?.show({
        title: '添加成功',
        message: 'Codex 账号已添加',
        variant: 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      toasterRef.current?.show({
        title: '添加失败',
        message: err instanceof Error ? err.message : '提交 Codex callback 失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleImportCodexAccount = async () => {
    const credentialJson = codexCredentialJson.replace(/^\uFEFF/, '').trim();
    if (!credentialJson) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴 Codex credential_json',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(credentialJson);
    } catch {
      toasterRef.current?.show({
        title: '凭证格式错误',
        message: '请输入有效的 JSON（支持单个对象或数组）',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      toasterRef.current?.show({
        title: '凭证格式错误',
        message: '请输入有效的 JSON（支持单个对象或数组）',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    const isBatch = Array.isArray(parsed);
    const items: any[] = isBatch ? parsed : [parsed];
    if (isBatch && items.length === 0) {
      toasterRef.current?.show({
        title: '凭证格式错误',
        message: 'JSON 数组不能为空',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    const providedName = codexAccountName.trim();
    if (isBatch && providedName) {
      toasterRef.current?.show({
        title: '提示',
        message: '批量导入会自动命名，已忽略“账号名称”',
        variant: 'warning',
        position: 'top-right',
      });
    }

    try {
      let successCount = 0;
      let failedCount = 0;
      const errors: string[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          failedCount++;
          errors.push(`第 ${i + 1} 个条目不是 JSON 对象`);
          continue;
        }
        try {
          await importCodexAccount({
            credential_json: JSON.stringify(item),
            account_name: isBatch ? undefined : (providedName || undefined),
            is_shared: 0,
          });
          successCount++;
        } catch (err) {
          failedCount++;
          errors.push(`第 ${i + 1} 个导入失败：${err instanceof Error ? err.message : '未知错误'}`);
        }
      }

      if (successCount === 0) {
        toasterRef.current?.show({
          title: '导入失败',
          message: errors[0] || '导入 Codex 账号失败',
          variant: 'error',
          position: 'top-right',
        });
        return;
      }

      toasterRef.current?.show({
        title: isBatch ? '批量导入完成' : '导入成功',
        message: isBatch
          ? `成功 ${successCount} 个${failedCount ? `，失败 ${failedCount} 个` : ''}`
          : 'Codex 账号已添加',
        variant: failedCount ? 'warning' : 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      toasterRef.current?.show({
        title: '导入失败',
        message: err instanceof Error ? err.message : '导入 Codex 账号失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
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

  const handleStartGeminiCliOAuth = async () => {
    try {
      const result = await getGeminiCLIOAuthAuthorizeUrl({
        is_shared: 0,
      });

      setOauthUrl(result.auth_url);
      setOauthState(result.state);
      setCountdown(result.expires_in);
      setCallbackUrl('');

      window.open(result.auth_url, '_blank', 'width=600,height=700');
    } catch (err) {
      toasterRef.current?.show({
        title: '获取授权链接失败',
        message: err instanceof Error ? err.message : '获取 GeminiCLI 授权链接失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleSubmitGeminiCliCallback = async () => {
    const url = callbackUrl.trim();
    if (!url) {
      (toasterRef.current?.show ?? showToast)({
        title: '输入错误',
        message: '请粘贴 callback_url',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      await submitGeminiCLIOAuthCallback(url);

      (toasterRef.current?.show ?? showToast)({
        title: '添加成功',
        message: 'GeminiCLI 账号已添加',
        variant: 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      (toasterRef.current?.show ?? showToast)({
        title: '添加失败',
        message: err instanceof Error ? err.message : '提交 GeminiCLI callback 失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleImportGeminiCliAccount = async () => {
    const credentialJson = geminiCliCredentialJson.replace(/^\uFEFF/, '').trim();
    if (!credentialJson) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请粘贴 GeminiCLI credential_json',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(credentialJson);
    } catch {
      toasterRef.current?.show({
        title: '凭证格式错误',
        message: '请输入有效的 JSON（支持单个对象或数组）',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      toasterRef.current?.show({
        title: '凭证格式错误',
        message: '请输入有效的 JSON（支持单个对象或数组）',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    const isBatch = Array.isArray(parsed);
    const items: any[] = isBatch ? parsed : [parsed];
    if (isBatch && items.length === 0) {
      toasterRef.current?.show({
        title: '凭证格式错误',
        message: 'JSON 数组不能为空',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      let successCount = 0;
      let failedCount = 0;
      const errors: string[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          failedCount++;
          errors.push(`第 ${i + 1} 个条目不是 JSON 对象`);
          continue;
        }
        try {
          await importGeminiCLIAccount({
            credential_json: JSON.stringify(item),
            is_shared: 0,
          });
          successCount++;
        } catch (err) {
          failedCount++;
          errors.push(`第 ${i + 1} 个导入失败：${err instanceof Error ? err.message : '未知错误'}`);
        }
      }

      if (successCount === 0) {
        (toasterRef.current?.show ?? showToast)({
          title: '导入失败',
          message: errors[0] || '导入 GeminiCLI 账号失败',
          variant: 'error',
          position: 'top-right',
        });
        return;
      }

      (toasterRef.current?.show ?? showToast)({
        title: isBatch ? '批量导入完成' : '导入成功',
        message: isBatch
          ? `成功 ${successCount} 个${failedCount ? `，失败 ${failedCount} 个` : ''}`
          : 'GeminiCLI 账号已添加',
        variant: failedCount ? 'warning' : 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      (toasterRef.current?.show ?? showToast)({
        title: '导入失败',
        message: err instanceof Error ? err.message : '导入 GeminiCLI 账号失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleCreateZaiTtsAccount = async () => {
    const accountName = zaiTtsAccountName.trim() || 'ZAI TTS Account';
    const userId = zaiTtsUserId.trim();
    const token = zaiTtsToken.trim();
    const voiceId = zaiTtsVoiceId.trim() || 'system_001';

    if (!userId || !token) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请填写 ZAI_USERID 与 ZAI_TOKEN',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      await createZaiTTSAccount({
        account_name: accountName,
        zai_user_id: userId,
        token,
        voice_id: voiceId,
      });

      (toasterRef.current?.show ?? showToast)({
        title: '添加成功',
        message: 'ZAI TTS 账号已添加',
        variant: 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      (toasterRef.current?.show ?? showToast)({
        title: '添加失败',
        message: err instanceof Error ? err.message : '添加 ZAI TTS 账号失败',
        variant: 'error',
        position: 'top-right',
      });
      throw err;
    }
  };

  const handleCreateZaiImageAccount = async () => {
    const accountName = zaiImageAccountName.trim();
    const token = zaiImageToken.trim();

    if (!token) {
      (toasterRef.current?.show ?? showToast)({
        title: '输入错误',
        message: '请填写 ZAI_TOKEN',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      await createZaiImageAccount({
        account_name: accountName,
        token,
      });

      (toasterRef.current?.show ?? showToast)({
        title: '添加成功',
        message: 'ZAI Image 账号已添加',
        variant: 'success',
        position: 'top-right',
      });

      window.dispatchEvent(new CustomEvent('accountAdded'));
      onOpenChange(false);
      resetState();
      onSuccess?.();
    } catch (err) {
      (toasterRef.current?.show ?? showToast)({
        title: '添加失败',
        message: err instanceof Error ? err.message : '添加 ZAI Image 账号失败',
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
    kiroAwsIdcJsonCancelRef.current = true;
    kiroEnterpriseJsonCancelRef.current = true;

    setStep('platform');
    setPlatform('');
    setKiroProvider('');
    setLoginMethod('');
    setKiroLoginMethod('');
    setKiroAwsIdcMethod('');
    setKiroEnterpriseMethod('');
    setKiroEnterpriseRefreshToken('');
    setKiroEnterpriseClientId('');
    setKiroEnterpriseClientSecret('');
    setKiroEnterpriseRegion('us-east-1');
    setKiroEnterpriseJsonText('');
    setKiroEnterpriseJsonResults([]);
    setIsKiroEnterpriseJsonImporting(false);
    setQwenLoginMethod('oauth');
    setCodexLoginMethod('oauth');
    setKiroImportRefreshToken('');
    setKiroImportClientId('');
    setKiroImportClientSecret('');
    setKiroAwsIdcUserId('');
    setKiroAwsIdcJsonText('');
    setKiroAwsIdcJsonFieldMap({
      refresh_token: '',
      client_id: '',
      client_secret: '',
      region: '',
    });
    setKiroAwsIdcJsonResults([]);
    setIsKiroAwsIdcJsonImporting(false);
    setKiroBatchJson('');
    setKiroBatchResults([]);
    setIsKiroBatchImporting(false);
    setAntigravityImportRefreshToken('');
    setQwenCredentialJson('');
    setQwenAccountName('');
    setCodexCredentialJson('');
    setCodexAccountName('');
    setZaiTtsAccountName('');
    setZaiTtsUserId('');
    setZaiTtsToken('');
    setZaiTtsVoiceId('system_001');
    setZaiImageAccountName('');
    setZaiImageToken('');
    setGeminiCliCredentialJson('');
    setKiroAwsIdcRegion('us-east-1');
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
    kiroAwsIdcJsonCancelRef.current = true;
    kiroEnterpriseJsonCancelRef.current = true;

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
          kiroAwsIdcJsonCancelRef.current = true;
          kiroEnterpriseJsonCancelRef.current = true;
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

                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    platform === 'codex' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="platform"
                    value="codex"
                    checked={platform === 'codex'}
                    onChange={(e) => setPlatform(e.target.value as 'codex')}
                    className="w-4 h-4"
                  />
                  <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                    <OpenAI className="size-6 text-foreground" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">Codex</h3>
                      <Badge variant="secondary">可用</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      OAuth 登录 / 凭证 JSON 导入
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    platform === 'gemini' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="platform"
                    value="gemini"
                    checked={platform === 'gemini'}
                    onChange={(e) => setPlatform(e.target.value as 'gemini')}
                    className="w-4 h-4"
                  />
                  <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                    <Gemini className="size-6 text-foreground" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">GeminiCLI</h3>
                      <Badge variant="secondary">可用</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      OAuth 登录 / 凭证 JSON 导入
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    platform === 'zai-tts' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="platform"
                    value="zai-tts"
                    checked={platform === 'zai-tts'}
                    onChange={(e) => setPlatform(e.target.value as 'zai-tts')}
                    className="w-4 h-4"
                  />
                  <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                    <OpenAI className="size-6 text-foreground" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">ZAI TTS</h3>
                      <Badge variant="secondary">可用</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      账号 + Token + 音色ID
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    platform === 'zai-image' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="platform"
                    value="zai-image"
                    checked={platform === 'zai-image'}
                    onChange={(e) => setPlatform(e.target.value as 'zai-image')}
                    className="w-4 h-4"
                  />
                  <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                    <OpenAI className="size-6 text-foreground" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">ZAI Image</h3>
                      <Badge variant="secondary">可用</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Token（Cookie session）
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
                      支持单个账户导入 / JSON 单个批量导入
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroProvider === 'enterprise'
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50'
                  )}
                >
                  <input
                    type="radio"
                    name="kiroProvider"
                    value="enterprise"
                    checked={kiroProvider === 'enterprise'}
                    onChange={() => {
                      setKiroProvider('enterprise');
                      setKiroLoginMethod('');
                      setKiroAwsIdcMethod('');
                    }}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">企业账户（Enterprise）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      支持手动填写凭据或 JSON 批量导入企业账户
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* 选择添加方式 (Qwen) */}
          {step === 'method' && platform === 'codex' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">选择添加方式</p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    codexLoginMethod === 'oauth'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="codexLoginMethod"
                    value="oauth"
                    checked={codexLoginMethod === 'oauth'}
                    onChange={() => setCodexLoginMethod('oauth')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">OAuth 登录（推荐）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      打开授权页面，然后粘贴 callback URL 完成落库
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    codexLoginMethod === 'json'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="codexLoginMethod"
                    value="json"
                    checked={codexLoginMethod === 'json'}
                    onChange={() => setCodexLoginMethod('json')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">凭证 JSON 导入</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      适合你已经从 CLIProxyAPI / Codex CLI 导出了 codex-*.json
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {step === 'method' && platform === 'gemini' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">选择添加方式</p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    geminiCliLoginMethod === 'oauth'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="geminiCliLoginMethod"
                    value="oauth"
                    checked={geminiCliLoginMethod === 'oauth'}
                    onChange={() => setGeminiCliLoginMethod('oauth')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">OAuth 登录（推荐）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      打开授权页面，然后粘贴 callback URL 完成落库
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    geminiCliLoginMethod === 'json'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="geminiCliLoginMethod"
                    value="json"
                    checked={geminiCliLoginMethod === 'json'}
                    onChange={() => setGeminiCliLoginMethod('json')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">凭证 JSON 导入</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      适合你已经从 GeminiCLI 导出了 credential.json
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

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

          {/* 选择导入方式 (Kiro AWS-IMA / Builder ID) */}
          {step === 'method' && platform === 'kiro' && kiroProvider === 'aws_idc' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                选择导入方式
              </p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroAwsIdcMethod === 'manual_import'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="kiroAwsIdcMethod"
                    value="manual_import"
                    checked={kiroAwsIdcMethod === 'manual_import'}
                    onChange={() => setKiroAwsIdcMethod('manual_import')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">单个账户导入</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      填写 refresh_token + client_id + client_secret
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroAwsIdcMethod === 'json_import'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="kiroAwsIdcMethod"
                    value="json_import"
                    checked={kiroAwsIdcMethod === 'json_import'}
                    onChange={() => setKiroAwsIdcMethod('json_import')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">JSON 单个/批量导入</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      一个输入框，支持字段映射；region 未传则走默认值
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* 选择导入方式 (Kiro Enterprise) */}
          {step === 'method' && platform === 'kiro' && kiroProvider === 'enterprise' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                选择导入方式
              </p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroEnterpriseMethod === 'manual_import'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="kiroEnterpriseMethod"
                    value="manual_import"
                    checked={kiroEnterpriseMethod === 'manual_import'}
                    onChange={() => setKiroEnterpriseMethod('manual_import')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">手动填写</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      填写 refreshToken + clientId + clientSecret 导入单个企业账户
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    kiroEnterpriseMethod === 'json_import'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="kiroEnterpriseMethod"
                    value="json_import"
                    checked={kiroEnterpriseMethod === 'json_import'}
                    onChange={() => setKiroEnterpriseMethod('json_import')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">JSON 导入</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      粘贴 JSON 文本，支持单个对象或数组批量导入
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
              {platform === 'zai-tts' ? (
                <>
                  <div className="space-y-3">
                    <Label htmlFor="zai-tts-account-name" className="text-base font-semibold">
                      账号名称（可选）
                    </Label>
                    <Input
                      id="zai-tts-account-name"
                      placeholder="给这个账号起个名字（可不填）"
                      value={zaiTtsAccountName}
                      onChange={(e) => setZaiTtsAccountName(e.target.value)}
                      className="h-12"
                    />
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="zai-tts-user-id" className="text-base font-semibold">
                      ZAI_USERID
                    </Label>
                    <Input
                      id="zai-tts-user-id"
                      placeholder="xxxx-yyyy"
                      value={zaiTtsUserId}
                      onChange={(e) => setZaiTtsUserId(e.target.value)}
                      className="font-mono text-sm h-12"
                    />
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="zai-tts-token" className="text-base font-semibold">
                      ZAI_TOKEN
                    </Label>
                    <Input
                      id="zai-tts-token"
                      placeholder="eyJhbGc..."
                      value={zaiTtsToken}
                      onChange={(e) => setZaiTtsToken(e.target.value)}
                      className="font-mono text-sm h-12"
                    />
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="zai-tts-voice-id" className="text-base font-semibold">
                      音色ID
                    </Label>
                    <Input
                      id="zai-tts-voice-id"
                      placeholder="system_001"
                      value={zaiTtsVoiceId}
                      onChange={(e) => setZaiTtsVoiceId(e.target.value)}
                      className="font-mono text-sm h-12"
                    />
                    <p className="text-sm text-muted-foreground">
                      默认使用系统自带音色：system_001
                    </p>
                  </div>
                </>
              ) : platform === 'zai-image' ? (
                <>
                  <div className="space-y-3">
                    <Label htmlFor="zai-image-account-name" className="text-base font-semibold">
                      账号名称（可选）
                    </Label>
                    <Input
                      id="zai-image-account-name"
                      placeholder="给这个账号起个名字（可不填）"
                      value={zaiImageAccountName}
                      onChange={(e) => setZaiImageAccountName(e.target.value)}
                      className="h-12"
                    />
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="zai-image-token" className="text-base font-semibold">
                      ZAI_TOKEN
                    </Label>
                    <Input
                      id="zai-image-token"
                      placeholder="session=..."
                      value={zaiImageToken}
                      onChange={(e) => setZaiImageToken(e.target.value)}
                      className="font-mono text-sm h-12"
                    />
                    <p className="text-sm text-muted-foreground">
                      来自 image.z.ai 的 Cookie session
                    </p>
                  </div>
                </>
              ) : platform === 'codex' ? (
                <>
                  <div className="space-y-3">
                    <Label htmlFor="codex-account-name" className="text-base font-semibold">
                      账号名称（可选）
                    </Label>
                    <Input
                      id="codex-account-name"
                      placeholder="给这个账号起个名字（可不填）"
                      value={codexAccountName}
                      onChange={(e) => setCodexAccountName(e.target.value)}
                      className="h-12"
                    />
                    <p className="text-sm text-muted-foreground">
                      留空会自动命名：邮箱前三位 + account_id 首段（按 account_id + 邮箱 区分，避免覆盖）
                    </p>
                  </div>

                  {codexLoginMethod === 'json' ? (
                    <>
                      <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                        <p className="text-xs text-yellow-600 dark:text-yellow-400">
                          <strong>提示</strong>
                          <br />
                          凭证包含敏感 token，请只在可信环境中粘贴，并避免截图/外发。
                        </p>
                      </div>
                      <div className="space-y-3">
                        <Label htmlFor="codex-credential-json" className="text-base font-semibold">
                          credential_json
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          支持批量：粘贴 JSON 数组（例如 <span className="font-mono">{'[{...},{...}]'}</span>）
                        </p>
                        <Textarea
                          id="codex-credential-json"
                          placeholder="在此粘贴 CLIProxyAPI / Codex CLI 导出的 codex-*.json 内容（支持对象/数组）"
                          value={codexCredentialJson}
                          onChange={(e) => setCodexCredentialJson(e.target.value)}
                          className="font-mono text-sm min-h-[220px]"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-3">
                        <Label className="text-base font-semibold">OAuth 授权</Label>
                        <p className="text-sm text-muted-foreground">
                          点击生成授权链接并打开。登录成功后会跳转到 <span className="font-mono">http://localhost:1455/auth/callback</span>；如果提示无法访问，直接复制地址栏里的 callback URL，粘贴到下方提交即可完成落库。
                        </p>
                      </div>

                      <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                        <p className="text-xs text-yellow-600 dark:text-yellow-400">
                          <strong>提示</strong>
                          <br />
                          state 有效期约 10 分钟，过期请重新生成链接。
                        </p>
                      </div>

                      <div className="space-y-3">
                        <Label className="text-base font-semibold">授权操作</Label>

                        <div className="flex gap-2">
                          <StatefulButton onClick={handleStartCodexOAuth} className="flex-1 cursor-pointer">
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

                        {oauthState && (
                          <p className="text-xs text-muted-foreground">
                            state：<span className="font-mono">{oauthState}</span>
                          </p>
                        )}
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="codex-callback-url" className="text-base font-semibold">
                          callback_url
                        </Label>
                        <Input
                          id="codex-callback-url"
                          placeholder="粘贴 http://localhost:1455/auth/callback?code=...&state=..."
                          value={callbackUrl}
                          onChange={(e) => setCallbackUrl(e.target.value)}
                          className="font-mono text-sm h-12"
                        />
                      </div>
                    </>
                  )}
                </>
              ) : platform === 'gemini' ? (
                <>
                  {geminiCliLoginMethod === 'json' ? (
                    <>
                      <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                        <p className="text-xs text-yellow-600 dark:text-yellow-400">
                          <strong>提示</strong>
                          <br />
                          凭证包含敏感 token，请只在可信环境中粘贴，并避免截图/外发。
                        </p>
                      </div>
                      <div className="space-y-3">
                        <Label htmlFor="gemini-cli-credential-json" className="text-base font-semibold">
                          credential_json
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          支持批量：粘贴 JSON 数组（例如 <span className="font-mono">{'[{...},{...}]'}</span>）
                        </p>
                        <Textarea
                          id="gemini-cli-credential-json"
                          placeholder="在此粘贴 GeminiCLI 导出的 credential.json 内容（支持对象/数组）"
                          value={geminiCliCredentialJson}
                          onChange={(e) => setGeminiCliCredentialJson(e.target.value)}
                          className="font-mono text-sm min-h-[220px]"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-3">
                        <Label className="text-base font-semibold">OAuth 授权</Label>
                        <p className="text-sm text-muted-foreground">
                          点击生成授权链接并打开。登录成功后会跳转到 <span className="font-mono">http://localhost:1455/auth/callback</span>；如果提示无法访问，直接复制地址栏里的 callback URL，粘贴到下方提交即可完成落库。
                        </p>
                      </div>

                      <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                        <p className="text-xs text-yellow-600 dark:text-yellow-400">
                          <strong>提示</strong>
                          <br />
                          state 有效期约 10 分钟，过期请重新生成链接。
                        </p>
                      </div>

                      <div className="space-y-3">
                        <Label className="text-base font-semibold">授权操作</Label>

                        <div className="flex gap-2">
                          <StatefulButton onClick={handleStartGeminiCliOAuth} className="flex-1 cursor-pointer">
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

                        {oauthState && (
                          <p className="text-xs text-muted-foreground">
                            state：<span className="font-mono">{oauthState}</span>
                          </p>
                        )}
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="gemini-cli-callback-url" className="text-base font-semibold">
                          callback_url
                        </Label>
                        <Input
                          id="gemini-cli-callback-url"
                          placeholder="粘贴 http://localhost:1455/auth/callback?code=...&state=..."
                          value={callbackUrl}
                          onChange={(e) => setCallbackUrl(e.target.value)}
                          className="font-mono text-sm h-12"
                        />
                      </div>
                    </>
                  )}
                </>
              ) : platform === 'qwen' ? (
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

                  <div className="p-4 bg-muted/30 border border-border rounded-lg">
                    <p className="text-xs text-muted-foreground">
                      账号名称将自动使用邮箱（服务端校验通过后填充），无需手动填写。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-aws-idc-region" className="text-base font-semibold">
                      region（默认 us-east-1）
                    </Label>
                    <Input
                      id="kiro-aws-idc-region"
                      placeholder="例如：us-east-1"
                      value={kiroAwsIdcRegion}
                      onChange={(e) => setKiroAwsIdcRegion(e.target.value)}
                      className="h-12 font-mono text-sm"
                      autoComplete="off"
                    />
                    <p className="text-sm text-muted-foreground">
                      影响 AWS OIDC（SSO/OIDC）认证端点；CodeWhisperer/Q API 默认使用 us-east-1。
                    </p>
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
              ) : platform === 'kiro' && kiroProvider === 'aws_idc' && kiroAwsIdcMethod === 'json_import' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">JSON 单个/批量导入</Label>
                    <p className="text-sm text-muted-foreground">
                      粘贴 JSON 全文（对象或数组）；支持字段映射；region 未传则走默认值。
                    </p>
                  </div>

                  <div className="p-4 bg-muted/30 border border-border rounded-lg">
                    <p className="text-xs text-muted-foreground">
                      账号名称将自动使用邮箱（服务端校验通过后填充），无需手动填写。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label className="text-base font-semibold">字段映射</Label>

                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left p-3 font-medium">需要字段</th>
                            <th className="text-left p-3 font-medium">你的 JSON 字段名</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          <tr>
                            <td className="p-3 font-mono text-xs">refresh_token（必填）</td>
                            <td className="p-3">
                              <Input
                                value={kiroAwsIdcJsonFieldMap.refresh_token}
                                onChange={(e) =>
                                  setKiroAwsIdcJsonFieldMap((prev) => ({
                                    ...prev,
                                    refresh_token: e.target.value,
                                  }))
                                }
                                placeholder="例如 rt / refreshToken / refresh_token"
                                className="h-10 font-mono text-xs"
                                autoComplete="off"
                              />
                            </td>
                          </tr>

                          <tr>
                            <td className="p-3 font-mono text-xs">client_id（必填）</td>
                            <td className="p-3">
                              <Input
                                value={kiroAwsIdcJsonFieldMap.client_id}
                                onChange={(e) =>
                                  setKiroAwsIdcJsonFieldMap((prev) => ({
                                    ...prev,
                                    client_id: e.target.value,
                                  }))
                                }
                                placeholder="例如 cid / clientId / client_id"
                                className="h-10 font-mono text-xs"
                                autoComplete="off"
                              />
                            </td>
                          </tr>

                          <tr>
                            <td className="p-3 font-mono text-xs">client_secret（必填）</td>
                            <td className="p-3">
                              <Input
                                value={kiroAwsIdcJsonFieldMap.client_secret}
                                onChange={(e) =>
                                  setKiroAwsIdcJsonFieldMap((prev) => ({
                                    ...prev,
                                    client_secret: e.target.value,
                                  }))
                                }
                                placeholder="例如 csecret / clientSecret / client_secret"
                                className="h-10 font-mono text-xs"
                                autoComplete="off"
                              />
                            </td>
                          </tr>

                          <tr>
                            <td className="p-3 font-mono text-xs">region（可选）</td>
                            <td className="p-3">
                              <Input
                                value={kiroAwsIdcJsonFieldMap.region}
                                onChange={(e) =>
                                  setKiroAwsIdcJsonFieldMap((prev) => ({
                                    ...prev,
                                    region: e.target.value,
                                  }))
                                }
                                placeholder="例如 region-id / region / awsRegion"
                                className="h-10 font-mono text-xs"
                                autoComplete="off"
                              />
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      留空则自动识别常见字段名；多个字段名可用英文逗号分隔。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-aws-idc-region" className="text-base font-semibold">
                      默认 region（默认 us-east-1）
                    </Label>
                    <Input
                      id="kiro-aws-idc-region"
                      placeholder="例如：us-east-1"
                      value={kiroAwsIdcRegion}
                      onChange={(e) => setKiroAwsIdcRegion(e.target.value)}
                      className="h-12 font-mono text-sm"
                      autoComplete="off"
                    />
                    <p className="text-sm text-muted-foreground">
                      当 JSON 中没有 region（或字段映射为空）时，使用此默认值；留空则走服务端默认值。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-aws-idc-json-text" className="text-base font-semibold">
                      JSON 全文
                    </Label>
                    <Textarea
                      id="kiro-aws-idc-json-text"
                      placeholder='示例：[{"region-id":"us-east-1","cid":"xxx","csecret":"xxxx","rt":"xxxx"}]'
                      value={kiroAwsIdcJsonText}
                      onChange={(e) => setKiroAwsIdcJsonText(e.target.value)}
                      className="font-mono text-sm [field-sizing:fixed] min-h-[180px] max-h-[360px] overflow-y-auto"
                    />
                    <p className="text-xs text-muted-foreground">
                      支持单个对象 {} 或数组 []；也支持多个对象用逗号分隔（会自动补成数组）。
                    </p>
                  </div>

                  {kiroAwsIdcJsonResults.length > 0 && (
                    <div className="space-y-3">
                      <Label className="text-base font-semibold">导入清单</Label>
                      <div className="space-y-2">
                        {kiroAwsIdcJsonResults.map((r) => (
                          <div
                            key={r.index}
                            className="flex items-start justify-between gap-3 rounded-lg border p-3"
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <p className="text-sm">
                                <span className="font-mono text-xs text-muted-foreground mr-2">
                                  #{r.index}
                                </span>
                                <span className={r.accountName ? '' : 'text-muted-foreground'}>
                                  {r.accountName || '（未获取邮箱）'}
                                </span>
                              </p>
                              {r.message && (
                                <p className="text-xs text-muted-foreground break-words">{r.message}</p>
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
              ) : platform === 'kiro' && kiroProvider === 'aws_idc' && kiroAwsIdcMethod === 'manual_import' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">单个账户导入</Label>
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

                  <div className="p-4 bg-muted/30 border border-border rounded-lg">
                    <p className="text-xs text-muted-foreground">
                      账号名称将自动使用邮箱（服务端校验通过后填充），无需手动填写。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-aws-idc-region" className="text-base font-semibold">
                      region（默认 us-east-1）
                    </Label>
                    <Input
                      id="kiro-aws-idc-region"
                      placeholder="例如：us-east-1"
                      value={kiroAwsIdcRegion}
                      onChange={(e) => setKiroAwsIdcRegion(e.target.value)}
                      className="h-12 font-mono text-sm"
                      autoComplete="off"
                    />
                    <p className="text-sm text-muted-foreground">
                      影响 AWS OIDC（SSO/OIDC）认证端点；CodeWhisperer/Q API 默认使用 us-east-1。
                    </p>
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
                    <Label htmlFor="kiro-aws-idc-user-id" className="text-base font-semibold">
                      user_id（可选）
                    </Label>
                    <Input
                      id="kiro-aws-idc-user-id"
                      placeholder="当服务端提示无法解析 userid 时填写"
                      value={kiroAwsIdcUserId}
                      onChange={(e) => setKiroAwsIdcUserId(e.target.value)}
                      className="h-12 font-mono text-sm"
                      autoComplete="off"
                    />
                    <p className="text-sm text-muted-foreground">
                      仅在服务端提示 “无法从 token 解析 userid，请在请求体中手动提供 userid” 时需要填写。
                    </p>
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

                  <div className="p-4 bg-muted/30 border border-border rounded-lg">
                    <p className="text-xs text-muted-foreground">
                      账号名称将自动使用邮箱（服务端校验通过后填充），无需手动填写。
                    </p>
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
              ) : platform === 'kiro' && kiroProvider === 'enterprise' && kiroEnterpriseMethod === 'json_import' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">JSON 单个/批量导入</Label>
                    <p className="text-sm text-muted-foreground">
                      粘贴 JSON 全文（单个对象或数组）；支持 camelCase 和 snake_case 字段名。
                    </p>
                  </div>

                  <div className="p-4 bg-muted/30 border border-border rounded-lg">
                    <p className="text-xs text-muted-foreground">
                      必填字段：refreshToken / refresh_token、clientId / client_id、clientSecret / client_secret。
                      可选字段：region（默认 us-east-1）。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-enterprise-json-text" className="text-base font-semibold">
                      JSON 全文
                    </Label>
                    <Textarea
                      id="kiro-enterprise-json-text"
                      placeholder={'示例：{"refreshToken":"xxx","clientId":"xxx","clientSecret":"xxx","region":"us-east-1"}\n或数组：[{"refresh_token":"xxx","client_id":"xxx","client_secret":"xxx"}]'}
                      value={kiroEnterpriseJsonText}
                      onChange={(e) => setKiroEnterpriseJsonText(e.target.value)}
                      className="font-mono text-sm [field-sizing:fixed] min-h-[180px] max-h-[360px] overflow-y-auto"
                    />
                    <p className="text-xs text-muted-foreground">
                      支持单个对象 {'{}'} 或数组 {'[]'}；字段名支持 camelCase（refreshToken）和 snake_case（refresh_token）。
                    </p>
                  </div>

                  {kiroEnterpriseJsonResults.length > 0 && (
                    <div className="space-y-3">
                      <Label className="text-base font-semibold">导入清单</Label>
                      <div className="space-y-2">
                        {kiroEnterpriseJsonResults.map((r) => (
                          <div
                            key={r.index}
                            className="flex items-start justify-between gap-3 rounded-lg border p-3"
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <p className="text-sm">
                                <span className="font-mono text-xs text-muted-foreground mr-2">
                                  #{r.index}
                                </span>
                                <span className={r.accountName ? '' : 'text-muted-foreground'}>
                                  {r.accountName || '（未获取名称）'}
                                </span>
                              </p>
                              {r.message && (
                                <p className="text-xs text-muted-foreground break-words">{r.message}</p>
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
              ) : platform === 'kiro' && kiroProvider === 'enterprise' && kiroEnterpriseMethod === 'manual_import' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">企业账户导入</Label>
                    <p className="text-sm text-muted-foreground">
                      提供 refresh_token + client_id + client_secret；服务端不会回传 token。
                    </p>
                  </div>

                  <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                    <p className="text-xs text-yellow-600 dark:text-yellow-400">
                      <strong>提示</strong>
                      <br />
                      refresh_token / client_secret 属于敏感信息，请只在可信环境中粘贴，并避免截图/外发。
                    </p>
                  </div>

                  <div className="p-4 bg-muted/30 border border-border rounded-lg">
                    <p className="text-xs text-muted-foreground">
                      账号名称将自动使用邮箱（服务端校验通过后填充），无需手动填写。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-enterprise-region" className="text-base font-semibold">
                      region（默认 us-east-1）
                    </Label>
                    <Input
                      id="kiro-enterprise-region"
                      placeholder="例如：us-east-1"
                      value={kiroEnterpriseRegion}
                      onChange={(e) => setKiroEnterpriseRegion(e.target.value)}
                      className="h-12 font-mono text-sm"
                      autoComplete="off"
                    />
                    <p className="text-sm text-muted-foreground">
                      影响 AWS OIDC（SSO/OIDC）认证端点；API 默认使用 us-east-1。
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="kiro-enterprise-client-id" className="text-base font-semibold">
                        client_id
                      </Label>
                      <Input
                        id="kiro-enterprise-client-id"
                        placeholder="请输入 client_id"
                        value={kiroEnterpriseClientId}
                        onChange={(e) => setKiroEnterpriseClientId(e.target.value)}
                        className="h-12 font-mono text-sm"
                        autoComplete="off"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="kiro-enterprise-client-secret" className="text-base font-semibold">
                        client_secret
                      </Label>
                      <Input
                        id="kiro-enterprise-client-secret"
                        placeholder="请输入 client_secret"
                        value={kiroEnterpriseClientSecret}
                        onChange={(e) => setKiroEnterpriseClientSecret(e.target.value)}
                        className="h-12 font-mono text-sm"
                        autoComplete="off"
                        type="password"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="kiro-enterprise-refresh-token" className="text-base font-semibold">
                      refresh_token
                    </Label>
                    <Textarea
                      id="kiro-enterprise-refresh-token"
                      placeholder="在此粘贴 refresh_token"
                      value={kiroEnterpriseRefreshToken}
                      onChange={(e) => setKiroEnterpriseRefreshToken(e.target.value)}
                      className="font-mono text-sm [field-sizing:fixed] min-h-[80px] max-h-[160px] overflow-y-auto"
                    />
                  </div>
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
            platform === 'zai-tts' ? (
              <StatefulButton
                onClick={handleCreateZaiTtsAccount}
                disabled={!zaiTtsUserId.trim() || !zaiTtsToken.trim() || !zaiTtsVoiceId.trim()}
                className="flex-1 cursor-pointer"
              >
                完成添加
              </StatefulButton>
            ) : platform === 'zai-image' ? (
              <StatefulButton
                onClick={handleCreateZaiImageAccount}
                disabled={!zaiImageToken.trim()}
                className="flex-1 cursor-pointer"
              >
                完成添加
              </StatefulButton>
            ) : platform === 'codex' ? (
              codexLoginMethod === 'json' ? (
                <StatefulButton
                  onClick={handleImportCodexAccount}
                  disabled={!codexCredentialJson.trim()}
                  className="flex-1 cursor-pointer"
                >
                  完成导入
                </StatefulButton>
              ) : (
                <StatefulButton
                  onClick={handleSubmitCodexCallback}
                  disabled={!callbackUrl.trim()}
                  className="flex-1 cursor-pointer"
                >
                  完成添加
                </StatefulButton>
              )
            ) : platform === 'qwen' ? (
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
            ) : platform === 'gemini' ? (
              geminiCliLoginMethod === 'json' ? (
                <StatefulButton
                  onClick={handleImportGeminiCliAccount}
                  disabled={!geminiCliCredentialJson.trim()}
                  className="flex-1 cursor-pointer"
                >
                  完成导入
                </StatefulButton>
              ) : (
                <StatefulButton
                  onClick={handleSubmitGeminiCliCallback}
                  disabled={!callbackUrl.trim()}
                  className="flex-1 cursor-pointer"
                >
                  完成添加
                </StatefulButton>
              )
            ) : platform === 'kiro' ? (
              kiroProvider === 'aws_idc' ? (
                kiroAwsIdcMethod === 'manual_import' ? (
                  <StatefulButton
                    onClick={handleImportKiroAwsIdcAccount}
                    disabled={
                      !kiroImportRefreshToken.trim() ||
                      !kiroImportClientId.trim() ||
                      !kiroImportClientSecret.trim()
                    }
                    className="flex-1 cursor-pointer"
                  >
                    完成导入
                  </StatefulButton>
                ) : kiroAwsIdcMethod === 'json_import' ? (
                  <StatefulButton
                    onClick={handleImportKiroAwsIdcJson}
                    disabled={!kiroAwsIdcJsonText.trim() || isKiroAwsIdcJsonImporting}
                    className="flex-1 cursor-pointer"
                  >
                    {isKiroAwsIdcJsonImporting ? '导入中...' : '解析并导入'}
                  </StatefulButton>
                ) : kiroAwsIdcMethod === 'device_code' ? (
                  kiroAwsIdcStatus === 'completed' ? (
                    <StatefulButton
                      onClick={handleFinishKiroAwsIdcDevice}
                      className="flex-1 cursor-pointer"
                    >
                      完成
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
              ) : kiroProvider === 'enterprise' ? (
                kiroEnterpriseMethod === 'manual_import' ? (
                  <StatefulButton
                    onClick={handleImportKiroEnterpriseAccount}
                    disabled={
                      !kiroEnterpriseRefreshToken.trim() ||
                      !kiroEnterpriseClientId.trim() ||
                      !kiroEnterpriseClientSecret.trim()
                    }
                    className="flex-1 cursor-pointer"
                  >
                    完成导入
                  </StatefulButton>
                ) : kiroEnterpriseMethod === 'json_import' ? (
                  <StatefulButton
                    onClick={handleImportKiroEnterpriseJson}
                    disabled={!kiroEnterpriseJsonText.trim() || isKiroEnterpriseJsonImporting}
                    className="flex-1 cursor-pointer"
                  >
                    {isKiroEnterpriseJsonImporting ? '导入中...' : '解析并导入'}
                  </StatefulButton>
                ) : (
                  <Button
                    onClick={handleClose}
                    className="flex-1 cursor-pointer"
                  >
                    关闭
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
                platform === 'codex' ? !codexLoginMethod :
                platform === 'qwen' ? !qwenLoginMethod :
                platform === 'gemini' ? !geminiCliLoginMethod :
                kiroProvider === 'social' ? !kiroLoginMethod :
                kiroProvider === 'aws_idc' ? !kiroAwsIdcMethod :
                kiroProvider === 'enterprise' ? !kiroEnterpriseMethod :
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
