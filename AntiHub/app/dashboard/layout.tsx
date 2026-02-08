'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { MorphingSquare } from '@/components/ui/morphing-square';
import { setupTokenRefresh } from '@/lib/api';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const searchParams = useSearchParams();
  const [isAuthReady, setIsAuthReady] = useState(false);

  useEffect(() => {
    // 检查是否是登录后的重定向
    const loginSuccess = searchParams.get('login');
    const token = searchParams.get('token');
    const userParam = searchParams.get('user');
    const refreshToken = searchParams.get('refresh_token');
    const expiresIn = searchParams.get('expires_in');

    if (loginSuccess === 'success' && token && userParam) {
      try {
        // 立即同步存储到 localStorage
        localStorage.setItem('access_token', token);
        localStorage.setItem('user', decodeURIComponent(userParam));
        console.log('Access token synced to localStorage');
        
        // 保存 refresh_token（关键：必须保存，否则无法刷新）
        if (refreshToken) {
          localStorage.setItem('refresh_token', refreshToken);
          console.log('Refresh token synced to localStorage:', refreshToken.substring(0, 20) + '...');
        } else {
          console.warn('警告：登录成功但没有收到 refresh_token');
        }
        
        // 保存 token 过期时间
        if (expiresIn) {
          const expiresAt = Date.now() + parseInt(expiresIn, 10) * 1000;
          localStorage.setItem('token_expires_at', String(expiresAt));
          console.log('Token expires at:', new Date(expiresAt).toISOString());
        }
      } catch (error) {
        console.error('Failed to sync login data:', error);
      }
    }

    // 设置主动令牌刷新
    const cleanup = setupTokenRefresh(() => {
      // 刷新失败时，重定向到登录页
      console.error('Token refresh failed, redirecting to login');
      window.location.href = '/auth?error=session_expired';
    });

    // 标记认证已就绪
    setIsAuthReady(true);

    // 清理函数
    return cleanup;
  }, [searchParams]);

  // 等待认证状态就绪后再渲染子组件
  if (!isAuthReady) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <MorphingSquare message="加载中..." />
      </div>
    );
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      <SidebarInset className="overflow-clip">
        <SiteHeader />
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="@container/main flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain">
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
