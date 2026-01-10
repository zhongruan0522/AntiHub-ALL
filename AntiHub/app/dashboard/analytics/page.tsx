'use client';

import { useEffect, useState, useRef } from 'react';
import {
  getUserQuotas,
  getQuotaConsumption,
  getKiroConsumptionStats,
  getKiroAccounts,
  getKiroAccountConsumption,
  type UserQuotaItem,
  type QuotaConsumption,
  type KiroConsumptionStats,
  type KiroAccount,
  type KiroConsumptionLog
} from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from '@/components/ui/pagination';
import { MorphingSquare } from '@/components/ui/morphing-square';
import { Gemini, Claude, OpenAI } from '@lobehub/icons';
import Toaster, { ToasterRef } from '@/components/ui/toast';

export default function AnalyticsPage() {
  const toasterRef = useRef<ToasterRef>(null);
  const [quotas, setQuotas] = useState<UserQuotaItem[]>([]);
  const [consumptions, setConsumptions] = useState<QuotaConsumption[]>([]);
  const [allConsumptions, setAllConsumptions] = useState<QuotaConsumption[]>([]); // 存储所有消费记录
  const [kiroStats, setKiroStats] = useState<KiroConsumptionStats | null>(null);
  const [kiroAccounts, setKiroAccounts] = useState<KiroAccount[]>([]);
  const [kiroLogs, setKiroLogs] = useState<KiroConsumptionLog[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [antigravityCurrentPage, setAntigravityCurrentPage] = useState(1); // Antigravity 分页
  const [totalRecords, setTotalRecords] = useState(0);
  const [antigravityTotalRecords, setAntigravityTotalRecords] = useState(0); // Antigravity 总记录数
  const [activeTab, setActiveTab] = useState<'antigravity' | 'kiro'>('antigravity');
  const [isLoading, setIsLoading] = useState(true);
  const pageSize = 50;

  useEffect(() => {
    loadData();
  }, [activeTab, currentPage, antigravityCurrentPage]);

  const loadData = async () => {
    setIsLoading(true);
    try {
      if (activeTab === 'antigravity') {
        const [quotasData, consumptionsData] = await Promise.all([
          getUserQuotas(),
          getQuotaConsumption({ limit: 1000 }) // 获取更多记录用于分页
        ]);
        setQuotas(quotasData);
        setAllConsumptions(consumptionsData);
        setAntigravityTotalRecords(consumptionsData.length);

        // 前端分页
        const startIndex = (antigravityCurrentPage - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        setConsumptions(consumptionsData.slice(startIndex, endIndex));
      } else if (activeTab === 'kiro') {
        const [statsData, accountsData] = await Promise.all([
          getKiroConsumptionStats(),
          getKiroAccounts()
        ]);
        setKiroStats(statsData);
        setKiroAccounts(accountsData);

        // 加载所有账号的消费记录并聚合
        await loadKiroLogs(accountsData);
      }
    } catch (err) {
      toasterRef.current?.show({
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载数据失败',
        variant: 'error',
        position: 'top-right',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const loadKiroLogs = async (accounts: KiroAccount[]) => {
    if (accounts.length === 0) return;

    try {
      // 聚合所有账号的消费记录
      const allLogs: KiroConsumptionLog[] = [];
      let totalCount = 0;

      await Promise.all(
        accounts.map(async (account) => {
          try {
            const consumptionData = await getKiroAccountConsumption(account.account_id, {
              limit: 1000  // 获取足够多的记录用于聚合
            });
            allLogs.push(...consumptionData.logs);
            totalCount += consumptionData.pagination.total;
          } catch (err) {
            console.error(`加载账号${account.account_id}消费记录失败:`, err);
          }
        })
      );

      // 按时间降序排序
      allLogs.sort((a, b) => new Date(b.consumed_at).getTime() - new Date(a.consumed_at).getTime());

      // 分页
      const startIndex = (currentPage - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      setKiroLogs(allLogs.slice(startIndex, endIndex));
      setTotalRecords(allLogs.length);
    } catch (err) {
      toasterRef.current?.show({
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载消费记录失败',
        variant: 'error',
        position: 'top-right',
      });
    }
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const handleAntigravityPageChange = (page: number) => {
    setAntigravityCurrentPage(page);
    // 前端分页，直接从 allConsumptions 中切片
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    setConsumptions(allConsumptions.slice(startIndex, endIndex));
  };

  const totalPages = Math.ceil(totalRecords / pageSize);
  const antigravityTotalPages = Math.ceil(antigravityTotalRecords / pageSize);

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
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gpt-oss-120b-medium': 'GPT OSS 120B (Medium)',
      'gemini-3-pro-image': 'Gemini 3 Pro Image',
      'gemini-3-pro-high': 'Gemini 3 Pro (High)',
      'gemini-3-pro-low': 'Gemini 3 Pro (Low)',
      'claude-sonnet-4-5': 'Claude Sonnet 4.5',
      'rev19-uic3-1p': 'Rev19 UIC3 1P',
      'chat_20706': 'Chat 20706',
      'chat_23310': 'Chat 23310',
    };
    return modelNames[model] || model;
  };

  // 对配额列表按指定顺序排序
  const sortedQuotas = [...quotas].sort((a, b) => {
    const indexA = MODEL_ORDER.indexOf(a.model_name);
    const indexB = MODEL_ORDER.indexOf(b.model_name);
    // 如果模型不在列表中，放到最后
    if (indexA === -1 && indexB === -1) return 0;
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  const formatQuota = (quota: string) => {
    const num = parseFloat(quota);
    return isNaN(num) ? '0.0000' : num.toFixed(4);
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

  if (isLoading && !kiroLogs.length) {
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
        {/* 页面标题和配置选择 */}
        <div className="flex items-center justify-between mb-6">
          <div></div>
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
            </SelectContent>
          </Select>
        </div>

        <Toaster ref={toasterRef} defaultPosition="top-right" />

        {/* 反重力配额列表 */}
        {activeTab === 'antigravity' && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>模型配额</CardTitle>
              <CardDescription>
                您可以使用 {quotas.length} 个模型。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {quotas.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无配额信息</p>
                </div>
              ) : (
                <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[180px]">模型名称</TableHead>
                        <TableHead className="min-w-[100px]">当前配额</TableHead>
                        <TableHead className="min-w-[100px]">最大配额</TableHead>
                        <TableHead className="min-w-[80px]">使用率</TableHead>
                        <TableHead className="min-w-[150px]">最后更新</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedQuotas.map((quotaItem) => {
                        const current = parseFloat(quotaItem.quota);
                        const max = parseFloat(quotaItem.max_quota);
                        const usagePercent = max > 0 ? ((max - current) / max * 100).toFixed(1) : '0.0';

                        return (
                          <TableRow key={quotaItem.pool_id}>
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2">
                                {getModelIcon(quotaItem.model_name)}
                                <span className="whitespace-nowrap">{getModelDisplayName(quotaItem.model_name)}</span>
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-sm whitespace-nowrap">
                              {formatQuota(quotaItem.quota)}
                            </TableCell>
                            <TableCell className="font-mono text-sm whitespace-nowrap">
                              {formatQuota(quotaItem.max_quota)}
                            </TableCell>
                            <TableCell>
                              <Badge variant={parseFloat(usagePercent) > 50 ? 'destructive' : 'secondary'} className="whitespace-nowrap">
                                {usagePercent}%
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {new Date(quotaItem.last_updated_at).toLocaleString('zh-CN')}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 反重力使用记录 */}
        {activeTab === 'antigravity' && (
          <Card>
            <CardHeader>
              <CardTitle>使用记录</CardTitle>
              <CardDescription>
                共 {antigravityTotalRecords} 条使用记录
              </CardDescription>
            </CardHeader>
            <CardContent>
              {consumptions.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-lg mb-2">暂无使用记录</p>
                  <p className="text-sm">立即创建您的 API Key 开始对话吧！</p>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[150px]">账号 ID</TableHead>
                          <TableHead className="min-w-[150px]">模型</TableHead>
                          <TableHead className="min-w-[100px]">消耗配额</TableHead>
                          <TableHead className="min-w-[150px]">时间</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {consumptions.map((consumption) => (
                          <TableRow key={consumption.log_id}>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              <div className="max-w-[150px] truncate" title={consumption.cookie_id || '-'}>
                                {consumption.cookie_id ? consumption.cookie_id : '-'}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="whitespace-nowrap">
                                {getModelDisplayName(consumption.model_name)}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-sm whitespace-nowrap">
                              -{formatQuota(consumption.quota_consumed)}
                            </TableCell>
                            <TableCell className="text-sm whitespace-nowrap">
                              {new Date(consumption.consumed_at).toLocaleString('zh-CN')}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Antigravity 分页 */}
                  {antigravityTotalPages > 1 && (
                    <div className="mt-4 flex justify-center">
                      <Pagination>
                        <PaginationContent>
                          <PaginationItem>
                            <PaginationPrevious
                              onClick={() => antigravityCurrentPage > 1 && handleAntigravityPageChange(antigravityCurrentPage - 1)}
                              className={antigravityCurrentPage === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                            />
                          </PaginationItem>

                          {Array.from({ length: Math.min(antigravityTotalPages, 5) }, (_, i) => {
                            let pageNum;
                            if (antigravityTotalPages <= 5) {
                              pageNum = i + 1;
                            } else if (antigravityCurrentPage <= 3) {
                              pageNum = i + 1;
                            } else if (antigravityCurrentPage >= antigravityTotalPages - 2) {
                              pageNum = antigravityTotalPages - 4 + i;
                            } else {
                              pageNum = antigravityCurrentPage - 2 + i;
                            }

                            return (
                              <PaginationItem key={pageNum}>
                                <PaginationLink
                                  onClick={() => handleAntigravityPageChange(pageNum)}
                                  isActive={antigravityCurrentPage === pageNum}
                                  className="cursor-pointer"
                                >
                                  {pageNum}
                                </PaginationLink>
                              </PaginationItem>
                            );
                          })}

                          {antigravityTotalPages > 5 && antigravityCurrentPage < antigravityTotalPages - 2 && (
                            <PaginationItem>
                              <PaginationEllipsis />
                            </PaginationItem>
                          )}

                          <PaginationItem>
                            <PaginationNext
                              onClick={() => antigravityCurrentPage < antigravityTotalPages && handleAntigravityPageChange(antigravityCurrentPage + 1)}
                              className={antigravityCurrentPage === antigravityTotalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                            />
                          </PaginationItem>
                        </PaginationContent>
                      </Pagination>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Kiro 消费统计 */}
        {activeTab === 'kiro' && (
          <>
            {/* 总体统计 */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>消费统计</CardTitle>
              </CardHeader>
              <CardContent>
                {kiroStats && kiroStats.total_credit !== undefined ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">总请求数</p>
                      <p className="text-2xl font-bold">{kiroStats.total_requests || '0'}</p>
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">总消费额度</p>
                      <p className="text-2xl font-bold">${parseFloat(kiroStats.total_credit || '0').toFixed(4)}</p>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-12 text-muted-foreground">
                    <p className="text-sm">暂无消费数据</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 使用记录 */}
            <Card>
              <CardHeader>
                <CardTitle>使用记录</CardTitle>
                <CardDescription>
                  共 {totalRecords} 条使用记录
                </CardDescription>
              </CardHeader>
              <CardContent>
                {kiroLogs.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <p className="text-lg mb-2">暂无使用记录</p>
                    <p className="text-sm">开始使用Kiro账号进行对话吧！</p>
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="min-w-[120px]">账号ID</TableHead>
                            <TableHead className="min-w-[150px]">账号名称</TableHead>
                            <TableHead className="min-w-[150px]">模型</TableHead>
                            <TableHead className="min-w-[100px]">消耗额度</TableHead>
                            <TableHead className="min-w-[150px]">时间</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {kiroLogs.map((log) => (
                            <TableRow key={log.log_id}>
                              <TableCell className="font-mono text-xs">
                                {log.account_id}
                              </TableCell>
                              <TableCell className="text-sm">
                                {log.account_name || '未命名'}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="whitespace-nowrap">
                                  {getModelDisplayName(log.model_id)}
                                </Badge>
                              </TableCell>
                              <TableCell className="font-mono text-sm whitespace-nowrap">
                                ${typeof log.credit_used === 'number' ? log.credit_used.toFixed(4) : parseFloat(log.credit_used || '0').toFixed(4)}
                              </TableCell>
                              <TableCell className="text-sm whitespace-nowrap">
                                {new Date(log.consumed_at).toLocaleString('zh-CN')}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    {/* 分页 */}
                    {totalPages > 1 && (
                      <div className="mt-4 flex justify-center">
                        <Pagination>
                          <PaginationContent>
                            <PaginationItem>
                              <PaginationPrevious
                                onClick={() => currentPage > 1 && handlePageChange(currentPage - 1)}
                                className={currentPage === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                              />
                            </PaginationItem>

                            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                              let pageNum;
                              if (totalPages <= 5) {
                                pageNum = i + 1;
                              } else if (currentPage <= 3) {
                                pageNum = i + 1;
                              } else if (currentPage >= totalPages - 2) {
                                pageNum = totalPages - 4 + i;
                              } else {
                                pageNum = currentPage - 2 + i;
                              }

                              return (
                                <PaginationItem key={pageNum}>
                                  <PaginationLink
                                    onClick={() => handlePageChange(pageNum)}
                                    isActive={currentPage === pageNum}
                                    className="cursor-pointer"
                                  >
                                    {pageNum}
                                  </PaginationLink>
                                </PaginationItem>
                              );
                            })}

                            {totalPages > 5 && currentPage < totalPages - 2 && (
                              <PaginationItem>
                                <PaginationEllipsis />
                              </PaginationItem>
                            )}

                            <PaginationItem>
                              <PaginationNext
                                onClick={() => currentPage < totalPages && handlePageChange(currentPage + 1)}
                                className={currentPage === totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                              />
                            </PaginationItem>
                          </PaginationContent>
                        </Pagination>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
