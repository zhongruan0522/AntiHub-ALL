'use client';

import { useEffect, useState, useRef } from 'react';
import {
  getAccounts,
  deleteAccount,
  updateAccountStatus,
  updateAccountName,
  updateAccountType,
  getAccountQuotas,
  updateQuotaStatus,
  getKiroAccounts,
  deleteKiroAccount,
  updateKiroAccountStatus,
  updateKiroAccountName,
  getKiroAccountBalance,
  getCurrentUser,
  type Account,
  type KiroAccount
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
import { IconCirclePlusFilled, IconDotsVertical, IconRefresh, IconTrash, IconToggleLeft, IconToggleRight, IconExternalLink, IconChartBar, IconChevronDown, IconEdit, IconAlertTriangle, IconArrowsExchange } from '@tabler/icons-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MorphingSquare } from '@/components/ui/morphing-square';
import { Gemini, Claude, OpenAI } from '@lobehub/icons';
import { Badge as Badge1 } from '@/components/ui/badge-1';

export default function AccountsPage() {
  const toasterRef = useRef<ToasterRef>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [kiroAccounts, setKiroAccounts] = useState<KiroAccount[]>([]);
  const [kiroBalances, setKiroBalances] = useState<Record<string, number>>({});
  const [hasBeta, setHasBeta] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'antigravity' | 'kiro'>('antigravity');

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

  // Kiro 账号详情 Dialog 状态
  const [isKiroDetailDialogOpen, setIsKiroDetailDialogOpen] = useState(false);
  const [detailAccount, setDetailAccount] = useState<KiroAccount | null>(null);
  const [detailBalance, setDetailBalance] = useState<any>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

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

      // 检查Beta权限并加载Kiro账号
      try {
        const user = await getCurrentUser();
        setHasBeta(user.beta === 1);

        if (user.beta === 1) {
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
        }
      } catch (err) {
        console.log('未加载Kiro账号');
        setKiroAccounts([]);
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
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadAccounts();

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

  const handleToggleAccountType = (account: Account) => {
    const newIsShared = account.is_shared === 1 ? 0 : 1;
    const typeText = newIsShared === 1 ? '共享' : '专属';
    
    showConfirmDialog({
      title: `转换确认`,
      description: newIsShared === 1
        ? '转换为共享账号后，此账号将加入共享配额池供他人使用，你将获得两倍于当前账号配额的共享配额奖励。确实要继续吗？'
        : '转换为专属账号后，此账号将仅供你个人使用，你的共享配额池可用配额将会相应减少。确实要继续吗？',
      confirmText: '继续',
      cancelText: '取消',
      onConfirm: async () => {
        try {
          await updateAccountType(account.cookie_id, newIsShared);
          setAccounts(accounts.map(a =>
            a.cookie_id === account.cookie_id
              ? { ...a, is_shared: newIsShared }
              : a
          ));
          toasterRef.current?.show({
            title: '类型已更新',
            message: `账号已转换为${typeText}账号`,
            variant: 'success',
            position: 'top-right',
          });
        } catch (err) {
          toasterRef.current?.show({
            title: '转换失败',
            message: err instanceof Error ? err.message : '转换账号类型失败',
            variant: 'error',
            position: 'top-right',
          });
        }
      },
    });
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

  const handleRenameKiro = (account: KiroAccount) => {
    setRenamingAccount(account);
    setNewAccountName(account.account_name || account.email || '');
    setIsRenameDialogOpen(true);
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

  const handleViewKiroDetail = async (account: KiroAccount) => {
    setDetailAccount(account);
    setIsKiroDetailDialogOpen(true);
    setIsLoadingDetail(true);
    setDetailBalance(null);

    try {
      const balanceData = await getKiroAccountBalance(account.account_id);
      setDetailBalance(balanceData);
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
    'claude-opus-4-5-thinking',
  ];

  const getModelDisplayName = (model: string) => {
    const modelNames: Record<string, string> = {
      'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
      'claude-sonnet-4-5-thinking': 'Claude Sonnet 4.5 (Thinking)',
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
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center justify-center min-h-screen">
            <MorphingSquare message="加载中..." />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        {/* 页面标题和操作 */}
        <div className="flex items-center justify-between mb-6">
          <div></div>
          <div className="flex gap-2">
            {/* 账号配置切换下拉菜单 */}
            {hasBeta && (
              <Select value={activeTab} onValueChange={(value: 'antigravity' | 'kiro') => setActiveTab(value)}>
                <SelectTrigger className="w-[160px] h-9">
                  <SelectValue>
                    {activeTab === 'antigravity' ? (
                      <span className="flex items-center gap-2">
                        <img src="/antigravity-logo.png" alt="" className="size-4 rounded" />
                        Antigravity
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <img src="/kiro.png" alt="" className="size-4 rounded" />
                        Kiro
                        <Badge1 variant="turbo">
                          Beta
                        </Badge1>
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
                      <Badge1 variant="turbo">
                        Beta
                      </Badge1>
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
            <Button
              variant="outline"
              size="default"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? (
                <MorphingSquare className="size-4" />
              ) : (
                <IconRefresh className="size-4" />
              )}
              <span className="ml-2">刷新</span>
            </Button>
            <Button size="default" onClick={handleAddAccount}>
              <IconCirclePlusFilled className="size-4" />
              <span className="ml-2">添加账号</span>
            </Button>
          </div>
        </div>

        <Toaster ref={toasterRef} defaultPosition="top-right" />

        {/* 反重力账号列表 */}
        {activeTab === 'antigravity' && (
          <Card>
            <CardHeader className="text-left">
              <CardTitle className="text-left">Antigravity账号</CardTitle>
              <CardDescription className="text-left">
                共 {accounts.length} 个账号
              </CardDescription>
            </CardHeader>
            <CardContent>
              {accounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无Antigravity账号</p>
                  <p className="text-sm">点击"添加账号"按钮添加您的第一个账号</p>
                </div>
              ) : (
                <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[200px]">账号 ID</TableHead>
                          <TableHead className="min-w-[120px]">账号名称</TableHead>
                          <TableHead className="min-w-[80px]">类型</TableHead>
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
                              <Badge variant={account.is_shared === 1 ? 'default' : 'secondary'} className="whitespace-nowrap">
                                {account.is_shared === 1 ? '共享' : '专属'}
                              </Badge>
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
                                  <DropdownMenuItem onClick={() => handleViewQuotas(account)}>
                                    <IconChartBar className="size-4 mr-2" />
                                    查看配额
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleRenameAntigravity(account)}>
                                    <IconEdit className="size-4 mr-2" />
                                    重命名
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleToggleAccountType(account)}>
                                    <IconArrowsExchange className="size-4 mr-2" />
                                    转为{account.is_shared === 1 ? '专属' : '共享'}
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
        {activeTab === 'kiro' && hasBeta && (
          <Card>
            <CardHeader className="text-left">
              <CardTitle className="text-left flex items-center gap-2">
                Kiro账号
                <Badge1 variant="turbo">Beta</Badge1>
              </CardTitle>
              <CardDescription className="text-left">
                共 {kiroAccounts.length} 个账号
              </CardDescription>
            </CardHeader>
            <CardContent>
              {kiroAccounts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无Kiro账号</p>
                  <p className="text-sm">点击"添加账号"按钮添加您的第一个Kiro账号</p>
                </div>
              ) : (
                <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[100px]">账号ID</TableHead>
                        <TableHead className="min-w-[150px]">账号名称</TableHead>
                        <TableHead className="min-w-[100px]">余额</TableHead>
                        <TableHead className="min-w-[80px]">类型</TableHead>
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
                            {account.account_name || account.email || '未命名'}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {kiroBalances[account.account_id] !== undefined
                              ? `$${kiroBalances[account.account_id].toFixed(2)}`
                              : '加载中...'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={account.is_shared === 1 ? 'default' : 'secondary'} className="whitespace-nowrap">
                              {account.is_shared === 1 ? '共享' : '专属'}
                            </Badge>
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

      {/* Kiro 账号详情 Dialog */}
      <Dialog open={isKiroDetailDialogOpen} onOpenChange={setIsKiroDetailDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>账号详细信息</DialogTitle>
          </DialogHeader>

          <div className="py-4">
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
                      <p className="text-sm font-mono">{detailBalance.account_id}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">邮箱</Label>
                      <p className="text-sm">{detailBalance.email || '未提供邮箱'}</p>
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

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsKiroDetailDialogOpen(false)}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
