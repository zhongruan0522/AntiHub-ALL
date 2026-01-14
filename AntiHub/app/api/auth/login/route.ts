import { NextRequest, NextResponse } from 'next/server';

import { getInternalApiBaseUrl } from '@/lib/apiBase';
import { getCookieSecure } from '@/lib/cookie';

/**
 * 用户名密码登录（服务端代理）
 * 目的：由 Next.js 在同域设置 httpOnly cookie，避免 /dashboard 被 middleware 重定向回 /auth
 */
export async function POST(request: NextRequest) {
  const API_BASE_URL = getInternalApiBaseUrl();

  try {
    const body = await request.json().catch(() => ({}));

    const upstream = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return NextResponse.json(data, { status: upstream.status });
    }

    const { access_token, refresh_token, user } = data as {
      access_token?: string;
      refresh_token?: string;
      user?: unknown;
    };

    const response = NextResponse.json(data);

    if (access_token) {
      response.cookies.set('access_token', access_token, {
        httpOnly: true,
        secure: getCookieSecure(),
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 天
        path: '/',
      });
    }

    if (refresh_token) {
      response.cookies.set('refresh_token', refresh_token, {
        httpOnly: true,
        secure: getCookieSecure(),
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 天
        path: '/',
      });
    }

    if (user) {
      response.cookies.set('user', JSON.stringify(user), {
        httpOnly: false,
        secure: getCookieSecure(),
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
        path: '/',
      });
    }

    return response;
  } catch (error) {
    console.error('Password login error:', error);
    return NextResponse.json({ detail: '登录失败' }, { status: 500 });
  }
}
