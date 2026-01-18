import { proxyToBackend } from '@/lib/server/proxy';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(request: NextRequest) {
  return proxyToBackend(request, '/api/kiro/oauth/callback');
}

export { handler as DELETE, handler as GET, handler as HEAD, handler as OPTIONS, handler as PATCH, handler as POST, handler as PUT };
