'use client';

import { useEffect, useState } from "react"
import { IconUsers, IconCpu, IconChartBar, IconActivity } from "@tabler/icons-react"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  getQuotaConsumption,
  getKiroAccounts,
  getKiroConsumptionStats,
  getKiroAccountConsumption,
  getAccounts,
  getQwenAccounts,
} from "@/lib/api"

interface ComputedStats {
  totalAccounts: number;
  activeAccounts: number;
  consumedLast24h: number;
  callsLast24h: number;
  totalRequests: number;
  totalQuotaConsumed: number;
}

export function SectionCards() {
  const [stats, setStats] = useState<ComputedStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadStats = async () => {
      try {
        const now = new Date();
        const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const [antigravityAccounts, antigravityConsumption, qwenAccounts] = await Promise.all([
          getAccounts(),
          getQuotaConsumption({ limit: 1000 }),
          getQwenAccounts().catch(() => []),
        ]);

        // 计算24小时内的消耗
        const recentConsumption = antigravityConsumption.filter(c => new Date(c.consumed_at) >= last24h);
        const antigravityConsumedLast24h = recentConsumption.reduce((sum, c) => sum + (Number.parseFloat(c.quota_consumed) || 0), 0);
        const antigravityCallsLast24h = recentConsumption.length;
        const antigravityTotalQuotaConsumed = antigravityConsumption.reduce((sum, c) => sum + (Number.parseFloat(c.quota_consumed) || 0), 0);
        const antigravityTotalRequests = antigravityConsumption.length;

        // 获取 Kiro 数据
        let kiroAccounts: any[] = [];
        let totalKiroRequests = 0;
        let totalKiroQuotaConsumed = 0;
        let kiroConsumedLast24h = 0;
        let kiroCallsLast24h = 0;

        try {
          // 获取 Kiro 账号
          kiroAccounts = await getKiroAccounts();

          // 获取 Kiro 消费统计
          const kiroStats = await getKiroConsumptionStats();
          totalKiroRequests = Number.parseInt(kiroStats.total_requests, 10) || 0;
          totalKiroQuotaConsumed = Number.parseFloat(kiroStats.total_credit) || 0;

          // 计算 Kiro 24小时数据（按账号聚合）
          if (kiroAccounts.length > 0) {
            const responses = await Promise.all(
              kiroAccounts.map((account) =>
                getKiroAccountConsumption(account.account_id, {
                  limit: 1000,
                  start_date: last24h.toISOString(),
                  end_date: now.toISOString(),
                }).catch(() => null)
              )
            );
            const logs = responses.flatMap((resp) => resp?.logs ?? []);
            kiroConsumedLast24h = logs.reduce((sum, log) => sum + (log.credit_used || 0), 0);
            kiroCallsLast24h = logs.length;
          }
        } catch (err) {
          console.warn('加载 Kiro 数据失败，仅显示 Antigravity 数据', err);
        }

        const totalAccounts = antigravityAccounts.length + kiroAccounts.length + qwenAccounts.length;
        const activeAccounts =
          antigravityAccounts.filter((a) => a.status === 1).length +
          kiroAccounts.filter((a) => a.status === 1).length +
          qwenAccounts.filter((a) => a.status === 1).length;

        setStats({
          totalAccounts,
          activeAccounts,
          consumedLast24h: antigravityConsumedLast24h + kiroConsumedLast24h,
          callsLast24h: antigravityCallsLast24h + kiroCallsLast24h,
          totalRequests: antigravityTotalRequests + totalKiroRequests,
          totalQuotaConsumed: antigravityTotalQuotaConsumed + totalKiroQuotaConsumed,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载数据失败');
      } finally {
        setIsLoading(false);
      }
    };

    loadStats();
  }, []);

  if (isLoading) {
    return (
      <div className="*:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="@container/card">
            <CardHeader>
              <Skeleton className="h-4 w-32 mb-2" />
              <Skeleton className="h-8 w-24" />
            </CardHeader>
            <CardFooter className="flex-col items-start gap-1.5">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-32" />
            </CardFooter>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 lg:px-6">
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="*:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>账户总数</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {stats?.totalAccounts || 0}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <IconUsers className="size-4" />
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="text-muted-foreground">
            全部渠道合计
          </div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>活跃账号数</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {stats?.activeAccounts || 0}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <IconCpu className="size-4" />
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="text-muted-foreground">
            全部渠道活跃账号
          </div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>24小时配额消耗</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {(stats?.consumedLast24h || 0).toFixed(2)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <IconChartBar className="size-4" />
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            总消耗: {(stats?.totalQuotaConsumed || 0).toFixed(2)}
          </div>
          <div className="text-muted-foreground">全部渠道配额消耗合计</div>
        </CardFooter>
      </Card>
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>24小时调用量</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {(stats?.callsLast24h || 0).toLocaleString()}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <IconActivity className="size-4" />
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            总调用: {(stats?.totalRequests || 0).toLocaleString()} 次
          </div>
          <div className="text-muted-foreground">全部渠道 API 调用合计</div>
        </CardFooter>
      </Card>
    </div>
  )
}
