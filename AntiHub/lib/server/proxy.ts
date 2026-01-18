import { getInternalApiBaseUrl } from '@/lib/apiBase';

function joinPath(basePath: string, extraPath: string): string {
  const base = basePath ? basePath.replace(/\/+$/, '') : '';
  const extra = extraPath ? `/${extraPath.replace(/^\/+/, '')}` : '/';
  return base ? `${base}${extra}` : extra;
}

function stripHopByHopHeaders(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  const hopByHop = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
  ];
  hopByHop.forEach((h) => cleaned.delete(h));
  cleaned.delete('content-length');
  return cleaned;
}

export async function proxyToBackend(request: Request, targetPathname: string): Promise<Response> {
  const backendBaseUrl = getInternalApiBaseUrl();
  const upstreamBase = new URL(backendBaseUrl);
  const incomingUrl = new URL(request.url);

  const upstreamUrl = new URL(upstreamBase.toString());
  upstreamUrl.pathname = joinPath(upstreamBase.pathname, targetPathname);
  upstreamUrl.search = incomingUrl.search;

  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());

  const headers = stripHopByHopHeaders(request.headers);
  headers.set('x-forwarded-host', incomingUrl.host);
  headers.set('x-forwarded-proto', incomingUrl.protocol.replace(':', ''));

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[proxyToBackend] upstream fetch failed', {
      upstreamUrl: upstreamUrl.toString(),
      error,
    });
    return new Response(
      JSON.stringify({
        detail: 'Backend unreachable',
      }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  responseHeaders.delete('transfer-encoding');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
