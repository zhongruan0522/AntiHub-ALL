import { proxyToBackend } from '@/lib/server/proxy';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteParams = {
  path?: string[];
};

async function handler(request: NextRequest, context: { params: Promise<RouteParams> }) {
  const { path } = await context.params;
  const rest = path?.join('/') ?? '';
  return proxyToBackend(request, `/${rest}`);
}

export { handler as DELETE, handler as GET, handler as HEAD, handler as OPTIONS, handler as PATCH, handler as POST, handler as PUT };
