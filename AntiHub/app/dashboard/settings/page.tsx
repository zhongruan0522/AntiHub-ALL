'use client';

import { useEffect, useState, useRef } from 'react';
import { getAPIKeys, generateAPIKey, deleteAPIKey, getCookiePreference, updateCookiePreference, getCurrentUser, type PluginAPIKey } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { IconCopy, IconKey, IconTrash, IconEye, IconEyeOff, IconSettings, IconPlus, IconInfoCircle, IconAlertTriangle } from '@tabler/icons-react';
import { MorphingSquare } from '@/components/ui/morphing-square';
import { cn } from '@/lib/utils';
import Toaster, { ToasterRef } from '@/components/ui/toast';
import { Badge as Badge1 } from '@/components/ui/badge-1';
import { getPublicApiBaseUrl } from '@/lib/apiBase';

export default function SettingsPage() {
  const toasterRef = useRef<ToasterRef>(null);
  const [apiKeys, setApiKeys] = useState<PluginAPIKey[]>([]);
  const [newApiKey, setNewApiKey] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [deletingKeyId, setDeletingKeyId] = useState<number | null>(null);
  const [preferShared, setPreferShared] = useState<number>(0); // 0=专属优先, 1=共享优先
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);
  const [hasBeta, setHasBeta] = useState(false);
  const [selectedConfigType, setSelectedConfigType] = useState<'antigravity' | 'kiro'>('antigravity');
  const [keyName, setKeyName] = useState('');

  const [apiEndpoint, setApiEndpoint] = useState(() => getPublicApiBaseUrl());

  useEffect(() => {
    const base = getPublicApiBaseUrl();
    if (/^https?:\/\//i.test(base)) return;
    setApiEndpoint(`${window.location.origin}${base}`);
  }, []);

  const loadAPIKeys = async () => {
    try {
      const data = await getAPIKeys();
      setApiKeys(data);
    } catch (err) {
      // 如果没有 API Key,这是正常的
      setApiKeys([]);
    }
  };

  const loadPreference = async () => {
    try {
      const data = await getCookiePreference();
      setPreferShared(data.prefer_shared);
    } catch (err) {
      // 如果获取失败，使用默认值
      setPreferShared(0);
    }
  };

  useEffect(() => {
    const loadData = async () => {
      await Promise.all([loadAPIKeys(), loadPreference(), checkBetaStatus()]);
      setIsLoading(false);
    };
    loadData();
  }, []);

  const checkBetaStatus = async () => {
    try {
      const user = await getCurrentUser();
      setHasBeta(user.beta === 1);
    } catch (err) {
      setHasBeta(false);
    }
  };

  const handleUpdatePreference = async (newPreference: number) => {
    setIsUpdatingPreference(true);

    try {
      await updateCookiePreference(newPreference);
      setPreferShared(newPreference);
      toasterRef.current?.show({
        title: '更新成功',
        message: '已保存账户首选项配置',
        variant: 'success',
        position: 'top-right',
      });
    } catch (err) {
      toasterRef.current?.show({
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新账户首选项失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsUpdatingPreference(false);
    }
  };

  const handleOpenCreateDialog = () => {
    setKeyName('');
    setSelectedConfigType('antigravity');
    setIsCreateDialogOpen(true);
  };

  const handleGenerateKey = async () => {
    if (!keyName.trim()) {
      toasterRef.current?.show({
        title: '输入错误',
        message: '请输入API密钥名称',
        variant: 'warning',
        position: 'top-right',
      });
      return;
    }

    setIsGenerating(true);

    try {
      const result = await generateAPIKey(keyName, selectedConfigType);
      setNewApiKey(result.key);
      setShowApiKey(true);
      setIsDialogOpen(true);
      setIsCreateDialogOpen(false);
      // 重新加载列表
      await loadAPIKeys();
    } catch (err) {
      toasterRef.current?.show({
        title: '生成失败',
        message: err instanceof Error ? err.message : '生成API密钥失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCloseDialog = () => {
    setIsDialogOpen(false);
    setNewApiKey('');
    setShowApiKey(false);
  };

  const handleDeleteKey = async (keyId: number) => {
    if (!confirm('确定要删除此API密钥吗？删除后将无法恢复，所有使用此密钥的应用将无法访问 AI 资源。')) {
      return;
    }

    setDeletingKeyId(keyId);

    try {
      await deleteAPIKey(keyId);
      toasterRef.current?.show({
        title: '删除成功',
        message: 'API密钥已删除',
        variant: 'success',
        position: 'top-right',
      });
      // 重新加载列表
      await loadAPIKeys();
    } catch (err) {
      toasterRef.current?.show({
        title: '删除失败',
        message: err instanceof Error ? err.message : '删除API密钥失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setDeletingKeyId(null);
    }
  };

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    toasterRef.current?.show({
      title: '复制成功',
      message: 'API密钥已复制到剪贴板',
      variant: 'success',
      position: 'top-right',
    });
  };

  const maskApiKey = (key: string) => {
    if (!key) return '';
    if (key.length <= 8) return key;
    return key.slice(0, 4) + '•'.repeat(key.length - 8) + key.slice(-4);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center justify-center h-64">
            <MorphingSquare />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">

        <Toaster ref={toasterRef} defaultPosition="top-right" />

        {/* API Key 管理 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="space-y-1.5">
                <CardTitle className="flex items-center gap-2">
                  API密钥管理
                </CardTitle>
              </div>
              <Button
                onClick={handleOpenCreateDialog}
                size="sm"
                className="gap-1"
              >
                <IconPlus className="size-4" />
                创建
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* API Keys 列表 */}
            {apiKeys.length > 0 ? (
              <div className="space-y-3">
                <Label className="text-sm font-medium">当前已创建{apiKeys.length}个密钥</Label>
                <div className="border rounded-lg overflow-x-auto -mx-2 md:mx-0 border-x md:border-x">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left p-3 text-sm font-medium min-w-[120px]">名称</th>
                        <th className="text-left p-3 text-sm font-medium min-w-[100px]">类型</th>
                        <th className="text-left p-3 text-sm font-medium min-w-[180px]">密钥</th>
                        <th className="text-left p-3 text-sm font-medium min-w-[130px]">创建时间</th>
                        <th className="text-left p-3 text-sm font-medium min-w-[130px]">最后使用</th>
                        <th className="text-right p-3 text-sm font-medium min-w-[80px]">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {apiKeys.map((key) => (
                        <tr key={key.id} className="border-b last:border-b-0 hover:bg-muted/30">
                          <td className="p-3 text-sm">
                            {key.name}
                          </td>
                          <td className="p-3">
                            {key.config_type === 'kiro' ? (
                              <Badge1 variant="turbo">
                                Kiro
                              </Badge1>
                            ) : (
                              <Badge variant="secondary">
                                Antigravity
                              </Badge>
                            )}
                          </td>
                          <td className="p-3 text-xs font-mono text-muted-foreground">
                            <div className="max-w-[180px] truncate" title={key.key_preview}>
                              {key.key_preview}
                            </div>
                          </td>
                          <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(key.created_at).toLocaleString('zh-CN')}
                          </td>
                          <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                            {key.last_used_at
                              ? new Date(key.last_used_at).toLocaleString('zh-CN')
                              : '从未使用'
                            }
                          </td>
                          <td className="p-3 text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteKey(key.id)}
                              disabled={deletingKeyId === key.id}
                              className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                            >
                              {deletingKeyId === key.id ? (
                                <MorphingSquare className="size-4" />
                              ) : (
                                <IconTrash className="size-4" />
                              )}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">暂无API密钥</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 账号优先级设置 */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              首选项
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {/* 专属账号优先 */}
              <label
                className={cn(
                  "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                  preferShared === 0 ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                )}
              >
                <input
                  type="radio"
                  name="preference"
                  value="0"
                  checked={preferShared === 0}
                  onChange={() => handleUpdatePreference(0)}
                  disabled={isUpdatingPreference}
                  className="w-4 h-4 mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">优先使用专属账号</h3>
                  </div>
                </div>
              </label>

              {/* 共享账号优先 */}
              <label
                className={cn(
                  "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                  preferShared === 1 ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                )}
              >
                <input
                  type="radio"
                  name="preference"
                  value="1"
                  checked={preferShared === 1}
                  onChange={() => handleUpdatePreference(1)}
                  disabled={isUpdatingPreference}
                  className="w-4 h-4 mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">优先使用共享账号</h3>
                  </div>
                </div>
              </label>
            </div>

            {isUpdatingPreference && (
              <div className="flex items-center justify-center py-4">
                <MorphingSquare message="更新中..." />
              </div>
            )}
          </CardContent>
        </Card>

        {/* API 端点信息 */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              终结点
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <Label className="text-sm font-medium">默认终结点</Label>
              <div className="flex gap-2">
                <Input
                  value={apiEndpoint}
                  readOnly
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleCopyKey(apiEndpoint)}
                >
                  <IconCopy className="size-4" />
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4">
              <div className="flex gap-3">
                <IconAlertTriangle className="size-5 text-yellow-500 shrink-0 mt-0.5" />
                <div className="space-y-2 text-sm">
                  <p className="font-medium text-yellow-500">温馨提示</p>
                  <p className="font-sm text-muted-foreground">你必须提供有效的API密钥才能访问此终结点。要获取模型列表，你的账户内必须具有有效的专属账号或共享账号配额。我们支持OpenAI格式或Anthropic格式的消息。</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 创建 API Key 弹窗 */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>创建API密钥</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">名称</Label>
              <Input
                id="key-name"
                placeholder="输入API密钥名称"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                maxLength={50}
              />
            </div>

            <div className="space-y-3">
              <Label>类型</Label>

              {/* Antigravity */}
              <label
                className={cn(
                  "flex items-start gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors",
                  selectedConfigType === 'antigravity' ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                )}
              >
                <input
                  type="radio"
                  name="config_type"
                  value="antigravity"
                  checked={selectedConfigType === 'antigravity'}
                  onChange={() => setSelectedConfigType('antigravity')}
                  className="w-4 h-4 mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Antigravity</h3>
                    <Badge variant="secondary">默认</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    使用Antigravity账号配额
                  </p>
                </div>
              </label>

              {/* Kiro */}
              <label
                className={cn(
                  "flex items-start gap-3 p-4 border-2 rounded-lg transition-colors",
                  !hasBeta
                    ? "opacity-50 cursor-not-allowed border-border"
                    : selectedConfigType === 'kiro'
                      ? "border-primary bg-primary/5 cursor-pointer"
                      : "border-border hover:border-primary/50 cursor-pointer"
                )}
              >
                <input
                  type="radio"
                  name="config_type"
                  value="kiro"
                  checked={selectedConfigType === 'kiro'}
                  onChange={() => setSelectedConfigType('kiro')}
                  disabled={!hasBeta}
                  className="w-4 h-4 mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Kiro</h3>
                    <Badge1 variant="turbo">
                      Beta
                    </Badge1>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {hasBeta ? '使用Kiro账号配额' : '需要加入Beta计划'}
                  </p>
                </div>
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCreateDialogOpen(false)}
              disabled={isGenerating}
            >
              取消
            </Button>
            <Button
              onClick={handleGenerateKey}
              disabled={isGenerating || !keyName.trim()}
            >
              {isGenerating ? (
                <>
                  <MorphingSquare className="size-4 mr-2" />
                  创建中...
                </>
              ) : (
                '创建'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* API Key 成功弹窗 */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>生成成功</DialogTitle>
            <DialogDescription>
              请妥善保存此密钥，关闭后将无法再次查看完整内容
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>API密钥</Label>
              <div className="flex gap-2">
                <Input
                  value={showApiKey ? (newApiKey || '') : maskApiKey(newApiKey || '')}
                  readOnly
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? (
                    <IconEyeOff className="size-4" />
                  ) : (
                    <IconEye className="size-4" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleCopyKey(newApiKey)}
                >
                  <IconCopy className="size-4" />
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={handleCloseDialog}>
              我已保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
