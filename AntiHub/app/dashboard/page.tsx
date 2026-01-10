'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { SectionCards } from "@/components/section-cards"
import { QuotaTrendChart } from "@/components/quota-trend-chart"
import { MorphingSquare } from '@/components/ui/morphing-square';

function DashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    // 清除登录成功后的 URL 参数（token 已在 layout 中同步）
    const loginSuccess = searchParams.get('login');
    if (loginSuccess === 'success') {
      router.replace('/dashboard');
    }
  }, [searchParams, router]);

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* 统计卡片 */}
      <SectionCards />

      {/* 配额消耗趋势图表 */}
      <div className="px-4 lg:px-6">
        <QuotaTrendChart />
      </div>
    </div>
  )
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="px-4 lg:px-6">
      <div className="flex items-center justify-center min-h-screen">
        <MorphingSquare message="加载中..." />
      </div>
    </div>}>
      <DashboardContent />
    </Suspense>
  )
}
