'use client';

import { useEffect, useState, useRef } from 'react';
import {
  getAccounts,
  deleteAccount,
  updateAccountStatus,
  updateAccountName,
  refreshAccount,
  getAccountProjects,
  updateAccountProjectId,
  getAccountQuotas,
  getAccountCredentials,
  getAntigravityAccountDetail,
  updateQuotaStatus,
  getKiroAccounts,
  getKiroAccountCredentials,
  deleteKiroAccount,
  updateKiroAccountStatus,
  updateKiroAccountName,
  getKiroAccountBalance,
  getQwenAccounts,
  getQwenAccountCredentials,
  deleteQwenAccount,
  updateQwenAccountStatus,
  updateQwenAccountName,
  getCodexAccounts,
  getCodexAccountCredentials,
  deleteCodexAccount,
  updateCodexAccountStatus,
  updateCodexAccountName,
  refreshCodexAccount,
  getCodexWhamUsage,
  getUiDefaultChannels,
  getGeminiCLIAccounts,
  getGeminiCLIAccountCredentials,
  getGeminiCLIAccountQuota,
  deleteGeminiCLIAccount,
  updateGeminiCLIAccountStatus,
  getZaiTTSAccounts,
  updateZaiTTSAccountStatus,
  updateZaiTTSAccountName,
  updateZaiTTSAccountCredentials,
  deleteZaiTTSAccount,
  getZaiImageAccounts,
  updateZaiImageAccountStatus,
  updateZaiImageAccountName,
  updateZaiImageAccountCredentials,
  deleteZaiImageAccount,
  type CodexWhamUsageData,
  type Account,
  type AccountProjects,
  type AntigravityAccountDetail,
  type KiroAccount,
  type QwenAccount,
  type CodexAccount,
  type GeminiCLIAccount,
  type GeminiCLIQuotaData,
  type ZaiTTSAccount,
  type ZaiImageAccount,
} from '@/lib/api';
import { AddAccountDrawer } from '@/components/add-account-drawer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Toaster, { ToasterRef } from '@/components/ui/toast';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip-card';
import { IconCirclePlusFilled, IconDotsVertical, IconRefresh, IconTrash, IconToggleLeft, IconToggleRight, IconExternalLink, IconChartBar, IconEdit, IconAlertTriangle, IconCopy, IconInfoCircle } from '@tabler/icons-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MorphingSquare } from '@/components/ui/morphing-square';
import { Gemini, Claude, OpenAI, Qwen } from '@lobehub/icons';

