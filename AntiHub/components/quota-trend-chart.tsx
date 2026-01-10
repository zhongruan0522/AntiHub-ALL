"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { getQuotaConsumption, type QuotaConsumption, getKiroAccounts, getKiroAccountConsumption, type KiroConsumptionLog } from "@/lib/api"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const chartConfig = {
  antigravity: {
    label: "Antigravity 配额消耗",
    color: "hsl(var(--chart-1))",
  },
  kiro: {
    label: "Kiro 配额消耗",
    color: "hsl(var(--chart-2))",
  },
} satisfies ChartConfig

interface TrendDataPoint {
  time: string;
  antigravity: number;
  kiro: number;
}

export function QuotaTrendChart() {
  const [timeRange, setTimeRange] = React.useState("24")
  const [data, setData] = React.useState<TrendDataPoint[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const loadData = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const hours = parseInt(timeRange)
        const now = new Date()
        const startTime = new Date(now.getTime() - hours * 60 * 60 * 1000)

        // 获取 Antigravity 消耗记录
        const antigravityData = await getQuotaConsumption({
          limit: 1000,
          start_date: startTime.toISOString(),
          end_date: now.toISOString()
        })

        // 获取 Kiro 消耗记录
        let kiroData: KiroConsumptionLog[] = []
        try {
          const kiroAccounts = await getKiroAccounts()
          // 获取所有 Kiro 账号的消费记录
          const kiroPromises = kiroAccounts.map(account =>
            getKiroAccountConsumption(account.account_id, {
              limit: 1000,
              start_date: startTime.toISOString(),
              end_date: now.toISOString()
            }).then(result => result.logs)
          )
          const allLogs = await Promise.all(kiroPromises)
          kiroData = allLogs.flat()
        } catch (err) {
          console.warn('加载 Kiro 数据失败，仅显示 Antigravity 数据', err)
        }

        // 按小时聚合数据
        const hourlyData = new Map<string, { antigravity: number; kiro: number }>()

        // 聚合 Antigravity 数据
        antigravityData.forEach(record => {
          const date = new Date(record.consumed_at)
          const hourKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCHours()).padStart(2, '0')}`
          const existing = hourlyData.get(hourKey) || { antigravity: 0, kiro: 0 }
          existing.antigravity += parseFloat(record.quota_consumed)
          hourlyData.set(hourKey, existing)
        })

        // 聚合 Kiro 数据
        kiroData.forEach(record => {
          const date = new Date(record.consumed_at)
          const hourKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCHours()).padStart(2, '0')}`
          const existing = hourlyData.get(hourKey) || { antigravity: 0, kiro: 0 }
          existing.kiro += record.credit_used
          hourlyData.set(hourKey, existing)
        })

        // 转换为图表数据
        const chartData: TrendDataPoint[] = []
        for (let i = 0; i < hours; i++) {
          const time = new Date(now.getTime() - (hours - i) * 60 * 60 * 1000)
          const hourKey = `${time.getUTCFullYear()}-${String(time.getUTCMonth() + 1).padStart(2, '0')}-${String(time.getUTCDate()).padStart(2, '0')}-${String(time.getUTCHours()).padStart(2, '0')}`
          const data = hourlyData.get(hourKey) || { antigravity: 0, kiro: 0 }

          chartData.push({
            time: hourKey,
            antigravity: data.antigravity,
            kiro: data.kiro
          })
        }

        setData(chartData)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载趋势数据失败')
      } finally {
        setIsLoading(false)
      }
    }

    loadData()
  }, [timeRange])

  if (isLoading) {
    return (
      <Card className="@container/card">
        <CardHeader>
          <Skeleton className="h-6 w-32 mb-2" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
          <Skeleton className="h-[250px] w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="@container/card">
        <CardHeader>
          <CardTitle>配额消耗趋势</CardTitle>
          <CardDescription>配额使用情况</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[250px]">
          <div className="text-red-500 text-sm">{error}</div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>配额消耗趋势</CardTitle>
        <CardAction>
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger
              className="w-40"
              size="sm"
              aria-label="选择时间范围"
            >
              <SelectValue placeholder="过去24小时" />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectItem value="24" className="rounded-lg">
                过去24小时
              </SelectItem>
              <SelectItem value="48" className="rounded-lg">
                过去48小时
              </SelectItem>
              <SelectItem value="168" className="rounded-lg">
                过去7天
              </SelectItem>
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] w-full"
        >
          <AreaChart data={data}>
            <defs>
              <linearGradient id="fillAntigravity" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-antigravity)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-antigravity)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillKiro" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-kiro)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-kiro)"
                  stopOpacity={0.1}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="time"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) => {
                // 解析 hourKey: "YYYY-MM-DD-HH"
                const [year, month, day, hour] = value.split('-')
                const date = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour)))
                return date.toLocaleString("zh-CN", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                })
              }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => value.toLocaleString()}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => {
                    // 解析 hourKey: "YYYY-MM-DD-HH"
                    const [year, month, day, hour] = value.split('-')
                    const date = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour)))
                    return date.toLocaleString("zh-CN", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                    }) + '点'
                  }}
                  indicator="dot"
                />
              }
            />
            <Area
              dataKey="antigravity"
              type="monotone"
              fill="url(#fillAntigravity)"
              stroke="var(--color-antigravity)"
              strokeWidth={2}
            />
            <Area
              dataKey="kiro"
              type="monotone"
              fill="url(#fillKiro)"
              stroke="var(--color-kiro)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
