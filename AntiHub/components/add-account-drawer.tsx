'use client';

import { useState, useRef, useEffect } from 'react';
import {
  createKiroAccount,
  getOAuthAuthorizeUrl,
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

export function AddAccountDrawer({ open, onOpenChange, onSuccess }: AddAccountDrawerProps) {
  const toasterRef = useRef<ToasterRef>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [step, setStep] = useState<
    'platform' | 'kiro_provider' | 'method' | 'authorize'
  >('platform');
  const [platform, setPlatform] = useState<'antigravity' | 'kiro' | 'qwen' | ''>('');
  const [kiroProvider, setKiroProvider] = useState<'social' | 'aws_idc' | ''>('');
  const [loginMethod, setLoginMethod] = useState<'manual' | 'refresh_token' | ''>(''); // Antigravity 登录方式
  const [kiroLoginMethod, setKiroLoginMethod] = useState<'refresh_token' | ''>('');
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
        setKiroLoginMethod('refresh_token');
        setOauthUrl('');
        setOauthState('');
        setCountdown(600);
        setIsWaitingAuth(false);
        setStep('authorize');
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

        <div className="px-4 py-6 space-y-6">
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
                      setKiroLoginMethod('refresh_token');
                      setKiroAwsIdcMethod('');
                    }}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <h3 className="font-semibold">Kiro OAuth（Refresh Token 导入）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      通过 Refresh Token 导入 Social 登录方式获取的账号
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
                      className="font-mono text-sm min-h-[140px]"
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
                      className="font-mono text-sm min-h-[140px]"
                    />
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
                      1. 打开 <span className="font-mono">https://app.kiro.dev/account/usage</span> 并登录
                      <br />
                      2. 按 <span className="font-mono">F12</span> 打开开发者工具
                      <br />
                      3. 点击 应用/Application 标签页
                      <br />
                      4. 左侧展开 存储/Storage → Cookie
                      <br />
                      5. 选择 <span className="font-mono">https://app.kiro.dev</span>
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
                      className="font-mono text-sm min-h-[140px]"
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