export default function AccountsPage() {
  const toasterRef = useRef<ToasterRef>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [kiroAccounts, setKiroAccounts] = useState<KiroAccount[]>([]);
  const [kiroBalances, setKiroBalances] = useState<Record<string, number>>({});
  const [qwenAccounts, setQwenAccounts] = useState<QwenAccount[]>([]);
  const [codexAccounts, setCodexAccounts] = useState<CodexAccount[]>([]);
  const [codexRefreshErrorById, setCodexRefreshErrorById] = useState<Record<number, string>>({});
  const [geminiCliAccounts, setGeminiCliAccounts] = useState<GeminiCLIAccount[]>([]);
  const [zaiTtsAccounts, setZaiTtsAccounts] = useState<ZaiTTSAccount[]>([]);
  const [zaiImageAccounts, setZaiImageAccounts] = useState<ZaiImageAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshingCookieId, setRefreshingCookieId] = useState<string | null>(null);
  const [refreshingCodexAccountId, setRefreshingCodexAccountId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'antigravity' | 'kiro' | 'qwen' | 'codex' | 'gemini' | 'zai-tts' | 'zai-image'>('antigravity');

  // 添加账号 Drawer 状态
  const [isAddDrawerOpen, setIsAddDrawerOpen] = useState(false);

  // 配额查看 Dialog 状态
  const [isQuotaDialogOpen, setIsQuotaDialogOpen] = useState(false);
  const [currentAccount, setCurrentAccount] = useState<Account | null>(null);
  const [quotas, setQuotas] = useState<any>(null);
  const [isLoadingQuotas, setIsLoadingQuotas] = useState(false);

  // 重命名 Kiro 账号 Dialog 状态
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [renamingAccount, setRenamingAccount] = useState<KiroAccount | null>(null);
  const [newAccountName, setNewAccountName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // 重命名 Antigravity 账号 Dialog 状态
  const [isAntigravityRenameDialogOpen, setIsAntigravityRenameDialogOpen] = useState(false);
  const [renamingAntigravityAccount, setRenamingAntigravityAccount] = useState<Account | null>(null);
  const [newAntigravityAccountName, setNewAntigravityAccountName] = useState('');
  const [isRenamingAntigravity, setIsRenamingAntigravity] = useState(false);

  // 重命名 Qwen 账号 Dialog 状态
  // Project ID Dialog 状态（Antigravity）
  const [isProjectIdDialogOpen, setIsProjectIdDialogOpen] = useState(false);
  const [projectIdEditingAccount, setProjectIdEditingAccount] = useState<Account | null>(null);
  const [accountProjects, setAccountProjects] = useState<AccountProjects | null>(null);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [projectIdInput, setProjectIdInput] = useState('');
  const [projectIdSelectValue, setProjectIdSelectValue] = useState('');
  const [isUpdatingProjectId, setIsUpdatingProjectId] = useState(false);

  const [isQwenRenameDialogOpen, setIsQwenRenameDialogOpen] = useState(false);
  const [renamingQwenAccount, setRenamingQwenAccount] = useState<QwenAccount | null>(null);
  const [newQwenAccountName, setNewQwenAccountName] = useState('');
  const [isRenamingQwen, setIsRenamingQwen] = useState(false);

  // 重命名 Codex 账号 Dialog 状态
  const [isCodexRenameDialogOpen, setIsCodexRenameDialogOpen] = useState(false);
  const [renamingCodexAccount, setRenamingCodexAccount] = useState<CodexAccount | null>(null);
  const [newCodexAccountName, setNewCodexAccountName] = useState('');
  const [isRenamingCodex, setIsRenamingCodex] = useState(false);

  // Antigravity 账号详情 Dialog 状态
  const [isAntigravityDetailDialogOpen, setIsAntigravityDetailDialogOpen] = useState(false);
  const [antigravityDetail, setAntigravityDetail] = useState<AntigravityAccountDetail | null>(null);
  const [isLoadingAntigravityDetail, setIsLoadingAntigravityDetail] = useState(false);

  // Kiro 账号详情 Dialog 状态
  const [isKiroDetailDialogOpen, setIsKiroDetailDialogOpen] = useState(false);
  const [detailAccount, setDetailAccount] = useState<KiroAccount | null>(null);
  const [detailBalance, setDetailBalance] = useState<any>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isRefreshingAllKiroBalances, setIsRefreshingAllKiroBalances] = useState(false);
  const [refreshAllKiroProgress, setRefreshAllKiroProgress] = useState<{ current: number; total: number } | null>(null);

  // Codex 账号详情 Dialog 状态
  const [isCodexDetailDialogOpen, setIsCodexDetailDialogOpen] = useState(false);
  const [detailCodexAccount, setDetailCodexAccount] = useState<CodexAccount | null>(null);

  // GeminiCLI 账号详情 Dialog 状态
  const [isGeminiCliDetailDialogOpen, setIsGeminiCliDetailDialogOpen] = useState(false);
  const [detailGeminiCliAccount, setDetailGeminiCliAccount] = useState<GeminiCLIAccount | null>(null);

  // GeminiCLI 额度查询 Dialog 状态
  const [isGeminiCliQuotaDialogOpen, setIsGeminiCliQuotaDialogOpen] = useState(false);
  const [geminiCliQuotaAccount, setGeminiCliQuotaAccount] = useState<GeminiCLIAccount | null>(null);
  const [geminiCliQuotaData, setGeminiCliQuotaData] = useState<GeminiCLIQuotaData | null>(null);
  const [isLoadingGeminiCliQuota, setIsLoadingGeminiCliQuota] = useState(false);

  // ZAI TTS 编辑 Dialog
  const [isZaiTtsEditDialogOpen, setIsZaiTtsEditDialogOpen] = useState(false);
  const [editingZaiTtsAccount, setEditingZaiTtsAccount] = useState<ZaiTTSAccount | null>(null);
  const [zaiTtsEditAccountName, setZaiTtsEditAccountName] = useState('');
  const [zaiTtsEditUserId, setZaiTtsEditUserId] = useState('');
  const [zaiTtsEditToken, setZaiTtsEditToken] = useState('');
  const [zaiTtsEditVoiceId, setZaiTtsEditVoiceId] = useState('system_001');
  const [isUpdatingZaiTts, setIsUpdatingZaiTts] = useState(false);

  // ZAI Image 编辑 Dialog
  const [isZaiImageEditDialogOpen, setIsZaiImageEditDialogOpen] = useState(false);
  const [editingZaiImageAccount, setEditingZaiImageAccount] = useState<ZaiImageAccount | null>(null);
  const [zaiImageEditAccountName, setZaiImageEditAccountName] = useState('');
  const [zaiImageEditToken, setZaiImageEditToken] = useState('');
  const [isUpdatingZaiImage, setIsUpdatingZaiImage] = useState(false);

  // Codex 限额窗口（wham/usage）Dialog 状态
  const [isCodexWhamDialogOpen, setIsCodexWhamDialogOpen] = useState(false);
  const [codexWhamAccount, setCodexWhamAccount] = useState<CodexAccount | null>(null);
  const [codexWhamData, setCodexWhamData] = useState<CodexWhamUsageData | null>(null);
  const [isLoadingCodexWham, setIsLoadingCodexWham] = useState(false);
  const [isRefreshingAllCodexQuotas, setIsRefreshingAllCodexQuotas] = useState(false);
  const [refreshAllCodexProgress, setRefreshAllCodexProgress] = useState<{ current: number; total: number } | null>(null);

  // 确认对话框状态
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);
  const [confirmDialogConfig, setConfirmDialogConfig] = useState<{
    title: string;
    description: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'default' | 'destructive';
    onConfirm: () => void;
  } | null>(null);
  const [isConfirmLoading, setIsConfirmLoading] = useState(false);

  const formatGeminiCliResetTime = (value: string | null | undefined) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(date)
      .replace(/\//g, '-');
  };

  // Gemini 模型分层分组
  type GeminiTier = 'Pro' | 'Flash' | 'Other';
  interface GeminiTierGroup {
    tier: GeminiTier;
    remaining_fraction: number | null;
    reset_time: string | null;
  }

  const getGeminiModelTier = (modelId: string): GeminiTier => {
    const lower = modelId.toLowerCase();
    // Flash 层（包含 Flash Lite）
    if (lower.includes('flash')) {
      return 'Flash';
    }
    // Pro 层
    if (lower.includes('pro')) {
      return 'Pro';
    }
    return 'Other';
  };

  const groupGeminiQuotaByTier = (buckets: GeminiCLIQuotaData['buckets']): GeminiTierGroup[] => {
    const pickEarlierResetTime = (current: string | null, next: string | null): string | null => {
      if (!current) return next;
      if (!next) return current;
      const currentTime = new Date(current).getTime();
      const nextTime = new Date(next).getTime();
      if (Number.isNaN(currentTime)) return next;
      if (Number.isNaN(nextTime)) return current;
      return currentTime <= nextTime ? current : next;
    };

    const tierMap = new Map<
      GeminiTier,
      {
        fractions: number[];
        resetTimes: string[];
        items: Array<{ fraction: number; reset_time: string | null }>;
      }
    >();
    const tierOrder: GeminiTier[] = ['Pro', 'Flash', 'Other'];

    for (const bucket of buckets) {
      const tier = getGeminiModelTier(bucket.model_id);
      if (!tierMap.has(tier)) {
        tierMap.set(tier, { fractions: [], resetTimes: [], items: [] });
      }
      const group = tierMap.get(tier)!;
      if (bucket.remaining_fraction !== null && bucket.remaining_fraction !== undefined) {
        group.fractions.push(bucket.remaining_fraction);
        group.items.push({
          fraction: bucket.remaining_fraction,
          reset_time: bucket.reset_time ? bucket.reset_time : null,
        });
      }
      if (bucket.reset_time) {
        group.resetTimes.push(bucket.reset_time);
      }
    }

    const result: GeminiTierGroup[] = [];
    for (const tier of tierOrder) {
      const group = tierMap.get(tier);
      if (!group || group.fractions.length === 0) continue;

      // 取最小剩余比例（最保守估计）
      const minFraction = group.fractions.length > 0
        ? Math.min(...group.fractions)
        : null;

      // 重置时间要与 “最小 remaining_fraction” 对应的 bucket 对齐，否则展示会漂（甚至变成当前时间）。
      let earliestReset: string | null = null;
      if (minFraction !== null) {
        const minResetTimes = group.items
          .filter((it) => it.fraction === minFraction && it.reset_time)
          .map((it) => it.reset_time as string);
        if (minResetTimes.length > 0) {
          earliestReset = minResetTimes.reduce<string | null>(
            (acc, t) => pickEarlierResetTime(acc, t),
            null
          );
        }
      }
      if (!earliestReset) {
        earliestReset = group.resetTimes.reduce<string | null>(
          (acc, t) => pickEarlierResetTime(acc, t),
          null
        );
      }

      result.push({
        tier,
        remaining_fraction: minFraction,
        reset_time: earliestReset,
      });
    }

    return result;
  };

  const getKiroDisplayName = (account: KiroAccount) => {
    const name = (account.account_name || '').trim();
    const email = (account.email || '').trim();
    const isPlaceholderName =
      !name ||
      name === 'Kiro Account' ||
      name === 'Kiro Builder ID' ||
      name.startsWith('Kiro OAuth');

    if (email && isPlaceholderName) return email;
    return name || email || '未命名';
  };

  const loadAccounts = async () => {
    try {
      // 加载反重力账号
      const data = await getAccounts();
      if (Array.isArray(data)) {
        setAccounts(data);
      } else if (data && typeof data === 'object') {
        setAccounts((data as any).accounts || []);
      } else {
        setAccounts([]);
      }

      // 加载 Kiro 账号
      try {
        const kiroData = await getKiroAccounts();
        setKiroAccounts(kiroData);

        // 加载每个Kiro账号的余额
        const balances: Record<string, number> = {};
        await Promise.all(
          kiroData.map(async (account) => {
            try {
              const balanceData = await getKiroAccountBalance(account.account_id);
              balances[account.account_id] = balanceData.balance.available || 0;
            } catch (err) {
              console.error(`加载账号${account.account_id}余额失败:`, err);
              balances[account.account_id] = 0;
            }
          })
        );
        setKiroBalances(balances);
      } catch (err) {
        console.log('未加载Kiro账号');
        setKiroAccounts([]);
        setKiroBalances({});
      }

      // 加载 Qwen 账号
      try {
        const qwenData = await getQwenAccounts();
        setQwenAccounts(qwenData);
      } catch (err) {
        console.log('未加载Qwen账号');
        setQwenAccounts([]);
      }

      // 加载 Codex 账号
      try {
        const codexData = await getCodexAccounts();
        setCodexAccounts(codexData);
      } catch (err) {
        console.log('未加载Codex账号');
        setCodexAccounts([]);
      }

      // 加载 GeminiCLI 账号
      try {
        const geminiCliData = await getGeminiCLIAccounts();
        setGeminiCliAccounts(geminiCliData);
      } catch (err) {
        console.log('未加载GeminiCLI账号');
        setGeminiCliAccounts([]);
      }

      // 加载 ZAI TTS 账号
      try {
        const zaiTtsData = await getZaiTTSAccounts();
        setZaiTtsAccounts(zaiTtsData);
      } catch (err) {
        console.log('未加载ZAI TTS账号');
        setZaiTtsAccounts([]);
      }

      // 加载 ZAI Image 账号
      try {
        const zaiImageData = await getZaiImageAccounts();
        setZaiImageAccounts(zaiImageData);
      } catch (err) {
        console.log('未加载ZAI Image账号');
        setZaiImageAccounts([]);
      }
    } catch (err) {
      toasterRef.current?.show({
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载账号列表失败',
        variant: 'error',
        position: 'top-right',
      });
      setAccounts([]);
      setKiroAccounts([]);
      setQwenAccounts([]);
      setCodexAccounts([]);
      setZaiTtsAccounts([]);
      setZaiImageAccounts([]);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const settings = await getUiDefaultChannels();
        if (settings.accounts_default_channel) {
          setActiveTab(settings.accounts_default_channel);
        }
      } catch {
        // 不阻塞账户管理页面：设置读取失败时保持默认渠道
      } finally {
        loadAccounts();
      }
    };

    init();

    // 监听账号添加事件
    const handleAccountAdded = () => {
      loadAccounts();
    };

    window.addEventListener('accountAdded', handleAccountAdded);

    return () => {
      window.removeEventListener('accountAdded', handleAccountAdded);
    };
  }, []);

  const handleRefresh = () => {
    setIsRefreshing(true);
    loadAccounts();
  };

  const handleAddAccount = () => {
    setIsAddDrawerOpen(true);
  };

  const handleToggleStatus = async (account: Account) => {
    try {
      const newStatus = account.status === 1 ? 0 : 1;
      await updateAccountStatus(account.cookie_id, newStatus);
      // 更新本地状态
      setAccounts(accounts.map(a =>
        a.cookie_id === account.cookie_id
          ? { ...a, status: newStatus }
          : a
      ));
      toasterRef.current?.show({
        title: '状态已更新',
        message: `账号已${newStatus === 1 ? '启用' : '禁用'}`,
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新状态失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleRefreshAntigravityAccount = async (account: Account) => {
    setRefreshingCookieId(account.cookie_id);
    try {
      const updated = await refreshAccount(account.cookie_id);
      setAccounts(accounts.map(a =>
        a.cookie_id === account.cookie_id
          ? { ...a, ...updated }
          : a
      ));
      toasterRef.current?.show({
        title: '刷新成功',
        message: '已更新项目ID与Token',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '刷新失败',
        message: err instanceof Error ? err.message : '刷新账号失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setRefreshingCookieId(null);
    }
  };

  const handleEditProjectId = async (account: Account) => {
    setProjectIdEditingAccount(account);
    setAccountProjects(null);
    setProjectIdInput(account.project_id_0 || '');
    setProjectIdSelectValue('');
    setIsProjectIdDialogOpen(true);
    setIsLoadingProjects(true);

    try {
      const data = await getAccountProjects(account.cookie_id);
      setAccountProjects(data);

      const initial = (data.current_project_id || data.default_project_id || account.project_id_0 || '').trim();
      setProjectIdInput(initial);

      if (initial && Array.isArray(data.projects) && data.projects.some(p => p.project_id === initial)) {
        setProjectIdSelectValue(initial);
      } else {
        setProjectIdSelectValue('');
      }
    } catch (err) {
      toasterRef.current?.show({
        title: '获取项目列表失败',
        message: err instanceof Error ? err.message : '获取项目列表失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsLoadingProjects(false);
    }
  };

  const handleSubmitProjectId = async () => {
    if (!projectIdEditingAccount) return;

    const projectId = projectIdInput.trim();
    if (!projectId) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请输入 Project ID',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    setIsUpdatingProjectId(true);
    try {
      const updated = await updateAccountProjectId(projectIdEditingAccount.cookie_id, projectId);
      setAccounts(prev => prev.map(a => (a.cookie_id === updated.cookie_id ? { ...a, ...updated } : a)));

      toasterRef.current?.show({
        title: '更新成功',
        message: 'Project ID 已更新',
        variant: 'success',
        position: 'top-right',
      });

      setIsProjectIdDialogOpen(false);
      setProjectIdEditingAccount(null);
      setAccountProjects(null);
      setProjectIdInput('');
      setProjectIdSelectValue('');
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新Project ID失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsUpdatingProjectId(false);
    }
  };

  const handleCopyJson = async (data: Record<string, any>) => {
    const text = JSON.stringify(data);
    if (!text || text === '{}') {
      toasterRef.current?.show({
        title: '复制失败',
        message: '没有可导出的凭证字段',
        variant: 'error',
        position: 'top-right',
      });
      return;
    }

    await navigator.clipboard.writeText(text);
    toasterRef.current?.show({
      title: '复制成功',
      message: '凭证JSON已复制到剪贴板',
      variant: 'success',
      position: 'top-right',
    });
  };

  const handleCopyAntigravityCredentials = async (account: Account) => {
    try {
      const data = await getAccountCredentials(account.cookie_id);
      await handleCopyJson(data);
    } catch (err) {
      toasterRef.current?.show({
        title: '复制失败',
        message: err instanceof Error ? err.message : '复制凭证失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleCopyKiroCredentials = async (account: KiroAccount) => {
    try {
      const data = await getKiroAccountCredentials(account.account_id);
      await handleCopyJson(data);
    } catch (err) {
      toasterRef.current?.show({
        title: '复制失败',
        message: err instanceof Error ? err.message : '复制凭证失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleCopyQwenCredentials = async (account: QwenAccount) => {
    try {
      const data = await getQwenAccountCredentials(account.account_id);
      await handleCopyJson(data);
    } catch (err) {
      toasterRef.current?.show({
        title: '复制失败',
        message: err instanceof Error ? err.message : '复制凭证失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleCopyCodexCredentials = async (account: CodexAccount) => {
    try {
      const data = await getCodexAccountCredentials(account.account_id);
      await handleCopyJson(data);
    } catch (err) {
      toasterRef.current?.show({
        title: '复制失败',
        message: err instanceof Error ? err.message : '复制凭证失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const showConfirmDialog = (config: {
    title: string;
    description: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'default' | 'destructive';
    onConfirm: () => void;
  }) => {
    setConfirmDialogConfig(config);
    setIsConfirmDialogOpen(true);
  };

  const handleConfirmDialogConfirm = async () => {
    if (!confirmDialogConfig) return;
    setIsConfirmLoading(true);
    try {
      await confirmDialogConfig.onConfirm();
    } finally {
      setIsConfirmLoading(false);
      setIsConfirmDialogOpen(false);
      setConfirmDialogConfig(null);
    }
  };

  const handleDelete = (cookieId: string) => {
    showConfirmDialog({
      title: '删除账号',
      description: '确定要删除这个 Antigravity 账号吗？此操作无法撤销。',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await deleteAccount(cookieId);
          setAccounts(accounts.filter(a => a.cookie_id !== cookieId));
          toasterRef.current?.show({
            title: '删除成功',
            message: '账号已删除',
            variant: 'success',
            position: 'top-right',
          });
        } catch (err) {
          toasterRef.current?.show({
            title: '删除失败',
            message: err instanceof Error ? err.message : '删除失败',
            variant: 'error',
            position: 'top-right',
          });
        }
      },
    });
  };

  const handleDeleteKiro = (accountId: string) => {
    showConfirmDialog({
      title: '删除账号',
      description: '确定要删除这个 Kiro 账号吗？此操作无法撤销。',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await deleteKiroAccount(accountId);
          setKiroAccounts(kiroAccounts.filter(a => a.account_id !== accountId));
          toasterRef.current?.show({
            title: '删除成功',
            message: 'Kiro账号已删除',
            variant: 'success',
            position: 'top-right',
          });
        } catch (err) {
          toasterRef.current?.show({
            title: '删除失败',
            message: err instanceof Error ? err.message : '删除失败',
            variant: 'error',
            position: 'top-right',
          });
        }
      },
    });
  };

  const handleDeleteQwen = (accountId: string) => {
    showConfirmDialog({
      title: '删除账号',
      description: '确定要删除这个 Qwen 账号吗？此操作无法撤销。',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await deleteQwenAccount(accountId);
          setQwenAccounts(qwenAccounts.filter(a => a.account_id !== accountId));
          toasterRef.current?.show({
            title: '删除成功',
            message: 'Qwen账号已删除',
            variant: 'success',
            position: 'top-right',
          });
        } catch (err) {
          toasterRef.current?.show({
            title: '删除失败',
            message: err instanceof Error ? err.message : '删除失败',
            variant: 'error',
            position: 'top-right',
          });
        }
      },
    });
  };

  const handleDeleteCodex = (accountId: number) => {
    showConfirmDialog({
      title: '删除账号',
      description: '确定要删除这个 Codex 账号吗？此操作无法撤销。',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await deleteCodexAccount(accountId);
          setCodexAccounts(codexAccounts.filter((a) => a.account_id !== accountId));
          setCodexRefreshErrorById((prev) => {
            if (!(accountId in prev)) return prev;
            const next = { ...prev };
            delete next[accountId];
            return next;
          });
          toasterRef.current?.show({
            title: '删除成功',
            message: 'Codex账号已删除',
            variant: 'success',
            position: 'top-right',
          });
        } catch (err) {
          toasterRef.current?.show({
            title: '删除失败',
            message: err instanceof Error ? err.message : '删除失败',
            variant: 'error',
            position: 'top-right',
          });
        }
      },
    });
  };

  const handleToggleKiroStatus = async (account: KiroAccount) => {
    try {
      const newStatus = account.status === 1 ? 0 : 1;
      await updateKiroAccountStatus(account.account_id, newStatus);
      setKiroAccounts(kiroAccounts.map(a =>
        a.account_id === account.account_id
          ? { ...a, status: newStatus }
          : a
      ));
      toasterRef.current?.show({
        title: '状态已更新',
        message: `账号已${newStatus === 1 ? '启用' : '禁用'}`,
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新状态失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleToggleQwenStatus = async (account: QwenAccount) => {
    try {
      const newStatus = account.status === 1 ? 0 : 1;
      await updateQwenAccountStatus(account.account_id, newStatus);
      setQwenAccounts(qwenAccounts.map(a =>
        a.account_id === account.account_id
          ? { ...a, status: newStatus }
          : a
      ));
      toasterRef.current?.show({
        title: '状态已更新',
        message: `账号已${newStatus === 1 ? '启用' : '禁用'}`,
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新状态失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleToggleCodexStatus = async (account: CodexAccount) => {
    try {
      const newStatus = account.status === 1 ? 0 : 1;
      if (newStatus === 1 && account.is_frozen) {
        const untilText = account.frozen_until ? new Date(account.frozen_until).toLocaleString('zh-CN') : '未知';
        toasterRef.current?.show({
          title: '无法启用',
          message: `账号冻结中，解冻时间：${untilText}`,
          variant: 'warning',
          position: 'top-right',
        });
        return;
      }
      const updated = await updateCodexAccountStatus(account.account_id, newStatus);
      setCodexAccounts(
        codexAccounts.map((a) => (a.account_id === account.account_id ? { ...a, ...updated } : a))
      );
      toasterRef.current?.show({
        title: '状态已更新',
        message: `账号已${newStatus === 1 ? '启用' : '禁用'}`,
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新状态失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  // GeminiCLI 账号处理函数
  const handleCopyGeminiCLICredentials = async (account: GeminiCLIAccount) => {
    try {
      const data = await getGeminiCLIAccountCredentials(account.account_id);
      await handleCopyJson(data);
    } catch (err) {
      toasterRef.current?.show({
        title: '复制失败',
        message: err instanceof Error ? err.message : '复制凭证失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleViewGeminiCliQuota = async (account: GeminiCLIAccount) => {
    setGeminiCliQuotaAccount(account);
    setIsGeminiCliQuotaDialogOpen(true);
    setIsLoadingGeminiCliQuota(true);
    setGeminiCliQuotaData(null);

    try {
      const data = await getGeminiCLIAccountQuota(account.account_id);
      setGeminiCliQuotaData(data);
    } catch (err) {
      toasterRef.current?.show({
        title: '查询失败',
        message: err instanceof Error ? err.message : '查询额度失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsLoadingGeminiCliQuota(false);
    }
  };

  const handleDeleteGeminiCLIAccount = (accountId: number) => {
    showConfirmDialog({
      title: '删除账号',
      description: '确定要删除这个 GeminiCLI 账号吗？此操作无法撤销。',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await deleteGeminiCLIAccount(accountId);
          setGeminiCliAccounts(geminiCliAccounts.filter((a) => a.account_id !== accountId));
          toasterRef.current?.show({
            title: '删除成功',
            message: 'GeminiCLI账号已删除',
            variant: 'success',
            position: 'top-right',
          });
        } catch (err) {
          toasterRef.current?.show({
            title: '删除失败',
            message: err instanceof Error ? err.message : '删除失败',
            variant: 'error',
            position: 'top-right',
          });
        }
      },
    });
  };

  const handleToggleGeminiCLIStatus = async (account: GeminiCLIAccount) => {
    try {
      const newStatus = account.status === 1 ? 0 : 1;
      const updated = await updateGeminiCLIAccountStatus(account.account_id, newStatus);
      setGeminiCliAccounts(
        geminiCliAccounts.map((a) => (a.account_id === account.account_id ? { ...a, ...updated } : a))
      );
      toasterRef.current?.show({
        title: '状态已更新',
        message: `账号已${newStatus === 1 ? '启用' : '禁用'}`,
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新状态失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  // ZAI TTS 账号处理函数
  const handleToggleZaiTtsStatus = async (account: ZaiTTSAccount) => {
    try {
      const newStatus = account.status === 1 ? 0 : 1;
      const updated = await updateZaiTTSAccountStatus(account.account_id, newStatus);
      setZaiTtsAccounts(
        zaiTtsAccounts.map((a) => (a.account_id === account.account_id ? { ...a, ...updated } : a))
      );
      toasterRef.current?.show({
        title: '状态已更新',
        message: `账号已${newStatus === 1 ? '启用' : '禁用'}`,
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新状态失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleEditZaiTtsAccount = (account: ZaiTTSAccount) => {
    setEditingZaiTtsAccount(account);
    setZaiTtsEditAccountName(account.account_name || '');
    setZaiTtsEditUserId(account.zai_user_id || '');
    setZaiTtsEditToken('');
    setZaiTtsEditVoiceId(account.voice_id || 'system_001');
    setIsZaiTtsEditDialogOpen(true);
  };

  const handleSubmitZaiTtsEdit = async () => {
    if (!editingZaiTtsAccount) return;

    const accountName = zaiTtsEditAccountName.trim();
    const userId = zaiTtsEditUserId.trim();
    const voiceId = zaiTtsEditVoiceId.trim();
    const token = zaiTtsEditToken.trim();

    if (!accountName || !userId || !voiceId) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '账号名称、ZAI_USERID、音色ID 不能为空',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    setIsUpdatingZaiTts(true);
    try {
      let updated = editingZaiTtsAccount;
      if (accountName !== editingZaiTtsAccount.account_name) {
        updated = await updateZaiTTSAccountName(editingZaiTtsAccount.account_id, accountName);
      }

      const credentialPayload: { zai_user_id: string; voice_id: string; token?: string } = {
        zai_user_id: userId,
        voice_id: voiceId,
      };
      if (token) credentialPayload.token = token;
      updated = await updateZaiTTSAccountCredentials(editingZaiTtsAccount.account_id, credentialPayload);

      setZaiTtsAccounts(
        zaiTtsAccounts.map((a) => (a.account_id === editingZaiTtsAccount.account_id ? { ...a, ...updated } : a))
      );

      setIsZaiTtsEditDialogOpen(false);
      toasterRef.current?.show({
        title: '更新成功',
        message: 'ZAI TTS 账号已更新',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新账号失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsUpdatingZaiTts(false);
    }
  };

  const handleDeleteZaiTtsAccount = (accountId: number) => {
    showConfirmDialog({
      title: '删除账号',
      description: '确定要删除这个 ZAI TTS 账号吗？此操作无法撤销。',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await deleteZaiTTSAccount(accountId);
          setZaiTtsAccounts(zaiTtsAccounts.filter((a) => a.account_id !== accountId));
          toasterRef.current?.show({
            title: '删除成功',
            message: 'ZAI TTS 账号已删除',
            variant: 'success',
            position: 'top-right',
          });
        } catch (err) {
          toasterRef.current?.show({
            title: '删除失败',
            message: err instanceof Error ? err.message : '删除失败',
            variant: 'error',
            position: 'top-right',
          });
        }
      },
    });
  };

  // ZAI Image 账号处理函数
  const handleToggleZaiImageStatus = async (account: ZaiImageAccount) => {
    try {
      const newStatus = account.status === 1 ? 0 : 1;
      const updated = await updateZaiImageAccountStatus(account.account_id, newStatus);
      setZaiImageAccounts(
        zaiImageAccounts.map((a) => (a.account_id === account.account_id ? { ...a, ...updated } : a))
      );
      toasterRef.current?.show({
        title: '状态已更新',
        message: `账号已${newStatus === 1 ? '启用' : '禁用'}`,
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新状态失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handleEditZaiImageAccount = (account: ZaiImageAccount) => {
    setEditingZaiImageAccount(account);
    setZaiImageEditAccountName(account.account_name || '');
    setZaiImageEditToken('');
    setIsZaiImageEditDialogOpen(true);
  };

  const handleSubmitZaiImageEdit = async () => {
    if (!editingZaiImageAccount) return;

    const accountName = zaiImageEditAccountName.trim();
    const token = zaiImageEditToken.trim();

    if (!accountName) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '账号名称不能为空',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    setIsUpdatingZaiImage(true);
    try {
      let updated = editingZaiImageAccount;
      if (accountName !== editingZaiImageAccount.account_name) {
        updated = await updateZaiImageAccountName(editingZaiImageAccount.account_id, accountName);
      }

      if (token) {
        updated = await updateZaiImageAccountCredentials(editingZaiImageAccount.account_id, { token });
      }

      setZaiImageAccounts(
        zaiImageAccounts.map((a) => (a.account_id === editingZaiImageAccount.account_id ? { ...a, ...updated } : a))
      );

      setIsZaiImageEditDialogOpen(false);
      toasterRef.current?.show({
        title: '更新成功',
        message: 'ZAI Image 账号已更新',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新账号失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsUpdatingZaiImage(false);
    }
  };

  const handleDeleteZaiImageAccount = (accountId: number) => {
    showConfirmDialog({
      title: '删除账号',
      description: '确定要删除这个 ZAI Image 账号吗？此操作无法撤销。',
      confirmText: '删除',
      cancelText: '取消',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await deleteZaiImageAccount(accountId);
          setZaiImageAccounts(zaiImageAccounts.filter((a) => a.account_id !== accountId));
          toasterRef.current?.show({
            title: '删除成功',
            message: 'ZAI Image 账号已删除',
            variant: 'success',
            position: 'top-right',
          });
        } catch (err) {
          toasterRef.current?.show({
            title: '删除失败',
            message: err instanceof Error ? err.message : '删除失败',
            variant: 'error',
            position: 'top-right',
          });
        }
      },
    });
  };

  const handleRenameKiro = (account: KiroAccount) => {
    setRenamingAccount(account);
    setNewAccountName(account.account_name || account.email || '');
    setIsRenameDialogOpen(true);
  };

  const handleRenameQwen = (account: QwenAccount) => {
    setRenamingQwenAccount(account);
    setNewQwenAccountName(account.account_name || account.email || '');
    setIsQwenRenameDialogOpen(true);
  };

  const handleRenameCodex = (account: CodexAccount) => {
    setRenamingCodexAccount(account);
    setNewCodexAccountName(account.account_name || account.email || '');
    setIsCodexRenameDialogOpen(true);
  };

  const handleRenameAntigravity = (account: Account) => {
    setRenamingAntigravityAccount(account);
    setNewAntigravityAccountName(account.name || '');
    setIsAntigravityRenameDialogOpen(true);
  };

  const handleSubmitAntigravityRename = async () => {
    if (!renamingAntigravityAccount) return;

    if (!newAntigravityAccountName.trim()) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '账号名称不能为空',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    setIsRenamingAntigravity(true);
    try {
      await updateAccountName(renamingAntigravityAccount.cookie_id, newAntigravityAccountName.trim());
      setAccounts(accounts.map(a =>
        a.cookie_id === renamingAntigravityAccount.cookie_id
          ? { ...a, name: newAntigravityAccountName.trim() }
          : a
      ));
      setIsAntigravityRenameDialogOpen(false);
      toasterRef.current?.show({
        title: '重命名成功',
        message: '账号名称已更新',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '重命名失败',
        message: err instanceof Error ? err.message : '更新账号名称失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsRenamingAntigravity(false);
    }
  };

  const handleSubmitQwenRename = async () => {
    if (!renamingQwenAccount) return;

    if (!newQwenAccountName.trim()) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '账号名称不能为空',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    setIsRenamingQwen(true);
    try {
      await updateQwenAccountName(renamingQwenAccount.account_id, newQwenAccountName.trim());
      setQwenAccounts(qwenAccounts.map(a =>
        a.account_id === renamingQwenAccount.account_id
          ? { ...a, account_name: newQwenAccountName.trim() }
          : a
      ));
      setIsQwenRenameDialogOpen(false);
      toasterRef.current?.show({
        title: '重命名成功',
        message: '账号名称已更新',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '重命名失败',
        message: err instanceof Error ? err.message : '更新账号名称失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsRenamingQwen(false);
    }
  };

  const handleSubmitCodexRename = async () => {
    if (!renamingCodexAccount) return;

    if (!newCodexAccountName.trim()) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '账号名称不能为空',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    setIsRenamingCodex(true);
    try {
      const updated = await updateCodexAccountName(
        renamingCodexAccount.account_id,
        newCodexAccountName.trim()
      );
      setCodexAccounts(
        codexAccounts.map((a) =>
          a.account_id === renamingCodexAccount.account_id ? { ...a, ...updated } : a
        )
      );
      setIsCodexRenameDialogOpen(false);
      toasterRef.current?.show({
        title: '重命名成功',
        message: '账号名称已更新',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '重命名失败',
        message: err instanceof Error ? err.message : '更新账号名称失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsRenamingCodex(false);
    }
  };

  const handleSubmitRename = async () => {
    if (!renamingAccount) return;

    if (!newAccountName.trim()) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '账号名称不能为空',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    setIsRenaming(true);
    try {
      await updateKiroAccountName(renamingAccount.account_id, newAccountName.trim());
      setKiroAccounts(kiroAccounts.map(a =>
        a.account_id === renamingAccount.account_id
          ? { ...a, account_name: newAccountName.trim() }
          : a
      ));
      setIsRenameDialogOpen(false);
      toasterRef.current?.show({
        title: '重命名成功',
        message: '账号名称已更新',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '重命名失败',
        message: err instanceof Error ? err.message : '更新账号名称失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsRenaming(false);
    }
  };

  const handleRefreshCodexOfficial = async (account: CodexAccount) => {
    const accountId = account.account_id;
    setRefreshingCodexAccountId(accountId);
    try {
      const updated = await refreshCodexAccount(accountId);
      setCodexAccounts((prev) => prev.map((a) => (a.account_id === accountId ? { ...a, ...updated } : a)));
      setDetailCodexAccount((prev) => (prev && prev.account_id === accountId ? { ...prev, ...updated } : prev));
      setCodexWhamAccount((prev) => (prev && prev.account_id === accountId ? { ...prev, ...updated } : prev));
      setCodexRefreshErrorById((prev) => {
        if (!(accountId in prev)) return prev;
        const next = { ...prev };
        delete next[accountId];
        return next;
      });
      toasterRef.current?.show({
        title: '刷新成功',
        message: '已从官方刷新额度/限额',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '刷新账号信息失败';
      setCodexRefreshErrorById((prev) => ({ ...prev, [accountId]: message }));
      toasterRef.current?.show({
        title: '刷新失败',
        message,
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setRefreshingCodexAccountId(null);
    }
  };

  const handleRefreshAllCodexQuotas = async () => {
    if (isRefreshingAllCodexQuotas) return;
    if (!codexAccounts.length) return;

    const accountsToRefresh = codexAccounts;
    const total = accountsToRefresh.length;

    setIsRefreshingAllCodexQuotas(true);
    setRefreshAllCodexProgress({ current: 0, total });

    let okCount = 0;
    let failCount = 0;

    try {
      // 一个个刷新，避免并发打爆上游/触发风控
      for (let i = 0; i < accountsToRefresh.length; i++) {
        const account = accountsToRefresh[i];
        const accountId = account.account_id;
        setRefreshAllCodexProgress({ current: i + 1, total });
        setRefreshingCodexAccountId(accountId);

        try {
          const updated = await refreshCodexAccount(accountId);
          okCount += 1;
          setCodexAccounts((prev) => prev.map((a) => (a.account_id === accountId ? { ...a, ...updated } : a)));
          setDetailCodexAccount((prev) => (prev && prev.account_id === accountId ? { ...prev, ...updated } : prev));
          setCodexWhamAccount((prev) => (prev && prev.account_id === accountId ? { ...prev, ...updated } : prev));
          setCodexRefreshErrorById((prev) => {
            if (!(accountId in prev)) return prev;
            const next = { ...prev };
            delete next[accountId];
            return next;
          });
        } catch (err) {
          failCount += 1;
          console.warn('刷新 Codex 账号失败:', accountId, err);
          const message = err instanceof Error ? err.message : '刷新账号信息失败';
          setCodexRefreshErrorById((prev) => ({ ...prev, [accountId]: message }));
        }
      }
    } finally {
      setRefreshingCodexAccountId(null);
      setRefreshAllCodexProgress(null);
      setIsRefreshingAllCodexQuotas(false);
    }

    toasterRef.current?.show({
      title: '批量刷新完成',
      message:
        failCount > 0
          ? `已刷新 ${okCount}/${total} 个账号的剩余额度（失败 ${failCount} 个）`
          : `已刷新 ${okCount}/${total} 个账号的剩余额度`,
      variant: failCount > 0 ? 'warning' : 'success',
      position: 'top-right',
    });
  };

  const handleViewCodexWhamUsage = async (account: CodexAccount) => {
    setCodexWhamAccount(account);
    setIsCodexWhamDialogOpen(true);
    setIsLoadingCodexWham(true);
    setCodexWhamData(null);

    try {
      const data = await getCodexWhamUsage(account.account_id);
      setCodexWhamData(data);
    } catch (err) {
      toasterRef.current?.show({
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载限额窗口失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsLoadingCodexWham(false);
    }
  };

  const handleViewCodexDetail = (account: CodexAccount) => {
    setDetailCodexAccount(account);
    setIsCodexDetailDialogOpen(true);
  };

  const handleViewKiroDetail = async (account: KiroAccount) => {
    setDetailAccount(account);
    setIsKiroDetailDialogOpen(true);
    setIsLoadingDetail(true);
    setDetailBalance(null);

    try {
      const balanceData = await getKiroAccountBalance(account.account_id, { refresh: true });
      setDetailBalance(balanceData);
      setKiroBalances((prev) => ({ ...prev, [account.account_id]: balanceData.balance.available || 0 }));

      if (balanceData.upstream_feedback?.raw || balanceData.upstream_feedback?.message) {
        toasterRef.current?.show({
          title: `Kiro接口反馈 (HTTP ${balanceData.upstream_feedback.status_code})`,
          message: balanceData.upstream_feedback.raw || balanceData.upstream_feedback.message,
          variant: 'warning',
          position: 'top-right',
        });
      }
    } catch (err) {
      toasterRef.current?.show({
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载余额信息失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleRefreshAllKiroBalances = async () => {
    if (isRefreshingAllKiroBalances) return;
    if (!kiroAccounts.length) return;

    const accountsToRefresh = kiroAccounts;
    const total = accountsToRefresh.length;

    setIsRefreshingAllKiroBalances(true);
    setRefreshAllKiroProgress({ current: 0, total });

    let okCount = 0;
    let failCount = 0;

    try {
      // 逐个刷新，避免并发打爆上游/触发风控
      for (let i = 0; i < accountsToRefresh.length; i++) {
        const account = accountsToRefresh[i];
        const accountId = account.account_id;
        setRefreshAllKiroProgress({ current: i + 1, total });

        try {
          const balanceData = await getKiroAccountBalance(accountId, { refresh: true });
          okCount += 1;
          setKiroBalances((prev) => ({ ...prev, [accountId]: balanceData.balance.available || 0 }));
          setDetailBalance((prev) => (prev && prev.account_id === accountId ? balanceData : prev));
        } catch (err) {
          failCount += 1;
          console.warn('刷新 Kiro 账号余额失败:', accountId, err);
        }
      }
    } finally {
      setRefreshAllKiroProgress(null);
      setIsRefreshingAllKiroBalances(false);
    }

    toasterRef.current?.show({
      title: '批量刷新完成',
      message:
        failCount > 0
          ? `已刷新 ${okCount}/${total} 个账号的余额（失败 ${failCount} 个）`
          : `已刷新 ${okCount}/${total} 个账号的余额`,
      variant: failCount > 0 ? 'warning' : 'success',
      position: 'top-right',
    });
  };

  const handleViewAntigravityDetail = async (account: Account) => {
    setIsAntigravityDetailDialogOpen(true);
    setIsLoadingAntigravityDetail(true);
    setAntigravityDetail(null);

    try {
      const detail = await getAntigravityAccountDetail(account.cookie_id);
      setAntigravityDetail(detail);
    } catch (err) {
      toasterRef.current?.show({
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载账号详情失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsLoadingAntigravityDetail(false);
    }
  };

  const handleViewGeminiCliDetail = (account: GeminiCLIAccount) => {
    setDetailGeminiCliAccount(account);
    setIsGeminiCliDetailDialogOpen(true);
  };

  const handleViewQuotas = async (account: Account) => {
    setCurrentAccount(account);
    setIsQuotaDialogOpen(true);
    setIsLoadingQuotas(true);
    setQuotas(null);

    try {
      const quotaData = await getAccountQuotas(account.cookie_id);
      setQuotas(quotaData);
    } catch (err) {
      toasterRef.current?.show({
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载配额信息失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsLoadingQuotas(false);
    }
  };

  const handleToggleQuotaStatus = async (modelName: string, currentStatus: number) => {
    if (!currentAccount) return;

    const newStatus = currentStatus === 1 ? 0 : 1;

    try {
      await updateQuotaStatus(currentAccount.cookie_id, modelName, newStatus);
      // 更新本地状态
      setQuotas((prevQuotas: any) =>
        prevQuotas.map((q: any) =>
          q.model_name === modelName ? { ...q, status: newStatus } : q
        )
      );
      toasterRef.current?.show({
        title: '状态已更新',
        message: `模型 ${getModelDisplayName(modelName)} 已${newStatus === 1 ? '启用' : '禁用'}`,
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新模型状态失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const MODEL_ORDER: string[] = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-thinking',
    'gemini-2.5-flash-image',
    'gemini-2.5-pro',
    'gemini-3-pro-low',
    'gemini-3-pro-high',
    'gemini-3-pro-image',
    'chat_20706',
    'chat_23310',
    'rev19-uic3-1p',
    'gpt-oss-120b-medium',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-thinking',
    'claude-opus-4-6-thinking',
    'claude-opus-4-5-thinking',
  ];

  const getModelDisplayName = (model: string) => {
    const modelNames: Record<string, string> = {
      'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
      'claude-sonnet-4-5-thinking': 'Claude Sonnet 4.5 (Thinking)',
      'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
      'claude-opus-4-5-thinking': 'Claude Opus 4.5 (Thinking)',
      'gemini-2.5-flash-image': 'Gemini 2.5 Flash Image',
      'gemini-2.5-flash-thinking': 'Gemini 2.5 Flash (Thinking)',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gpt-oss-120b-medium': 'GPT OSS 120B (Medium)',
      'gemini-3-pro-image': 'Gemini 3 Pro Image',
      'gemini-3-pro-high': 'Gemini 3 Pro (High)',
      'gemini-3-pro-low': 'Gemini 3 Pro (Low)',
      'claude-sonnet-4-5': 'Claude Sonnet 4.5',
      'rev19-uic3-1p': 'Rev19 UIC3 1P',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'chat_20706': 'Chat 20706',
      'chat_23310': 'Chat 23310',
    };
    return modelNames[model] || model;
  };

  const sortQuotas = (quotaList: any[]) => {
    if (!quotaList || !Array.isArray(quotaList)) return quotaList;
    return [...quotaList].sort((a, b) => {
      const indexA = MODEL_ORDER.indexOf(a.model_name);
      const indexB = MODEL_ORDER.indexOf(b.model_name);
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });
  };

  const getModelIcon = (modelName: string) => {
    const lowerName = modelName.toLowerCase();
    if (lowerName.includes('gemini')) {
      return <Gemini.Color className="size-5" />;
    } else if (lowerName.includes('claude')) {
      return <Claude.Color className="size-5" />;
    } else if (lowerName.includes('gpt')) {
      return <OpenAI className="size-5" />;
    } else {
      return <img src="/logo_light.png" alt="" className="size-5" />;
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden py-4 md:gap-6 md:py-6">
        <div className="flex min-h-0 flex-1 flex-col px-4 lg:px-6">
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <MorphingSquare message="加载中..." />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden py-4 md:gap-6 md:py-6">
      <div className="flex min-h-0 flex-1 flex-col px-4 lg:px-6">
        {/* 页面标题和操作 */}
        <div className="mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div></div>
            <div className="flex flex-wrap items-center gap-2">
              {/* 账号配置切换下拉菜单 */}
              <Select value={activeTab} onValueChange={(value: 'antigravity' | 'kiro' | 'qwen' | 'codex' | 'gemini' | 'zai-tts' | 'zai-image') => setActiveTab(value)}>
                <SelectTrigger className="w-[140px] sm:w-[160px] h-9">
                  <SelectValue>
                    {activeTab === 'antigravity' ? (
                      <span className="flex items-center gap-2">
                        <img src="/antigravity-logo.png" alt="" className="size-4 rounded" />
                        <span className="hidden sm:inline">Antigravity</span>
                        <span className="sm:hidden">Anti</span>
                      </span>
                    ) : activeTab === 'kiro' ? (
                      <span className="flex items-center gap-2">
                        <img src="/kiro.png" alt="" className="size-4 rounded" />
                        Kiro
                      </span>
                    ) : activeTab === 'qwen' ? (
                      <span className="flex items-center gap-2">
                        <Qwen className="size-4" />
                        Qwen
                      </span>
                    ) : activeTab === 'zai-tts' ? (
                      <span className="flex items-center gap-2">
                        <OpenAI className="size-4" />
                        ZAI TTS
                      </span>
                    ) : activeTab === 'zai-image' ? (
                      <span className="flex items-center gap-2">
                        <OpenAI className="size-4" />
                        ZAI Image
                      </span>
                    ) : activeTab === 'gemini' ? (
                      <span className="flex items-center gap-2">
                        <Gemini className="size-4" />
                        GeminiCLI
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <OpenAI className="size-4" />
                        Codex
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="antigravity">
                    <span className="flex items-center gap-2">
                      <img src="/antigravity-logo.png" alt="" className="size-4 rounded" />
                      Antigravity
                    </span>
                  </SelectItem>
                  <SelectItem value="kiro">
                    <span className="flex items-center gap-2">
                      <img src="/kiro.png" alt="" className="size-4 rounded" />
                      Kiro
                    </span>
                  </SelectItem>
                  <SelectItem value="qwen">
                    <span className="flex items-center gap-2">
                      <Qwen className="size-4" />
                      Qwen
                    </span>
                  </SelectItem>
                  <SelectItem value="zai-tts">
                    <span className="flex items-center gap-2">
                      <OpenAI className="size-4" />
                      ZAI TTS
                    </span>
                  </SelectItem>
                  <SelectItem value="zai-image">
                    <span className="flex items-center gap-2">
                      <OpenAI className="size-4" />
                      ZAI Image
                    </span>
                  </SelectItem>
                  <SelectItem value="codex">
                    <span className="flex items-center gap-2">
                      <OpenAI className="size-4" />
                      Codex
                    </span>
                  </SelectItem>
                  <SelectItem value="gemini">
                    <span className="flex items-center gap-2">
                      <Gemini className="size-4" />
                      GeminiCLI
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="default"
                onClick={handleRefresh}
                disabled={isRefreshing || (activeTab === 'codex' && isRefreshingAllCodexQuotas)}
              >
                {isRefreshing ? (
                  <MorphingSquare className="size-4" />
                ) : (
                  <IconRefresh className="size-4" />
                )}
                <span className="ml-2 hidden sm:inline">刷新</span>
              </Button>
              <Button size="default" onClick={handleAddAccount}>
                <IconCirclePlusFilled className="size-4" />
                <span className="ml-2">添加账号</span>
              </Button>
            </div>
          </div>
        </div>

        <Toaster ref={toasterRef} defaultPosition="top-right" />

        {/* 反重力账号列表 */}
        {activeTab === 'antigravity' && (
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="text-left">
              <CardTitle className="text-left">Antigravity账号</CardTitle>
              <CardDescription className="text-left">
                共 {accounts.length} 个账号
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {accounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无Antigravity账号</p>
                  <p className="text-sm">点击“添加账号”按钮添加您的第一个账号</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[200px]">账号 ID</TableHead>
                          <TableHead className="min-w-[220px]">Project ID</TableHead>
                          <TableHead className="min-w-[120px]">账号名称</TableHead>
                          <TableHead className="min-w-[80px]">状态</TableHead>
                          <TableHead className="min-w-[100px]">添加时间</TableHead>
                          <TableHead className="min-w-[100px]">最后使用</TableHead>
                          <TableHead className="text-right min-w-[80px]">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {accounts.map((account) => (
                          <TableRow key={account.cookie_id}>
                            <TableCell className="font-mono text-sm">
                              <div className="max-w-[200px] truncate" title={account.cookie_id}>
                                {account.cookie_id}
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              <div className="max-w-[220px] truncate" title={account.project_id_0 || ''}>
                                {account.project_id_0 || '-'}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {account.status === 0 && !account.project_id_0 && !account.paid_tier && (
                                  <Tooltip
                                    containerClassName="pointer-events-auto"
                                    content={
                                      <div className="space-y-1">
                                        <p className="font-medium">你的账号暂时无权使用Antigravity。</p>
                                        <div className="text-xs space-y-0.5">
                                          我们暂时禁用了你的Antigravity账号。这可能是因为{account.is_restricted && <p> • 你的账号处于受限制的国家或地区。</p>}{account.ineligible && <p> • 你的账号没有Google AI使用资格。</p>}如果你恢复了Antigravity的访问权限，你可手动启用该账号。
                                        </div>
                                      </div>
                                    }
                                  >
                                    <IconAlertTriangle className="size-4 text-amber-500 shrink-0 cursor-help" />
                                  </Tooltip>
                                )}
                                <span>{account.name || '未命名'}</span>
                                {account.need_refresh && (
                                  <Badge variant="outline" className="text-yellow-600 border-yellow-600 bg-yellow-50 dark:bg-yellow-900/20">
                                    <IconAlertTriangle className="size-3 mr-1" />
                                    需要重新登录
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant={account.status === 1 ? 'default' : 'outline'} className="whitespace-nowrap">
                                {account.status === 1 ? '启用' : '禁用'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {new Date(account.created_at).toLocaleDateString('zh-CN')}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {account.last_used_at
                                ? new Date(account.last_used_at).toLocaleDateString('zh-CN')
                                : '从未使用'
                              }
                            </TableCell>
                            <TableCell className="text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    <IconDotsVertical className="size-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                   <DropdownMenuItem onClick={() => handleViewAntigravityDetail(account)}>
                                     <IconExternalLink className="size-4 mr-2" />
                                     详细信息
                                   </DropdownMenuItem>
                                   <DropdownMenuItem onClick={() => handleViewQuotas(account)}>
                                   <IconChartBar className="size-4 mr-2" />
                                    查看配额
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleCopyAntigravityCredentials(account)}>
                                    <IconCopy className="size-4 mr-2" />
                                    复制凭证为JSON
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleRefreshAntigravityAccount(account)}
                                    disabled={refreshingCookieId === account.cookie_id}
                                  >
                                    <IconRefresh className="size-4 mr-2" />
                                    {refreshingCookieId === account.cookie_id ? '刷新中...' : '刷新项目ID'}
                                  </DropdownMenuItem>
                                   <DropdownMenuItem onClick={() => handleEditProjectId(account)}>
                                     <IconEdit className="size-4 mr-2" />
                                     修改项目ID
                                   </DropdownMenuItem>
                                   <DropdownMenuItem onClick={() => handleRenameAntigravity(account)}>
                                    <IconEdit className="size-4 mr-2" />
                                    重命名
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleToggleStatus(account)}>
                                    {account.status === 1 ? (
                                      <>
                                        <IconToggleLeft className="size-4 mr-2" />
                                        禁用
                                      </>
                                    ) : (
                                      <>
                                        <IconToggleRight className="size-4 mr-2" />
                                        启用
                                      </>
                                    )}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleDelete(account.cookie_id)}
                                    className="text-red-600"
                                  >
                                    <IconTrash className="size-4 mr-2" />
                                    删除
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Kiro账号列表 */}
        {activeTab === 'kiro' && (
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="text-left">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-left">Kiro账号</CardTitle>
                  <CardDescription className="text-left">
                    共 {kiroAccounts.length} 个账号
                    {isRefreshingAllKiroBalances && refreshAllKiroProgress
                      ? `，正在刷新 ${refreshAllKiroProgress.current}/${refreshAllKiroProgress.total}`
                      : ''}
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="default"
                  onClick={handleRefreshAllKiroBalances}
                  disabled={isRefreshingAllKiroBalances || kiroAccounts.length === 0}
                >
                  {isRefreshingAllKiroBalances ? (
                    <MorphingSquare className="size-4" />
                  ) : (
                    <IconRefresh className="size-4" />
                  )}
                  <span className="ml-2">刷新全部余额</span>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {kiroAccounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无Kiro账号</p>
                  <p className="text-sm">点击“添加账号”按钮添加您的第一个Kiro账号</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[100px]">账号ID</TableHead>
                        <TableHead className="min-w-[150px]">账号名称</TableHead>
                        <TableHead className="min-w-[100px]">余额</TableHead>
                        <TableHead className="min-w-[80px]">状态</TableHead>
                        <TableHead className="min-w-[100px]">添加时间</TableHead>
                        <TableHead className="text-right min-w-[80px]">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {kiroAccounts.map((account) => (
                        <TableRow key={account.account_id}>
                          <TableCell className="font-mono text-sm">
                            {account.account_id}
                          </TableCell>
                          <TableCell>
                            {getKiroDisplayName(account)}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {kiroBalances[account.account_id] !== undefined
                              ? `$${Number(kiroBalances[account.account_id] || 0).toFixed(2)}`
                              : '加载中...'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={account.status === 1 ? 'default' : 'outline'} className="whitespace-nowrap">
                              {account.status === 1 ? '启用' : '禁用'}     
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {new Date(account.created_at).toLocaleDateString('zh-CN')}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm">
                                  <IconDotsVertical className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleViewKiroDetail(account)}>
                                  <IconChartBar className="size-4 mr-2" />
                                  详细信息
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleCopyKiroCredentials(account)}>
                                  <IconCopy className="size-4 mr-2" />
                                  复制凭证为JSON
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleRenameKiro(account)}>
                                  <IconEdit className="size-4 mr-2" />
                                  重命名
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleToggleKiroStatus(account)}>
                                  {account.status === 1 ? (
                                    <>
                                      <IconToggleLeft className="size-4 mr-2" />
                                      禁用
                                    </>
                                  ) : (
                                    <>
                                      <IconToggleRight className="size-4 mr-2" />
                                      启用
                                    </>
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleDeleteKiro(account.account_id)}
                                  className="text-red-600"
                                >
                                  <IconTrash className="size-4 mr-2" />
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Qwen账号列表 */}
        {activeTab === 'qwen' && (
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="text-left">
              <CardTitle className="text-left">Qwen账号</CardTitle>
              <CardDescription className="text-left">
                共 {qwenAccounts.length} 个账号
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {qwenAccounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无Qwen账号</p>
                  <p className="text-sm">点击“添加账号”按钮导入您的第一个Qwen账号</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[120px]">账号ID</TableHead>
                        <TableHead className="min-w-[160px]">账号名称</TableHead>
                        <TableHead className="min-w-[200px]">邮箱</TableHead>
                        <TableHead className="min-w-[80px]">状态</TableHead>
                        <TableHead className="min-w-[80px]">刷新</TableHead>
                        <TableHead className="min-w-[160px]">过期时间</TableHead>
                        <TableHead className="min-w-[160px]">添加时间</TableHead>
                        <TableHead className="text-right min-w-[80px]">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {qwenAccounts.map((account) => (
                        <TableRow key={account.account_id}>
                          <TableCell className="font-mono text-sm">
                            {account.account_id}
                          </TableCell>
                          <TableCell>
                            {account.account_name || account.email || '未命名'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {account.email || '-'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={account.status === 1 ? 'default' : 'secondary'}>
                              {account.status === 1 ? '启用' : '禁用'}     
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {account.need_refresh ? (
                              <Badge variant="destructive">需要</Badge>
                            ) : (
                              <Badge variant="secondary">正常</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.expires_at ? new Date(account.expires_at).toLocaleString('zh-CN') : '-'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.created_at ? new Date(account.created_at).toLocaleString('zh-CN') : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <IconDotsVertical className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleCopyQwenCredentials(account)}>
                                  <IconCopy className="size-4 mr-2" />
                                  复制凭证为JSON
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleRenameQwen(account)}>
                                  <IconEdit className="size-4 mr-2" />
                                  重命名
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleToggleQwenStatus(account)}>
                                  {account.status === 1 ? (
                                    <>
                                      <IconToggleLeft className="size-4 mr-2" />
                                      禁用
                                    </>
                                  ) : (
                                    <>
                                      <IconToggleRight className="size-4 mr-2" />
                                      启用
                                    </>
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleDeleteQwen(account.account_id)}
                                  className="text-red-600"
                                >
                                  <IconTrash className="size-4 mr-2" />
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Codex账号列表 */}
        {activeTab === 'codex' && (
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="text-left">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-left">Codex账号</CardTitle>
                  <CardDescription className="text-left">
                    共 {codexAccounts.length} 个账号
                    {isRefreshingAllCodexQuotas && refreshAllCodexProgress
                      ? `，正在刷新 ${refreshAllCodexProgress.current}/${refreshAllCodexProgress.total}`
                      : ''}
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="default"
                  onClick={handleRefreshAllCodexQuotas}
                  disabled={
                    isRefreshingAllCodexQuotas ||
                    refreshingCodexAccountId !== null ||
                    codexAccounts.length === 0
                  }
                >
                  {isRefreshingAllCodexQuotas ? (
                    <MorphingSquare className="size-4" />
                  ) : (
                    <IconRefresh className="size-4" />
                  )}
                  <span className="ml-2">刷新全部剩余额度</span>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {codexAccounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无Codex账号</p>
                  <p className="text-sm">点击“添加账号”按钮添加您的第一个Codex账号</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[100px]">账号ID</TableHead>
                        <TableHead className="min-w-[160px]">账号名称</TableHead>
                        <TableHead className="min-w-[160px]">消耗Token</TableHead>
                        <TableHead className="min-w-[120px]">订阅</TableHead>
                        <TableHead className="min-w-[80px]">状态</TableHead>
                        <TableHead className="min-w-[120px]">5小时/周剩余</TableHead>
                        <TableHead className="min-w-[180px]">解冻时间</TableHead>
                        <TableHead className="min-w-[180px]">Token过期</TableHead>
                        <TableHead className="min-w-[180px]">添加时间</TableHead>
                        <TableHead className="text-right min-w-[80px]">操作</TableHead>
                        <TableHead className="min-w-[260px]">信息</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {codexAccounts.map((account) => (
                        <TableRow key={account.account_id}>
                          <TableCell className="font-mono text-sm">
                            {account.account_id}
                          </TableCell>
                          <TableCell>
                            {account.account_name || account.email || '未命名'}
                          </TableCell>
                          <TableCell className="font-mono text-sm whitespace-nowrap">
                            {(() => {
                              const total = account.consumed_total_tokens;
                              const input = account.consumed_input_tokens ?? 0;
                              const output = account.consumed_output_tokens ?? 0;
                              const cached = account.consumed_cached_tokens ?? 0;
                              const title = `输入 ${input.toLocaleString('zh-CN')} / 输出 ${output.toLocaleString('zh-CN')} / 缓存 ${cached.toLocaleString('zh-CN')}`;

                              return (
                                <span title={title}>
                                  {typeof total === 'number' ? total.toLocaleString('zh-CN') : '-'}
                                </span>
                              );
                            })()}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">
                              {account.chatgpt_plan_type || '-'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={(account.effective_status ?? account.status) === 1 ? 'default' : 'secondary'}
                              className={account.is_frozen ? 'text-red-600' : ''}
                            >
                              {account.is_frozen ? '冻结' : account.status === 1 ? '启用' : '禁用'}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-sm whitespace-nowrap">
                            {(() => {
                              const format = (used: number | null | undefined, resetAt: string | null | undefined) => {
                                if (resetAt) {
                                  const t = new Date(resetAt).getTime();
                                  if (!Number.isNaN(t) && t <= Date.now()) {
                                    return '100%';
                                  }
                                }
                                if (used === null || used === undefined) return '-';
                                const remaining = Math.max(0, Math.min(100, 100 - used));
                                return `${remaining}%`;
                              };

                              const hasWeekUsed =
                                account.limit_week_used_percent !== null && account.limit_week_used_percent !== undefined;
                              const weekUsed = hasWeekUsed ? account.limit_week_used_percent : account.limit_5h_used_percent;
                              const weekResetAt = hasWeekUsed
                                ? account.limit_week_reset_at
                                : (account.limit_week_reset_at ?? account.limit_5h_reset_at);

                              return `${format(account.limit_5h_used_percent, account.limit_5h_reset_at)}/${format(weekUsed, weekResetAt)}`;
                            })()}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.is_frozen
                              ? (account.frozen_until ? new Date(account.frozen_until).toLocaleString('zh-CN') : '未知')
                              : '-'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.token_expires_at
                              ? new Date(account.token_expires_at).toLocaleString('zh-CN')
                              : '-'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.created_at ? new Date(account.created_at).toLocaleString('zh-CN') : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <IconDotsVertical className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleViewCodexDetail(account)}>
                                  <IconExternalLink className="size-4 mr-2" />
                                  详细信息
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleRefreshCodexOfficial(account)}
                                  disabled={isRefreshingAllCodexQuotas || refreshingCodexAccountId === account.account_id}
                                >
                                  <IconRefresh className="size-4 mr-2" />
                                  {refreshingCodexAccountId === account.account_id ? '刷新中...' : '刷新官方额度/限额'}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleViewCodexWhamUsage(account)}>
                                  <IconChartBar className="size-4 mr-2" />
                                  查看限额窗口
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleCopyCodexCredentials(account)}>
                                  <IconCopy className="size-4 mr-2" />
                                  复制凭证为JSON
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleRenameCodex(account)}>
                                  <IconEdit className="size-4 mr-2" />
                                  重命名
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleToggleCodexStatus(account)}>
                                  {account.status === 1 ? (
                                    <>
                                      <IconToggleLeft className="size-4 mr-2" />
                                      禁用
                                    </>
                                  ) : (
                                    <>
                                      <IconToggleRight className="size-4 mr-2" />
                                      启用
                                    </>
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleDeleteCodex(account.account_id)}
                                  className="text-red-600"
                                >
                                  <IconTrash className="size-4 mr-2" />
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                          <TableCell className="text-sm">
                            {(() => {
                              const accountId = account.account_id;
                              const error = codexRefreshErrorById[accountId];
                              const isRefreshing = refreshingCodexAccountId === accountId;
                              const quotaText =
                                account.quota_remaining === null || account.quota_remaining === undefined
                                  ? '-'
                                  : `${Number(account.quota_remaining).toFixed(2)}${account.quota_currency ? ` ${account.quota_currency}` : ''}`;
                              const infoText = isRefreshing ? '刷新中...' : error || quotaText;

                              return (
                                <div
                                  className={`max-w-[260px] truncate ${error ? 'text-red-600' : 'font-mono text-muted-foreground'}`}
                                  title={infoText}
                                >
                                  {infoText}
                                </div>
                              );
                            })()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* GeminiCLI账号列表 */}
        {activeTab === 'gemini' && (
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="text-left">
              <CardTitle className="text-left">GeminiCLI账号</CardTitle>
              <CardDescription className="text-left">
                共 {geminiCliAccounts.length} 个账号
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {geminiCliAccounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无GeminiCLI账号</p>
                  <p className="text-sm">点击“添加账号”按钮添加您的第一个GeminiCLI账号</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[100px]">账号ID</TableHead>
                        <TableHead className="min-w-[200px]">邮箱</TableHead>
                        <TableHead className="min-w-[180px]">项目ID</TableHead>
                        <TableHead className="min-w-[80px]">状态</TableHead>
                        <TableHead className="min-w-[100px]">添加时间</TableHead>
                        <TableHead className="text-right min-w-[80px]">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {geminiCliAccounts.map((account) => (
                        <TableRow key={account.account_id}>
                          <TableCell className="font-mono text-sm">
                            {account.account_id}
                          </TableCell>
                          <TableCell className="text-sm break-all">
                            {account.email || '-'}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            <div className="max-w-[180px] truncate" title={account.project_id || ''}>
                              {account.project_id || '-'}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={account.status === 1 ? 'default' : 'secondary'}>
                              {account.status === 1 ? '启用' : '禁用'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.created_at ? new Date(account.created_at).toLocaleString('zh-CN') : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <IconDotsVertical className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleViewGeminiCliDetail(account)}>
                                  <IconInfoCircle className="size-4 mr-2" />
                                  账户详情
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleViewGeminiCliQuota(account)}>
                                  <IconChartBar className="size-4 mr-2" />
                                  额度查询
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleCopyGeminiCLICredentials(account)}>
                                  <IconCopy className="size-4 mr-2" />
                                  复制凭证为JSON
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleToggleGeminiCLIStatus(account)}>
                                  {account.status === 1 ? (
                                    <>
                                      <IconToggleLeft className="size-4 mr-2" />
                                      禁用
                                    </>
                                  ) : (
                                    <>
                                      <IconToggleRight className="size-4 mr-2" />
                                      启用
                                    </>
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleDeleteGeminiCLIAccount(account.account_id)}
                                  className="text-red-600"
                                >
                                  <IconTrash className="size-4 mr-2" />
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ZAI TTS 账号列表 */}
        {activeTab === 'zai-tts' && (
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="text-left">
              <CardTitle className="text-left">ZAI TTS 账号</CardTitle>
              <CardDescription className="text-left">
                共 {zaiTtsAccounts.length} 个账号
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {zaiTtsAccounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无ZAI TTS账号</p>
                  <p className="text-sm">点击“添加账号”按钮添加您的第一个 ZAI TTS 账号</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[100px]">账号ID</TableHead>
                        <TableHead className="min-w-[160px]">账号名称</TableHead>
                        <TableHead className="min-w-[180px]">ZAI_USERID</TableHead>
                        <TableHead className="min-w-[140px]">音色ID</TableHead>
                        <TableHead className="min-w-[80px]">状态</TableHead>
                        <TableHead className="min-w-[140px]">添加时间</TableHead>
                        <TableHead className="text-right min-w-[80px]">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {zaiTtsAccounts.map((account) => (
                        <TableRow key={account.account_id}>
                          <TableCell className="font-mono text-sm">
                            {account.account_id}
                          </TableCell>
                          <TableCell>
                            {account.account_name || '未命名'}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {account.zai_user_id}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {account.voice_id}
                          </TableCell>
                          <TableCell>
                            <Badge variant={account.status === 1 ? 'default' : 'secondary'}>
                              {account.status === 1 ? '启用' : '禁用'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.created_at ? new Date(account.created_at).toLocaleString('zh-CN') : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <IconDotsVertical className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleEditZaiTtsAccount(account)}>
                                  <IconEdit className="size-4 mr-2" />
                                  编辑配置
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleToggleZaiTtsStatus(account)}>
                                  {account.status === 1 ? (
                                    <>
                                      <IconToggleLeft className="size-4 mr-2" />
                                      禁用
                                    </>
                                  ) : (
                                    <>
                                      <IconToggleRight className="size-4 mr-2" />
                                      启用
                                    </>
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleDeleteZaiTtsAccount(account.account_id)}
                                  className="text-red-600"
                                >
                                  <IconTrash className="size-4 mr-2" />
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ZAI Image 账号列表 */}
        {activeTab === 'zai-image' && (
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="text-left">
              <CardTitle className="text-left">ZAI Image 账号</CardTitle>
              <CardDescription className="text-left">
                共 {zaiImageAccounts.length} 个账号
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {zaiImageAccounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无ZAI Image账号</p>
                  <p className="text-sm">点击“添加账号”按钮添加您的第一个 ZAI Image 账号</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[100px]">账号ID</TableHead>
                        <TableHead className="min-w-[220px]">账号名称</TableHead>
                        <TableHead className="min-w-[80px]">状态</TableHead>
                        <TableHead className="min-w-[160px]">添加时间</TableHead>
                        <TableHead className="min-w-[160px]">最后使用</TableHead>
                        <TableHead className="text-right min-w-[80px]">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {zaiImageAccounts.map((account) => (
                        <TableRow key={account.account_id}>
                          <TableCell className="font-mono text-sm">
                            {account.account_id}
                          </TableCell>
                          <TableCell>
                            {account.account_name || '未命名'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={account.status === 1 ? 'default' : 'secondary'}>
                              {account.status === 1 ? '启用' : '禁用'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.created_at ? new Date(account.created_at).toLocaleString('zh-CN') : '-'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {account.last_used_at ? new Date(account.last_used_at).toLocaleString('zh-CN') : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <IconDotsVertical className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleEditZaiImageAccount(account)}>
                                  <IconEdit className="size-4 mr-2" />
                                  编辑配置
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleToggleZaiImageStatus(account)}>
                                  {account.status === 1 ? (
                                    <>
                                      <IconToggleLeft className="size-4 mr-2" />
                                      禁用
                                    </>
                                  ) : (
                                    <>
                                      <IconToggleRight className="size-4 mr-2" />
                                      启用
                                    </>
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleDeleteZaiImageAccount(account.account_id)}
                                  className="text-red-600"
                                >
                                  <IconTrash className="size-4 mr-2" />
                                  删除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* 添加账号 Drawer */}
      <AddAccountDrawer
        open={isAddDrawerOpen}
        onOpenChange={setIsAddDrawerOpen}
        onSuccess={loadAccounts}
      />

      {/* 配额查看 Dialog */}
      <Dialog open={isQuotaDialogOpen} onOpenChange={setIsQuotaDialogOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-[900px] max-h-[90vh] p-0">
          <DialogHeader className="px-4 pt-6 pb-2 md:px-6 text-left">
            <DialogTitle className="text-left">账号配额详情</DialogTitle>
            <DialogDescription className="break-all text-left">
              账号 ID: {currentAccount?.cookie_id}
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 pb-6 md:px-6 overflow-y-auto max-h-[calc(90vh-120px)]">
            {isLoadingQuotas ? (
              <div className="flex items-center justify-center py-12">
                <MorphingSquare message="加载配额信息..." />
              </div>
            ) : quotas && Array.isArray(quotas) && quotas.length > 0 ? (
              <div className="overflow-x-auto -mx-4 md:mx-0">
                <div className="inline-block min-w-full align-middle px-4 md:px-0">
                  <div className="overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[160px] sticky left-0 bg-background z-10">模型名称</TableHead>
                          <TableHead className="min-w-[90px]">配额</TableHead>
                          <TableHead className="min-w-[70px]">状态</TableHead>
                          <TableHead className="min-w-[140px]">重置时间</TableHead>
                          <TableHead className="text-right min-w-[70px] sticky right-0 bg-background z-10">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortQuotas(quotas).map((quota: any) => (
                          <TableRow key={quota.quota_id}>
                            <TableCell className="sticky left-0 bg-background z-10">
                              <div className="flex items-center gap-2">
                                <div className="shrink-0">
                                  {getModelIcon(quota.model_name)}
                                </div>
                                <span className="font-medium text-sm">{getModelDisplayName(quota.model_name)}</span>
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-xs md:text-sm whitespace-nowrap">
                              {parseFloat(quota.quota).toFixed(4)}
                            </TableCell>
                            <TableCell>
                              <span className={`text-xs md:text-sm ${quota.status === 1 ? 'text-green-600' : 'text-muted-foreground'}`}>
                                {quota.status === 1 ? '正常' : '禁用'}
                              </span>
                            </TableCell>
                            <TableCell className="text-xs md:text-sm text-muted-foreground whitespace-nowrap">
                              {quota.reset_time
                                ? new Date(quota.reset_time).toLocaleString('zh-CN', {
                                  month: '2-digit',
                                  day: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })
                                : '无限制'
                              }
                            </TableCell>
                            <TableCell className="text-right sticky right-0 bg-background z-10">
                              <Switch
                                isSelected={quota.status === 1}
                                onChange={() => handleToggleQuotaStatus(quota.model_name, quota.status)}
                                className="scale-75"
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">暂无配额信息</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ZAI TTS 编辑 Dialog */}
      <Dialog
        open={isZaiTtsEditDialogOpen}
        onOpenChange={(open) => {
          setIsZaiTtsEditDialogOpen(open);
          if (!open) {
            setEditingZaiTtsAccount(null);
            setZaiTtsEditAccountName('');
            setZaiTtsEditUserId('');
            setZaiTtsEditToken('');
            setZaiTtsEditVoiceId('system_001');
            setIsUpdatingZaiTts(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>编辑 ZAI TTS 账号</DialogTitle>
            <DialogDescription>
              {editingZaiTtsAccount ? `账号ID: ${editingZaiTtsAccount.account_id}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="zai-tts-edit-name">账号名称</Label>
              <Input
                id="zai-tts-edit-name"
                value={zaiTtsEditAccountName}
                onChange={(e) => setZaiTtsEditAccountName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="zai-tts-edit-user-id">ZAI_USERID</Label>
              <Input
                id="zai-tts-edit-user-id"
                value={zaiTtsEditUserId}
                onChange={(e) => setZaiTtsEditUserId(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="zai-tts-edit-token">ZAI_TOKEN（留空不修改）</Label>
              <Input
                id="zai-tts-edit-token"
                value={zaiTtsEditToken}
                onChange={(e) => setZaiTtsEditToken(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="zai-tts-edit-voice">音色ID</Label>
              <Input
                id="zai-tts-edit-voice"
                value={zaiTtsEditVoiceId}
                onChange={(e) => setZaiTtsEditVoiceId(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsZaiTtsEditDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmitZaiTtsEdit} disabled={isUpdatingZaiTts}>
              {isUpdatingZaiTts ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ZAI Image 编辑 Dialog */}
      <Dialog
        open={isZaiImageEditDialogOpen}
        onOpenChange={(open) => {
          setIsZaiImageEditDialogOpen(open);
          if (!open) {
            setEditingZaiImageAccount(null);
            setZaiImageEditAccountName('');
            setZaiImageEditToken('');
            setIsUpdatingZaiImage(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>编辑 ZAI Image 账号</DialogTitle>
            <DialogDescription>
              {editingZaiImageAccount ? `账号ID: ${editingZaiImageAccount.account_id}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="zai-image-edit-name">账号名称</Label>
              <Input
                id="zai-image-edit-name"
                value={zaiImageEditAccountName}
                onChange={(e) => setZaiImageEditAccountName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="zai-image-edit-token">ZAI_TOKEN（留空不修改）</Label>
              <Input
                id="zai-image-edit-token"
                value={zaiImageEditToken}
                onChange={(e) => setZaiImageEditToken(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsZaiImageEditDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmitZaiImageEdit} disabled={isUpdatingZaiImage}>
              {isUpdatingZaiImage ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* GeminiCLI 额度查询 Dialog */}
      <Dialog
        open={isGeminiCliQuotaDialogOpen}
        onOpenChange={(open) => {
          setIsGeminiCliQuotaDialogOpen(open);
          if (!open) {
            setGeminiCliQuotaAccount(null);
            setGeminiCliQuotaData(null);
            setIsLoadingGeminiCliQuota(false);
          }
        }}
      >
        <DialogContent className="max-w-[95vw] sm:max-w-[900px] max-h-[90vh] p-0">
          <DialogHeader className="px-4 pt-6 pb-2 md:px-6 text-left">
            <DialogTitle className="text-left">GeminiCLI 额度信息</DialogTitle>
            <DialogDescription className="break-all text-left">
              {geminiCliQuotaAccount ? `账号ID: ${geminiCliQuotaAccount.account_id}` : ''}
              {geminiCliQuotaData?.project_id ? ` | Project: ${geminiCliQuotaData.project_id}` : ''}
              <br />
              重置时间按中国时区（UTC+8）展示
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 pb-6 md:px-6 overflow-y-auto max-h-[calc(90vh-120px)]">
            {isLoadingGeminiCliQuota ? (
              <div className="flex items-center justify-center py-12">
                <MorphingSquare message="查询额度信息..." />
              </div>
            ) : geminiCliQuotaData && Array.isArray(geminiCliQuotaData.buckets) && geminiCliQuotaData.buckets.length > 0 ? (
              <div className="overflow-x-auto -mx-4 md:mx-0">
                <div className="inline-block min-w-full align-middle px-4 md:px-0">
                  <div className="overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[120px]">层级</TableHead>
                          <TableHead className="min-w-[120px]">剩余比例</TableHead>
                          <TableHead className="min-w-[200px]">重置时间</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {groupGeminiQuotaByTier(geminiCliQuotaData.buckets).map((group) => (
                          <TableRow key={group.tier}>
                            <TableCell className="font-medium text-sm">
                              <Badge variant={
                                group.tier === 'Pro' ? 'default' :
                                group.tier === 'Flash' ? 'secondary' : 'outline'
                              }>
                                {group.tier}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs md:text-sm">
                              {group.remaining_fraction === null || group.remaining_fraction === undefined
                                ? '-'
                                : `${(group.remaining_fraction * 100).toFixed(1)}%`}
                            </TableCell>
                            <TableCell className="text-xs md:text-sm text-muted-foreground">
                              {formatGeminiCliResetTime(group.reset_time)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">暂无额度信息</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 重命名 Kiro 账号 Dialog */}
      <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>重命名账号</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="account-name">新的账号名称</Label>
              <Input
                id="account-name"
                placeholder="输入账号名称"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                maxLength={50}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isRenaming) {
                    handleSubmitRename();
                  }
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsRenameDialogOpen(false)}
              disabled={isRenaming}
            >
              取消
            </Button>
            <Button
              onClick={handleSubmitRename}
              disabled={isRenaming || !newAccountName.trim()}
            >
              {isRenaming ? (
                <>
                  <MorphingSquare className="size-4 mr-2" />
                  保存中...
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名 Qwen 账号 Dialog */}
      <Dialog open={isQwenRenameDialogOpen} onOpenChange={setIsQwenRenameDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>重命名账号</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="qwen-account-name">新的账号名称</Label>
              <Input
                id="qwen-account-name"
                placeholder="输入账号名称"
                value={newQwenAccountName}
                onChange={(e) => setNewQwenAccountName(e.target.value)}
                maxLength={50}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isRenamingQwen) {
                    handleSubmitQwenRename();
                  }
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsQwenRenameDialogOpen(false)}
              disabled={isRenamingQwen}
            >
              取消
            </Button>
            <Button
              onClick={handleSubmitQwenRename}
              disabled={isRenamingQwen || !newQwenAccountName.trim()}
            >
              {isRenamingQwen ? (
                <>
                  <MorphingSquare className="size-4 mr-2" />
                  保存中...
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名 Codex 账号 Dialog */}
      <Dialog open={isCodexRenameDialogOpen} onOpenChange={setIsCodexRenameDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>重命名账号</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="codex-account-name">新的账号名称</Label>
              <Input
                id="codex-account-name"
                placeholder="输入账号名称"
                value={newCodexAccountName}
                onChange={(e) => setNewCodexAccountName(e.target.value)}
                maxLength={50}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isRenamingCodex) {
                    handleSubmitCodexRename();
                  }
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCodexRenameDialogOpen(false)}
              disabled={isRenamingCodex}
            >
              取消
            </Button>
            <Button
              onClick={handleSubmitCodexRename}
              disabled={isRenamingCodex || !newCodexAccountName.trim()}
            >
              {isRenamingCodex ? (
                <>
                  <MorphingSquare className="size-4 mr-2" />
                  保存中...
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名 Antigravity 账号 Dialog */}
      <Dialog open={isAntigravityRenameDialogOpen} onOpenChange={setIsAntigravityRenameDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>重命名账号</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="antigravity-account-name">新的账号名称</Label>
              <Input
                id="antigravity-account-name"
                placeholder="输入账号名称"
                value={newAntigravityAccountName}
                onChange={(e) => setNewAntigravityAccountName(e.target.value)}
                maxLength={50}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isRenamingAntigravity) {
                    handleSubmitAntigravityRename();
                  }
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsAntigravityRenameDialogOpen(false)}
              disabled={isRenamingAntigravity}
            >
              取消
            </Button>
            <Button
              onClick={handleSubmitAntigravityRename}
              disabled={isRenamingAntigravity || !newAntigravityAccountName.trim()}
            >
              {isRenamingAntigravity ? (
                <>
                  <MorphingSquare className="size-4 mr-2" />
                  保存中...
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Antigravity 账号详情 - 响应式弹窗 */}
      {/* 修改 Project ID Dialog */}
      <Dialog
        open={isProjectIdDialogOpen}
        onOpenChange={(open) => {
          setIsProjectIdDialogOpen(open);
          if (!open) {
            setProjectIdEditingAccount(null);
            setAccountProjects(null);
            setProjectIdInput('');
            setProjectIdSelectValue('');
            setIsLoadingProjects(false);
            setIsUpdatingProjectId(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>修改 Project ID</DialogTitle>
            <DialogDescription className="break-all">
              {projectIdEditingAccount ? `账号ID: ${projectIdEditingAccount.cookie_id}` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>从列表选择</Label>
              <Select
                value={projectIdSelectValue}
                onValueChange={(value) => {
                  setProjectIdSelectValue(value);
                  setProjectIdInput(value);
                }}
                disabled={isLoadingProjects || isUpdatingProjectId || !accountProjects}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      isLoadingProjects
                        ? '加载中...'
                        : accountProjects
                          ? '选择一个项目'
                          : '未加载项目列表'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {accountProjects?.projects?.map((p) => (
                    <SelectItem key={p.project_id} value={p.project_id}>
                      {p.project_id}
                      {p.name ? ` (${p.name})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {accountProjects?.default_project_id ? (
                <p className="text-xs text-muted-foreground break-all">
                  默认建议：{accountProjects.default_project_id}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-id-input">自定义 Project ID</Label>
              <Input
                id="project-id-input"
                placeholder="例如：xxx-yyy-zzz"
                value={projectIdInput}
                onChange={(e) => {
                  const value = e.target.value;
                  setProjectIdInput(value);
                  const trimmed = value.trim();
                  if (trimmed && accountProjects?.projects?.some((p) => p.project_id === trimmed)) {
                    setProjectIdSelectValue(trimmed);
                  } else {
                    setProjectIdSelectValue('');
                  }
                }}
                disabled={isUpdatingProjectId}
              />
              <p className="text-xs text-muted-foreground">保存后写入并优先使用。</p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsProjectIdDialogOpen(false)}
              disabled={isUpdatingProjectId}
            >
              取消
            </Button>
            <Button
              onClick={handleSubmitProjectId}
              disabled={isUpdatingProjectId || !projectIdInput.trim()}
            >
              {isUpdatingProjectId ? (
                <>
                  <MorphingSquare className="size-4 mr-2" />
                  保存中...
                </>
              ) : (
                '保存'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ResponsiveDialog open={isAntigravityDetailDialogOpen} onOpenChange={setIsAntigravityDetailDialogOpen} dismissible={false}>
        <ResponsiveDialogContent className="sm:max-w-[600px] max-h-[90vh] flex flex-col p-0" showHandle={false}>
          <ResponsiveDialogHeader className="shrink-0 px-4 pt-4 pb-2 border-b">
            <ResponsiveDialogTitle>账号详细信息</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {isLoadingAntigravityDetail ? (
              <div className="flex items-center justify-center py-12">
                <MorphingSquare message="加载账号信息..." />
              </div>
            ) : antigravityDetail ? (
              <div className="space-y-6">
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">基本信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">账号ID</Label>
                      <p className="text-sm font-mono break-all">{antigravityDetail.cookie_id}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">邮箱</Label>
                      <p className="text-sm break-all">{antigravityDetail.email || '未提供邮箱'}</p>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs text-muted-foreground">Project ID</Label>
                      <p className="text-sm font-mono break-all">
                        {accounts.find(a => a.cookie_id === antigravityDetail.cookie_id)?.project_id_0 || '未获取'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">账号名称</Label>
                      <p className="text-sm">{antigravityDetail.name || '未命名'}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">订阅层</Label>
                      <Badge variant="secondary">
                        {antigravityDetail.subscription_tier ||
                          antigravityDetail.subscription_tier_raw ||
                          (antigravityDetail.paid_tier ? 'PAID' : 'FREE')}
                      </Badge>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs text-muted-foreground">导入时间</Label>
                      <p className="text-sm">
                        {new Date(antigravityDetail.created_at).toLocaleString('zh-CN')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">暂无账号详情</p>
              </div>
            )}
          </div>

          <ResponsiveDialogFooter className="shrink-0 px-4 pb-4 pt-2 border-t">
            <Button variant="outline" onClick={() => setIsAntigravityDetailDialogOpen(false)}>
              关闭
            </Button>
          </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* Codex 限额窗口（wham/usage） */}
      <Dialog
        open={isCodexWhamDialogOpen}
        onOpenChange={(open) => {
          setIsCodexWhamDialogOpen(open);
          if (!open) {
            setCodexWhamAccount(null);
            setCodexWhamData(null);
            setIsLoadingCodexWham(false);
          }
        }}
      >
        <DialogContent className="max-w-[95vw] sm:max-w-[720px] max-h-[90vh] p-0">
          <DialogHeader className="px-4 pt-6 pb-2 md:px-6 text-left">
            <DialogTitle className="text-left">Codex 限额窗口</DialogTitle>
            <DialogDescription className="break-all text-left">
              账号 ID: {codexWhamAccount?.account_id}
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 pb-6 md:px-6 overflow-y-auto max-h-[calc(90vh-150px)]">
            {isLoadingCodexWham ? (
              <div className="flex items-center justify-center py-12">
                <MorphingSquare message="加载限额窗口..." />
              </div>
            ) : codexWhamData?.parsed ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant="secondary">
                    {codexWhamData.parsed.plan_type || codexWhamAccount?.chatgpt_plan_type || '-'}
                  </Badge>
                  <span className="text-muted-foreground">
                    拉取时间：{new Date(codexWhamData.fetched_at).toLocaleString('zh-CN')}
                  </span>
                </div>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[140px]">窗口</TableHead>
                      <TableHead className="min-w-[90px]">已用(%)</TableHead>
                      <TableHead className="min-w-[90px]">剩余(%)</TableHead>
                      <TableHead className="min-w-[180px]">重置时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(() => {
                      const w5 = codexWhamData.parsed.rate_limit?.primary_window;
                      const ww = codexWhamData.parsed.rate_limit?.secondary_window;
                      const rows = [
                        { key: '5h' as const, name: '5 小时限额', w: w5 },
                        { key: 'week' as const, name: '周限额', w: ww },
                      ];

                      return rows.map((row) => {
                        const usedRaw = row.w?.used_percent;
                        let used: number | null = typeof usedRaw === 'number' ? usedRaw : null;
                        let resetAtRaw: string | null = row.w?.reset_at ?? null;

                        if (row.key === 'week') {
                          const fallbackUsed = w5?.used_percent;
                          if (used === null && typeof fallbackUsed === 'number') {
                            used = fallbackUsed;
                          }
                          if (resetAtRaw === null) {
                            resetAtRaw = w5?.reset_at ?? null;
                          }
                        }
                        const remaining = typeof used === 'number' ? Math.max(0, 100 - used) : null;
                        const resetAt = resetAtRaw ? new Date(resetAtRaw).toLocaleString('zh-CN') : '-';

                        return (
                          <TableRow key={row.name}>
                            <TableCell className="font-medium">{row.name}</TableCell>
                            <TableCell className="font-mono text-sm whitespace-nowrap">
                              {typeof used === 'number' ? used : '--'}
                            </TableCell>
                            <TableCell className="font-mono text-sm whitespace-nowrap">
                              {typeof remaining === 'number' ? remaining : '--'}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {resetAt}
                            </TableCell>
                          </TableRow>
                        );
                      });
                    })()}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">暂无限额信息</p>
              </div>
            )}
          </div>

          <DialogFooter className="px-4 pb-4 md:px-6">
            <Button variant="outline" onClick={() => setIsCodexWhamDialogOpen(false)}>
              关闭
            </Button>
            <Button
              onClick={() => codexWhamAccount && handleViewCodexWhamUsage(codexWhamAccount)}
              disabled={isLoadingCodexWham || !codexWhamAccount}
            >
              {isLoadingCodexWham ? (
                <>
                  <MorphingSquare className="size-4 mr-2" />
                  刷新中...
                </>
              ) : (
                '重新加载'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Codex 账号详情 - 响应式弹窗 */}
      <ResponsiveDialog
        open={isCodexDetailDialogOpen}
        onOpenChange={(open) => {
          setIsCodexDetailDialogOpen(open);
          if (!open) setDetailCodexAccount(null);
        }}
        dismissible={false}
      >
        <ResponsiveDialogContent className="sm:max-w-[640px] max-h-[90vh] flex flex-col p-0" showHandle={false}>
          <ResponsiveDialogHeader className="shrink-0 px-4 pt-4 pb-2 border-b">
            <ResponsiveDialogTitle>账号详细信息</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="break-all">
              {detailCodexAccount ? `账号ID: ${detailCodexAccount.account_id}` : ''}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {detailCodexAccount ? (
              <div className="space-y-6">
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">基本信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">账号名称</Label>
                      <p className="text-sm break-all">{detailCodexAccount.account_name || '未命名'}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">状态</Label>
                      <Badge variant={detailCodexAccount.status === 1 ? 'default' : 'secondary'}>
                        {detailCodexAccount.status === 1 ? '启用' : '禁用'}
                      </Badge>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs text-muted-foreground">邮箱</Label>
                      <p className="text-sm break-all">{detailCodexAccount.email || '未提供邮箱'}</p>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs text-muted-foreground">OpenAI account_id</Label>
                      <p className="text-sm font-mono break-all">{detailCodexAccount.openai_account_id || '-'}</p>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs text-muted-foreground">订阅类型</Label>
                      <Badge variant="secondary">{detailCodexAccount.chatgpt_plan_type || '-'}</Badge>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">Token 信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">最后刷新</Label>
                      <p className="text-sm">
                        {detailCodexAccount.last_refresh_at
                          ? new Date(detailCodexAccount.last_refresh_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">过期时间</Label>
                      <p className="text-sm">
                        {detailCodexAccount.token_expires_at
                          ? new Date(detailCodexAccount.token_expires_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">Token 消耗</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">输入Token</Label>
                      <p className="text-sm font-mono">
                        {typeof detailCodexAccount.consumed_input_tokens === 'number'
                          ? detailCodexAccount.consumed_input_tokens.toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">输出Token</Label>
                      <p className="text-sm font-mono">
                        {typeof detailCodexAccount.consumed_output_tokens === 'number'
                          ? detailCodexAccount.consumed_output_tokens.toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">缓存Token</Label>
                      <p className="text-sm font-mono">
                        {typeof detailCodexAccount.consumed_cached_tokens === 'number'
                          ? detailCodexAccount.consumed_cached_tokens.toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">总Token</Label>
                      <p className="text-sm font-mono">
                        {typeof detailCodexAccount.consumed_total_tokens === 'number'
                          ? detailCodexAccount.consumed_total_tokens.toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">额度信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">剩余额度</Label>
                      <p className="text-sm font-mono">
                        {detailCodexAccount.quota_remaining === null ||
                        detailCodexAccount.quota_remaining === undefined
                          ? '-'
                          : `${Number(detailCodexAccount.quota_remaining).toFixed(2)}${detailCodexAccount.quota_currency ? ` ${detailCodexAccount.quota_currency}` : ''}`}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">更新时间</Label>
                      <p className="text-sm">
                        {detailCodexAccount.quota_updated_at
                          ? new Date(detailCodexAccount.quota_updated_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">时间</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">创建时间</Label>
                      <p className="text-sm">
                        {detailCodexAccount.created_at
                          ? new Date(detailCodexAccount.created_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">更新时间</Label>
                      <p className="text-sm">
                        {detailCodexAccount.updated_at
                          ? new Date(detailCodexAccount.updated_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">暂无账号详情</p>
              </div>
            )}
          </div>

          <ResponsiveDialogFooter className="shrink-0 px-4 pb-4 pt-2 border-t">
            <Button variant="outline" onClick={() => setIsCodexDetailDialogOpen(false)}>
              关闭
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* Kiro 账号详情 - 响应式弹窗 */}
      <ResponsiveDialog open={isKiroDetailDialogOpen} onOpenChange={setIsKiroDetailDialogOpen} dismissible={false}>
        <ResponsiveDialogContent className="sm:max-w-[600px] max-h-[90vh] flex flex-col p-0" showHandle={false}>
          <ResponsiveDialogHeader className="shrink-0 px-4 pt-4 pb-2 border-b">
            <ResponsiveDialogTitle>账号详细信息</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {isLoadingDetail ? (
              <div className="flex items-center justify-center py-12">
                <MorphingSquare message="加载余额信息..." />
              </div>
            ) : detailBalance ? (
              <div className="space-y-6">
                {/* 基本信息 */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">基本信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">账号ID</Label>
                      <p className="text-sm font-mono break-all">{detailBalance.account_id}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">邮箱</Label>
                      <p className="text-sm break-all">{detailBalance.email || '未提供邮箱'}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">账号名称</Label>
                      <p className="text-sm">{detailBalance.account_name}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">订阅类型</Label>
                      <Badge variant="secondary">{detailBalance.subscription}</Badge>
                    </div>
                  </div>
                </div>

                {/* 余额信息 */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">余额信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">总可用余额</Label>
                      <p className="text-lg font-semibold text-green-600">
                        ${detailBalance.balance.available.toFixed(2)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">总额度</Label>
                      <p className="text-lg font-semibold">
                        ${detailBalance.balance.total_limit.toFixed(2)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">基础可用额度</Label>
                      <p className="text-sm font-mono">
                        ${detailBalance.balance.base_available.toFixed(2)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Bonus 可用额度</Label>
                      <p className="text-sm font-mono text-blue-600">
                        ${detailBalance.balance.bonus_available.toFixed(2)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">当前使用量</Label>
                      <p className="text-sm font-mono">
                        ${detailBalance.balance.current_usage.toFixed(2)}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">重置日期</Label>
                      <p className="text-sm">
                        {new Date(detailBalance.balance.reset_date).toLocaleDateString('zh-CN')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 免费试用信息 */}
                {detailBalance.free_trial && (
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-muted-foreground">免费试用信息</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">试用状态</Label>
                        <Badge variant={detailBalance.free_trial.status ? 'default' : 'secondary'}>
                          {detailBalance.free_trial.status ? '有效' : '已结束'}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">可用额度</Label>
                        <p className="text-sm font-mono">
                          ${detailBalance.free_trial.available.toFixed(2)}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">总限额</Label>
                        <p className="text-sm font-mono">
                          ${detailBalance.free_trial.limit.toFixed(2)}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">已使用</Label>
                        <p className="text-sm font-mono">
                          ${detailBalance.free_trial.usage.toFixed(2)}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">过期时间</Label>
                        <p className="text-sm">
                          {new Date(detailBalance.free_trial.expiry).toLocaleDateString('zh-CN')}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">暂无余额信息</p>
              </div>
            )}
          </div>

          <ResponsiveDialogFooter className="shrink-0 px-4 pb-4 pt-2 border-t">
            <Button
              variant="outline"
              onClick={() => setIsKiroDetailDialogOpen(false)}
            >
              关闭
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* GeminiCLI 账号详情 - 响应式弹窗 */}
      <ResponsiveDialog
        open={isGeminiCliDetailDialogOpen}
        onOpenChange={(open) => {
          setIsGeminiCliDetailDialogOpen(open);
          if (!open) setDetailGeminiCliAccount(null);
        }}
        dismissible={false}
      >
        <ResponsiveDialogContent className="sm:max-w-[600px] max-h-[90vh] flex flex-col p-0" showHandle={false}>
          <ResponsiveDialogHeader className="shrink-0 px-4 pt-4 pb-2 border-b">
            <ResponsiveDialogTitle>账号详细信息</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="break-all">
              {detailGeminiCliAccount ? `账号ID: ${detailGeminiCliAccount.account_id}` : ''}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {detailGeminiCliAccount ? (
              <div className="space-y-6">
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">基本信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">账号ID</Label>
                      <p className="text-sm font-mono break-all">{detailGeminiCliAccount.account_id}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">邮箱</Label>
                      <p className="text-sm break-all">{detailGeminiCliAccount.email || '-'}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">状态</Label>
                      <Badge variant={detailGeminiCliAccount.status === 1 ? 'default' : 'secondary'}>
                        {detailGeminiCliAccount.status === 1 ? '启用' : '禁用'}
                      </Badge>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs text-muted-foreground">GCP 项目ID</Label>
                      <p className="text-sm font-mono break-all">
                        {detailGeminiCliAccount.project_id || '未设置'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">共享账号</Label>
                      <p className="text-sm">
                        {detailGeminiCliAccount.is_shared ? '是' : '否'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">自动项目</Label>
                      <p className="text-sm">
                        {detailGeminiCliAccount.auto_project ? '是' : '否'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">已检查</Label>
                      <p className="text-sm">
                        {detailGeminiCliAccount.checked ? '是' : '否'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">Token 信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Token 过期时间</Label>
                      <p className="text-sm">
                        {detailGeminiCliAccount.token_expires_at
                          ? new Date(detailGeminiCliAccount.token_expires_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">最后刷新时间</Label>
                      <p className="text-sm">
                        {detailGeminiCliAccount.last_refresh_at
                          ? new Date(detailGeminiCliAccount.last_refresh_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground">时间信息</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">创建时间</Label>
                      <p className="text-sm">
                        {detailGeminiCliAccount.created_at
                          ? new Date(detailGeminiCliAccount.created_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">更新时间</Label>
                      <p className="text-sm">
                        {detailGeminiCliAccount.updated_at
                          ? new Date(detailGeminiCliAccount.updated_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs text-muted-foreground">最后使用时间</Label>
                      <p className="text-sm">
                        {detailGeminiCliAccount.last_used_at
                          ? new Date(detailGeminiCliAccount.last_used_at).toLocaleString('zh-CN')
                          : '-'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">暂无账号详情</p>
              </div>
            )}
          </div>

          <ResponsiveDialogFooter className="shrink-0 px-4 pb-4 pt-2 border-t">
            <Button variant="outline" onClick={() => setIsGeminiCliDetailDialogOpen(false)}>
              关闭
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* 确认对话框 */}
      <Dialog open={isConfirmDialogOpen} onOpenChange={(open) => {
        if (!isConfirmLoading) {
          setIsConfirmDialogOpen(open);
          if (!open) setConfirmDialogConfig(null);
        }
      }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{confirmDialogConfig?.title}</DialogTitle>
            <DialogDescription>
              {confirmDialogConfig?.description}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsConfirmDialogOpen(false);
                setConfirmDialogConfig(null);
              }}
              disabled={isConfirmLoading}
            >
              {confirmDialogConfig?.cancelText || '取消'}
            </Button>
            <Button
              variant={confirmDialogConfig?.variant === 'destructive' ? 'destructive' : 'default'}
              onClick={handleConfirmDialogConfirm}
              disabled={isConfirmLoading}
            >
              {isConfirmLoading ? (
                <>
                  <MorphingSquare className="size-4 mr-2" />
                  请稍等
                </>
              ) : (
                confirmDialogConfig?.confirmText || '确认'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
