import { NextRequest, NextResponse } from 'next/server';

import { getInternalApiBaseUrl } from '@/lib/apiBase';

/**
 * OAuth 回调处理 (Linux.do SSO)
 * 接收来自 OAuth 提供商的 code 和 state,
 * 转发给后端 API 完成认证,然后重定向到前端
 */
export async function GET(request: NextRequest) {
  const API_BASE_URL = getInternalApiBaseUrl();
  const FRONTEND_URL = request.nextUrl.origin;

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // 如果有错误,重定向到登录页并显示错误
  if (error) {
    return NextResponse.redirect(
      new URL(`/auth?error=${encodeURIComponent(error)}`, FRONTEND_URL)
    );
  }

  // 如果缺少必要参数,返回错误
  if (!code || !state) {
    return NextResponse.redirect(
      new URL('/auth?error=missing_oauth_params', FRONTEND_URL)
    );
  }

  try {
    // 调用后端 API 完成 OAuth 流程
    const response = await fetch(
      `${API_BASE_URL}/api/auth/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      {
        method: 'GET',
      }
    );

    if (!response.ok) {
      throw new Error('OAuth 认证失败');
    }

    const data = await response.json();
    const { access_token, refresh_token, expires_in, user } = data;

    // 创建重定向 URL,包含用户信息用于 localStorage 同步
    const redirectUrl = new URL('/dashboard', FRONTEND_URL);
    redirectUrl.searchParams.set('login', 'success');
    redirectUrl.searchParams.set('token', access_token);
    redirectUrl.searchParams.set('user', encodeURIComponent(JSON.stringify(user)));
    
    // 添加 refresh_token 和 expires_in 参数
    if (refresh_token) {
      redirectUrl.searchParams.set('refresh_token', refresh_token);
    }
    if (expires_in) {
      redirectUrl.searchParams.set('expires_in', String(expires_in));
    }

    const redirectResponse = NextResponse.redirect(redirectUrl);

    // 同时设置 cookie 作为备份
    redirectResponse.cookies.set('access_token', access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 天
      path: '/',
    });

    if (refresh_token) {
      redirectResponse.cookies.set('refresh_token', refresh_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 天
        path: '/',
      });
    }

    redirectResponse.cookies.set('user', JSON.stringify(user), {
      httpOnly: false, // 允许客户端读取用户信息
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    return redirectResponse;
  } catch (error) {
    console.error('OAuth callback error:', error);
    return NextResponse.redirect(
      new URL('/auth?error=oauth_callback_failed', FRONTEND_URL)
    );
  }
}
