'use client';

import { useState, useRef, useEffect } from 'react';
import {
  createKiroAccount,
  getOAuthAuthorizeUrl,
  submitOAuthCallback,
  getKiroOAuthAuthorizeUrl,
  pollKiroOAuthStatus,
  getQwenOAuthAuthorizeUrl,
  pollQwenOAuthStatus,
  importAccountByRefreshToken,
  importQwenAccount,
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
  const [step, setStep] = useState<'platform' | 'provider' | 'method' | 'authorize'>('platform');
  const [platform, setPlatform] = useState<'antigravity' | 'kiro' | 'qwen' | ''>('');
  const [provider, setProvider] = useState<'Google' | 'Github' | ''>(''); // Kiro OAuth提供商
  const [loginMethod, setLoginMethod] = useState<'antihook' | 'manual' | 'refresh_token' | ''>(''); // Antigravity 登录方式
  const [kiroLoginMethod, setKiroLoginMethod] = useState<'oauth' | 'refresh_token' | ''>('');
  const [qwenLoginMethod, setQwenLoginMethod] = useState<'oauth' | 'json'>('oauth');
  const [kiroImportAuthMethod, setKiroImportAuthMethod] = useState<'Social' | 'IdC'>('Social');
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
      if (platform === 'qwen') {
        setStep('authorize');
        return;
      }

      setStep('method');
    } else if (step === 'provider') {
      if (!provider) {
        toasterRef.current?.show({
          title: '选择提供商',
          message: '请选择OAuth提供商',
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }

      try {
        const result = await getKiroOAuthAuthorizeUrl(provider as 'Google' | 'Github', 0);
        setOauthUrl(result.data.auth_url);
        setOauthState(result.data.state);
        setCountdown(result.data.expires_in);
        setIsWaitingAuth(true);
        startCountdownTimer(result.data.expires_in);
        startPollingOAuthStatus(result.data.state);
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
    } else if (step === 'method') {
      if (platform === 'qwen') {
        setStep('authorize');
        return;
      }

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

        if (kiroLoginMethod === 'oauth') {
          setStep('provider');
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
      
      // 如果选择 Antihook 登录，直接拉起 Antihook，弹出提示并关闭 Drawer
      if (loginMethod === 'antihook') {
        handleOpenAntihook();
        toasterRef.current?.show({
          title: '请在 Antihook 中继续操作',
          message: '授权成功后账号将自动添加到您的账号列表',
          variant: 'success',
          position: 'top-right',
        });
        handleClose();
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
    if (step === 'provider') {
      setStep('method');
    } else if (step === 'method') {
      setStep('platform');
      if (platform === 'antigravity') {
        setLoginMethod('');
      } else if (platform === 'kiro') {
        setKiroLoginMethod('');
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
        setStep('platform');
      } else if (platform === 'antigravity') {
        setStep('method');
      } else {
        if (kiroLoginMethod === 'oauth') {
          setStep('provider');
        } else {
          setStep('method');
        }
      }
      setOauthUrl('');
      setOauthState('');
      setCallbackUrl('');
      setAntigravityImportRefreshToken('');
      setQwenCredentialJson('');
      setQwenAccountName('');
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

  // 轮询OAuth授权状态
  const startPollingOAuthStatus = (state: string) => {
    // 清除之前的轮询
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    // 每3秒轮询一次
    pollTimerRef.current = setInterval(async () => {
      try {
        const result = await pollKiroOAuthStatus(state);

        if (result.status === 'completed') {
          // 授权成功
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
            message: 'Kiro账号已成功添加',
            variant: 'success',
            position: 'top-right',
          });

          // 触发账号列表刷新
          window.dispatchEvent(new CustomEvent('accountAdded'));

          // 关闭抽屉
          onOpenChange(false);
          resetState();
          onSuccess?.();

        } else if (result.status === 'failed') {
          // 授权失败
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }

          setIsWaitingAuth(false);
          toasterRef.current?.show({
            title: '授权失败',
            message: result.message || '授权失败，请重试',
            variant: 'error',
            position: 'top-right',
          });

        } else if (result.status === 'expired') {
          // 已过期
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
        // status === 'pending' 时继续轮询

      } catch (error) {
        console.error('轮询OAuth状态失败:', error);
      }
    }, 3000); // 每3秒轮询一次
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
    const clientId = kiroImportClientId.trim();
    const clientSecret = kiroImportClientSecret.trim();

    if (kiroImportAuthMethod === 'IdC' && (!clientId || !clientSecret)) {
      toasterRef.current?.show({
        title: '输入错误',
        message: 'IdC 方式需要 client_id 和 client_secret',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    try {
      await createKiroAccount({
        refresh_token: refreshToken,
        auth_method: kiroImportAuthMethod,
        account_name: accountName || undefined,
        client_id: kiroImportAuthMethod === 'IdC' ? clientId : undefined,       
        client_secret: kiroImportAuthMethod === 'IdC' ? clientSecret : undefined,
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
    setProvider('');
    setLoginMethod('');
    setKiroLoginMethod('');
    setQwenLoginMethod('oauth');
    setKiroImportAuthMethod('Social');
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
  };

  // 获取 Antihook 登录链接
  const getAntihookUrl = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
    if (!token) return '';
    // URL 格式: anti://antigravity?identity=<token>&is_shared=0（个人使用固定专属）
    return `anti://antigravity?identity=${encodeURIComponent(token)}&is_shared=0`;
  };

  // 打开 Antihook 登录
  const handleOpenAntihook = () => {
    const antihookUrl = getAntihookUrl();
    if (antihookUrl) {
      window.location.href = antihookUrl;
    }
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
                      Google 与 Github OAuth
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

          {/* 步骤 2: 选择OAuth提供商 (仅Kiro) */}
          {step === 'provider' && platform === 'kiro' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                你希望以何种方式登录 Kiro ?
              </p>

              <div className="space-y-3">
                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    provider === 'Google' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="provider"
                    value="Google"
                    checked={provider === 'Google'}
                    onChange={(e) => setProvider(e.target.value as 'Google')}
                    className="w-4 h-4"
                  />
                  <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center">
                    <svg className="w-6 h-6" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold">Google</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      使用 Google 账号授权
                    </p>
                  </div>
                </label>

                <label
                  className={cn(
                    "flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    provider === 'Github' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="provider"
                    value="Github"
                    checked={provider === 'Github'}
                    onChange={(e) => setProvider(e.target.value as 'Github')}
                    className="w-4 h-4"
                  />
                  <div className="w-10 h-10 rounded-lg bg-[#24292e] flex items-center justify-center">
                    <svg className="w-6 h-6" fill="white" viewBox="0 0 24 24">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold">Github</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      使用 Github 账号授权
                    </p>
                  </div>
                </label>
              </div>

              <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                <p className="text-xs text-yellow-600 dark:text-yellow-400">
                  <strong>重要指示</strong>
                  <br />
                  要登录 Kiro ，请先下载并运行至少一次{' '}
                  <a
                    href="https://github.com/AntiHub-Project/AntiHook/releases"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-yellow-700 dark:hover:text-yellow-300"
                  >
                    AntiHook
                  </a>
                  。
                </p>
              </div>
            </div>
          )}

          {/* 选择添加方式 (Kiro) */}
          {step === 'method' && platform === 'kiro' && (
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
                    <h3 className="font-semibold">一键登录（OAuth）</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Google / Github 授权，完成后自动添加账号
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
                      直接粘贴 refresh_token 导入账号（适合已有 Token）
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
                {/* Antihook 登录 */}
                <label
                  className={cn(
                    "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                    loginMethod === 'antihook' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  )}
                >
                  <input
                    type="radio"
                    name="loginMethod"
                    value="antihook"
                    checked={loginMethod === 'antihook'}
                    onChange={() => setLoginMethod('antihook')}
                    className="w-4 h-4 mt-1"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">通过 Antihook 登录</h3>
                    </div>
                    {loginMethod === 'antihook' && (
                      <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-2">
                        请确保已安装并运行{' '}
                        <a
                          href="https://github.com/AntiHub-Project/AntiHook/releases"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-yellow-700 dark:hover:text-yellow-300"
                        >
                          AntiHook
                        </a>
                        {' '}客户端
                      </p>
                    )}
                  </div>
                </label>

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
                    <Label className="text-base font-semibold">Qwen 登录方式</Label>
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

                    {qwenLoginMethod === 'oauth' ? (
                      <p className="text-sm text-muted-foreground">
                        将打开 Qwen 授权页面，完成后系统会自动轮询并写入账号（不需要粘贴回调地址）。
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        直接粘贴 QwenCli 导出的 JSON 凭证（包含 access_token 等字段），服务端会校验并写入账号。
                      </p>
                    )}
                    <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                      <p className="text-xs text-yellow-600 dark:text-yellow-400">
                        <strong>提示</strong>
                        <br />
                        {qwenLoginMethod === 'oauth'
                          ? '授权成功后不会在页面展示 token，服务端会安全保存并用于模型调用。'
                          : '凭证包含敏感 token，请只在可信环境中粘贴，并避免截图/外发。'}
                      </p>
                    </div>
                  </div>

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
                  ) : (
                    <div className="space-y-3">
                      <Label className="text-base font-semibold">授权操作</Label>
                      <p className="text-sm text-muted-foreground">
                        点击生成授权链接后，在打开的页面完成授权；系统会自动轮询并写入账号。
                      </p>

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
              ) : platform === 'kiro' && kiroLoginMethod === 'refresh_token' ? (
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">Refresh Token 导入</Label>
                    <p className="text-sm text-muted-foreground">
                      粘贴 refresh_token 后，服务端会校验并自动拉取账号信息。
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
                    <Label className="text-base font-semibold">认证方式</Label>
                    <div className="space-y-3">
                      <label
                        className={cn(
                          "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                          kiroImportAuthMethod === 'Social' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                        )}
                      >
                        <input
                          type="radio"
                          name="kiroAuthMethod"
                          value="Social"
                          checked={kiroImportAuthMethod === 'Social'}
                          onChange={() => setKiroImportAuthMethod('Social')}
                          className="w-4 h-4 mt-1"
                        />
                        <div className="flex-1">
                          <h3 className="font-semibold">Social</h3>
                          <p className="text-sm text-muted-foreground mt-1">
                            一般情况下选这个
                          </p>
                        </div>
                      </label>

                      <label
                        className={cn(
                          "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                          kiroImportAuthMethod === 'IdC' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                        )}
                      >
                        <input
                          type="radio"
                          name="kiroAuthMethod"
                          value="IdC"
                          checked={kiroImportAuthMethod === 'IdC'}
                          onChange={() => setKiroImportAuthMethod('IdC')}
                          className="w-4 h-4 mt-1"
                        />
                        <div className="flex-1">
                          <h3 className="font-semibold">IdC</h3>
                          <p className="text-sm text-muted-foreground mt-1">
                            需要同时提供 client_id / client_secret
                          </p>
                        </div>
                      </label>
                    </div>
                  </div>

                  {kiroImportAuthMethod === 'IdC' && (
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
                  )}

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
                // Kiro账号 - 显示等待授权状态
                <>
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">账号授权</Label>
                    <p className="text-sm text-muted-foreground">
                      点击下方按钮在新窗口完成 {provider} 授权
                    </p>
                    <div className="flex gap-2">
                      <Button
                        onClick={handleOpenOAuthUrl}
                        className="flex-1"
                        size="lg"
                        disabled={!oauthUrl || countdown === 0}
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
                        disabled={!oauthUrl || countdown === 0}
                      >
                        <IconCopy className="size-4 mr-2" />
                        复制链接
                      </Button>
                    </div>
                  </div>

                  {isWaitingAuth && countdown > 0 && (
                    <div className="p-6 bg-muted/50 rounded-lg border-2 border-dashed border-primary/20">
                      <div className="flex flex-col items-center justify-center space-y-4">
                        <div className="relative">
                          <div className="w-16 h-16 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
                        </div>
                        <div className="text-center space-y-2">
                          <p className="font-semibold text-lg">AntiHub 正在等待授权</p>
                          <p className="text-sm text-muted-foreground">
                            请在新窗口中完成 {provider} 授权
                          </p>
                          <p className="text-2xl font-mono font-bold text-primary">
                            {formatCountdown(countdown)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            授权完成后将自动添加账号
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {countdown === 0 && (
                    <div className="p-4 bg-destructive/10 rounded-lg border border-destructive/20">
                      <p className="text-sm text-destructive text-center">
                        授权已超时，请返回重新开始
                      </p>
                    </div>
                  )}
                </>
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
              // Kiro账号不需要手动提交
              kiroLoginMethod === 'refresh_token' ? (
                <StatefulButton
                  onClick={handleImportKiroAccount}
                  disabled={
                    !kiroImportRefreshToken.trim() ||
                    (kiroImportAuthMethod === 'IdC' && (!kiroImportClientId.trim() || !kiroImportClientSecret.trim()))
                  }
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
              disabled={platform === 'antigravity' ? !loginMethod : !kiroLoginMethod}
              className="flex-1 cursor-pointer"
            >
              继续
            </Button>
          ) : (
            <Button
              onClick={handleContinue}
              disabled={(step === 'platform' && !platform) || (step === 'provider' && !provider)}
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
