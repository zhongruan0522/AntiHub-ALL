import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { getInternalApiBaseUrl } from './lib/apiBase';

const API_BASE_URL = getInternalApiBaseUrl();

/**
 * 尝试刷新 token
 */
async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
} | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Token refresh failed in middleware:', error);
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 检查是否访问 dashboard 路由
  if (pathname.startsWith('/dashboard')) {
    const accessToken = request.cookies.get('access_token')?.value;
    const refreshToken = request.cookies.get('refresh_token')?.value;

    // 如果没有 access_token
    if (!accessToken) {
      // 尝试使用 refresh_token 刷新
      if (refreshToken) {
        const newTokens = await refreshAccessToken(refreshToken);
        
        if (newTokens) {
          // 刷新成功，设置新的 cookies 并继续请求
          const response = NextResponse.next();
          
          response.cookies.set('access_token', newTokens.access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 60 * 60 * 24 * 7, // 7 天
            path: '/',
          });

          response.cookies.set('refresh_token', newTokens.refresh_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 60 * 60 * 24 * 30, // 30 天
            path: '/',
          });

          // 添加自定义 header 通知客户端更新 localStorage
          response.headers.set('X-Token-Refreshed', 'true');
          response.headers.set('X-New-Access-Token', newTokens.access_token);
          response.headers.set('X-New-Refresh-Token', newTokens.refresh_token);
          response.headers.set('X-Token-Expires-In', String(newTokens.expires_in));

          return response;
        }
      }
      
      // 没有 refresh_token 或刷新失败，重定向到登录页
      const url = new URL('/auth', request.url);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

// 配置需要应用中间件的路径
export const config = {
  matcher: [
    '/dashboard/:path*',
  ],
};
