/**
 * Ultra proxy engine.
 *
 * A single hardened streaming/HTTP relay used by /api/public/proxy and
 * /api/proxy. Handles:
 *   - any HTTP method + request body passthrough
 *   - HTTP Range requests (206 passthrough) so players can seek
 *   - HLS (.m3u8) rewriting: variants, segments, #EXT-X-KEY, #EXT-X-MAP,
 *     #EXT-X-MEDIA, I-frame playlists — with parent query inheritance for
 *     signed CDNs (hdnea / token in query)
 *   - MPEG-DASH (.mpd) rewriting: BaseURL, SegmentTemplate, SegmentURL
 *   - subtitle (.vtt) rewriting
 *   - optional HTML rewriting (mode=html)
 *   - per-host identity presets (SonyLiv, Hotstar mobile UA, JioCinema)
 *   - arbitrary header injection via ?h.<header>=<value>
 *   - manual redirect chasing so redirect targets stay proxied
 *   - retries with backoff + request timeout
 *   - SSRF guard: no localhost / private / link-local targets
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SONY_UA = DEFAULT_UA
const SONY_ORIGIN = 'https://www.sonyliv.com'
const SONY_REFERER = 'https://www.sonyliv.com/'

/* Hotstar's mobile UA is required by jcevents.hotstar.com segments — jcevents
   returns 403 to a desktop UA even with a valid token. */
const HOTSTAR_UA = 'Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)'
const HOTSTAR_ORIGIN = 'https://www.hotstar.com'
const HOTSTAR_REFERER = 'https://www.hotstar.com/'

const JIO_ORIGIN = 'https://www.jiocinema.com'
const JIO_REFERER = 'https://www.jiocinema.com/'

const SONY_HOSTS = ['slivcdn.com', 'sonydaimenew.akamaized.net']
const HOTSTAR_MOBILE_UA_HOSTS = ['jcevents.hotstar.com', 'livetv.hotstar.com', 'live09p.hotstar.com']

const suffixMatch = (host: string, list: string[]) =>
  list.some((s) => host === s || host.endsWith('.' + s))

const isSonyHost = (h: string) => suffixMatch(h, SONY_HOSTS)
const isHotstarHost = (h: string) => suffixMatch(h, ['hotstar.com'])
const needsHotstarMobileUA = (h: string) => suffixMatch(h, HOTSTAR_MOBILE_UA_HOSTS)
const isJioHost = (h: string) => suffixMatch(h, ['jiocinema.com', 'jio.com'])

/**
 * Optional allowlist. Empty = open relay for public internet hosts (private
 * ranges are always refused). Set PROXY_ALLOWED_HOSTS="a.com,b.net" to lock
 * it down, and PROXY_KEY to require ?key= on every request.
 */
function configuredAllowlist(): string[] {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.['PROXY_ALLOWED_HOSTS']
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function configuredKey(): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'PROXY_KEY'
  ]
}

/* Refuse anything that could reach infrastructure rather than the internet. */
const PRIVATE_RE =
  /^(localhost|.*\.local|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i

export function hostRefusal(host: string): string | null {
  const h = host.toLowerCase()
  if (!h || PRIVATE_RE.test(h)) return 'Target host is not routable'
  const allow = configuredAllowlist()
  if (allow.length && !suffixMatch(h, allow)) return 'Host not allowed'
  return null
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Timing-Allow-Origin': '*',
  }
}

type Identity = { ua: string; referer: string; origin: string }

function identityFor(host: string, ua: string, ref: string, origin: string): Identity {
  if (isSonyHost(host)) {
    return { ua: ua || SONY_UA, referer: ref || SONY_REFERER, origin: origin || SONY_ORIGIN }
  }
  if (needsHotstarMobileUA(host)) {
    return { ua: ua || HOTSTAR_UA, referer: ref || HOTSTAR_REFERER, origin: origin || HOTSTAR_ORIGIN }
  }
  if (isHotstarHost(host)) {
    return { ua: ua || DEFAULT_UA, referer: ref || HOTSTAR_REFERER, origin: origin || HOTSTAR_ORIGIN }
  }
  if (/(^|\.)fancode\.com$/i.test(host)) {
    return { ua: ua || DEFAULT_UA, referer: ref || 'https://www.fancode.com/', origin: origin || 'https://www.fancode.com' }
  }
  if (isJioHost(host)) {
    return { ua: ua || DEFAULT_UA, referer: ref || JIO_REFERER, origin: origin || JIO_ORIGIN }
  }
  let refOrigin = 'https://' + host
  if (ref) {
    try {
      refOrigin = new URL(ref).origin
    } catch {
      /* keep derived origin */
    }
  }
  return { ua: ua || DEFAULT_UA, referer: ref || 'https://' + host + '/', origin: origin || refOrigin }
}

/* Carry the caller's identity + injected headers onto every rewritten child
   URL — CDNs check each segment request, not just the manifest. */
function extrasFrom(params: URLSearchParams): string {
  const keep = ['cookie', 'ref', 'ua', 'origin', 'key', 'mode', 'timeout', 'retries']
  const out: string[] = []
  for (const k of keep) {
    const v = params.get(k)
    if (v) out.push(`${k}=${encodeURIComponent(v)}`)
  }
  for (const [k, v] of params.entries()) {
    if (k.startsWith('h.')) out.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  return out.length ? '&' + out.join('&') : ''
}

function makeWrapper(baseUrl: URL, proxyBase: string, extras: string) {
  const parentQuery = baseUrl.search
  const toAbs = (ref: string) => {
    const u = new URL(ref, baseUrl)
    /* Signed CDNs put the token in the query with an acl of /*, and a
       relative child reference throws that query away. Inherit it. */
    if (!u.search && parentQuery) u.search = parentQuery
    return u.toString()
  }
  return (ref: string) => proxyBase + '?u=' + encodeURIComponent(toAbs(ref)) + extras
}

export function rewriteHls(text: string, baseUrl: URL, proxyBase: string, extras: string) {
  const wrap = makeWrapper(baseUrl, proxyBase, extras)
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`)
      return wrap(t)
    })
    .join('\n')
}

export function rewriteDash(text: string, baseUrl: URL, proxyBase: string, extras: string) {
  const wrap = makeWrapper(baseUrl, proxyBase, extras)
  /* $Number$ / $Time$ / $RepresentationID$ placeholders must survive
     encodeURIComponent untouched or the player builds dead segment URLs. */
  const safeWrap = (v: string) => wrap(v).replace(/%24/g, '$')
  let out = text.replace(
    /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/g,
    (m, inner: string) => m.replace(inner, safeWrap(inner.trim())),
  )
  out = out.replace(
    /\b(initialization|media|sourceURL)="([^"]+)"/g,
    (_m, attr: string, val: string) => `${attr}="${safeWrap(val)}"`,
  )
  return out
}

export function rewriteVtt(text: string, baseUrl: URL, proxyBase: string, extras: string) {
  const wrap = makeWrapper(baseUrl, proxyBase, extras)
  return text.replace(/https?:\/\/[^\s"')]+/g, (u) => wrap(u))
}

export function rewriteHtml(text: string, baseUrl: URL, proxyBase: string, extras: string) {
  const wrap = makeWrapper(baseUrl, proxyBase, extras)
  return text.replace(
    /\b(href|src|action|poster)=("|')(?!#|javascript:|data:|mailto:)([^"']+)\2/gi,
    (_m, attr: string, q: string, val: string) => `${attr}=${q}${wrap(val)}${q}`,
  )
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'host',
  'content-length',
])

export async function handleProxy(request: Request): Promise<Response> {
  const started = Date.now()
  const reqUrl = new URL(request.url)
  const p = reqUrl.searchParams

  const requiredKey = configuredKey()
  if (requiredKey && p.get('key') !== requiredKey) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders() })
  }

  const target = p.get('u') || p.get('url')
  if (!target) return new Response('Missing ?u=', { status: 400, headers: corsHeaders() })

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return new Response('Invalid url', { status: 400, headers: corsHeaders() })
  }
  if (!/^https?:$/.test(targetUrl.protocol)) {
    return new Response('Only http(s) targets', { status: 400, headers: corsHeaders() })
  }
  const refusal = hostRefusal(targetUrl.hostname)
  if (refusal) return new Response(refusal, { status: 403, headers: corsHeaders() })

  const cookie = p.get('cookie') || ''
  const identity = identityFor(
    targetUrl.hostname,
    p.get('ua') || '',
    p.get('ref') || '',
    p.get('origin') || '',
  )

  const headers = new Headers({
    'User-Agent': identity.ua,
    Referer: identity.referer,
    Origin: identity.origin,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  })
  if (cookie) headers.set('Cookie', cookie)
  /* Range / conditional headers must survive so seeking and caching work. */
  for (const name of ['range', 'if-none-match', 'if-modified-since', 'content-type']) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }
  /* ?h.x-api-key=abc -> X-Api-Key: abc */
  for (const [k, v] of p.entries()) {
    if (!k.startsWith('h.')) continue
    const name = k.slice(2)
    if (!name || HOP_BY_HOP.has(name.toLowerCase())) continue
    headers.set(name, v)
  }

  const timeoutMs = Math.min(Math.max(Number(p.get('timeout') ?? 20000) || 20000, 1000), 60000)
  const retries = Math.min(Math.max(Number(p.get('retries') ?? 2) || 0, 0), 5)
  const method = request.method.toUpperCase()
  const bodyBuf =
    method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer()

  let currentUrl = targetUrl
  let upstream: Response | null = null
  let lastError = ''
  const hops: string[] = []

  /* If the CDN refuses our browser-style identity, fall back to looking like
     a plain media player (VLC / ffmpeg send no Referer/Origin) — many Akamai
     tokens (e.g. SonyLiv hdnea) only accept that. */
  const userPinned = p.get('ua') || p.get('ref') || p.get('origin')
  const variants: Array<(h: Headers) => void> = [() => {}]
  if (!userPinned) {
    variants.push((h) => {
      h.delete('Referer')
      h.delete('Origin')
      h.set('User-Agent', 'VLC/3.0.20 LibVLC/3.0.20')
    })
    variants.push((h) => {
      h.delete('Referer')
      h.delete('Origin')
      h.delete('Accept-Language')
      h.set('User-Agent', 'Lavf/60.3.100')
    })
  }

  let variantIdx = Math.min(Math.max(Number(p.get('idv') ?? 0) || 0, 0), variants.length - 1)
  variantLoop: for (; variantIdx < variants.length; variantIdx++) {
  variants[variantIdx]?.(headers)
  outer: for (let attempt = 0; attempt <= retries; attempt++) {
    currentUrl = targetUrl
    for (let hop = 0; hop < 6; hop++) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const res = await fetch(currentUrl.toString(), {
          method,
          headers,
          body: bodyBuf ? bodyBuf : null,
          redirect: 'manual',
          signal: ac.signal,
        })
        clearTimeout(timer)
        const loc = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && loc) {
          const next = new URL(loc, currentUrl)
          if (hostRefusal(next.hostname)) {
            return new Response('Redirect to blocked host', {
              status: 403,
              headers: corsHeaders(),
            })
          }
          hops.push(next.toString())
          currentUrl = next
          continue
        }
        upstream = res
        /* 5xx and 429 are worth another attempt; 4xx is a decision. */
        if (res.status >= 500 || res.status === 429) {
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
            continue outer
          }
        }
        break outer
      } catch (e) {
        clearTimeout(timer)
        lastError = (e as Error).message
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
          continue outer
        }
        break outer
      }
    }
  }
  if (
    upstream &&
    (upstream.status === 401 || upstream.status === 403) &&
    variantIdx < variants.length - 1
  ) {
    await upstream.body?.cancel().catch(() => {})
    upstream = null
    continue variantLoop
  }
  break variantLoop
  }

  if (!upstream) {
    return new Response('Upstream failed: ' + (lastError || 'unknown'), {
      status: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
    })
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase()
  const path = currentUrl.pathname.toLowerCase()
  const proxyBase = reqUrl.origin + reqUrl.pathname
  let extras = extrasFrom(p)
  /* Remember which identity worked so child requests skip straight to it. */
  if (variantIdx > 0) extras += `&idv=${variantIdx}`
  /* Akamai often hands out an hdntl/session cookie on the master playlist that
     every child request must present. Players keep it; we carry it forward. */
  const setCookies =
    (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || []
  if (setCookies.length) {
    const jar = new Map<string, string>()
    for (const part of cookie.split(/;\s*/)) {
      const i = part.indexOf('=')
      if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1))
    }
    for (const sc of setCookies) {
      const kv = sc.split(';')[0] ?? ''
      const i = kv.indexOf('=')
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
    }
    const merged = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    extras = extras.replace(/&cookie=[^&]*/, '') + `&cookie=${encodeURIComponent(merged)}`
  }
  const mode = (p.get('mode') || 'auto').toLowerCase()

  if (p.get('debug') === '1') {
    return new Response(
      JSON.stringify(
        {
          target: targetUrl.toString(),
          finalUrl: currentUrl.toString(),
          redirects: hops,
          status: upstream.status,
          ms: Date.now() - started,
          sentHeaders: Object.fromEntries(headers.entries()),
          upstreamHeaders: Object.fromEntries(upstream.headers.entries()),
        },
        null,
        2,
      ),
      { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } },
    )
  }

  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
    const body = await upstream.text().catch(() => '')
    return new Response(body.slice(0, 4000) || `Upstream ${upstream.status}`, {
      status: upstream.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/plain',
        'X-Proxy-Upstream': String(upstream.status),
        'X-Proxy-Final-Url': currentUrl.toString(),
      },
    })
  }

  const isHls =
    mode === 'hls' ||
    (mode === 'auto' && (path.endsWith('.m3u8') || contentType.includes('mpegurl')))
  const isDash =
    mode === 'dash' || (mode === 'auto' && (path.endsWith('.mpd') || contentType.includes('dash+xml')))
  const isVtt = mode === 'vtt' || (mode === 'auto' && (path.endsWith('.vtt') || contentType.includes('text/vtt')))
  const isHtml = mode === 'html'

  if (method !== 'HEAD' && (isHls || isDash || isVtt || isHtml)) {
    const text = await upstream.text()
    const out = isHls
      ? rewriteHls(text, currentUrl, proxyBase, extras)
      : isDash
        ? rewriteDash(text, currentUrl, proxyBase, extras)
        : isVtt
          ? rewriteVtt(text, currentUrl, proxyBase, extras)
          : rewriteHtml(text, currentUrl, proxyBase, extras)
    const ct = isHls
      ? 'application/vnd.apple.mpegurl'
      : isDash
        ? 'application/dash+xml'
        : isVtt
          ? 'text/vtt'
          : 'text/html; charset=utf-8'
    return new Response(out, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': ct,
        'Cache-Control': 'no-cache',
        'X-Proxy-Final-Url': currentUrl.toString(),
        'X-Proxy-Ms': String(Date.now() - started),
      },
    })
  }

  /* Bytes (segments, keys, media, anything else) stream straight through. */
  const outHeaders = new Headers()
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk)) return
    if (lk === 'content-encoding') return // body is delivered decoded
    if (lk === 'content-security-policy' || lk === 'x-frame-options') return
    if (lk.startsWith('access-control-')) return
    outHeaders.set(k, v)
  })
  for (const [k, v] of Object.entries(corsHeaders())) outHeaders.set(k, v)
  outHeaders.set('X-Proxy-Final-Url', currentUrl.toString())
  outHeaders.set('X-Proxy-Ms', String(Date.now() - started))

  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  })
}

export function proxyHandlers() {
  const any = async ({ request }: { request: Request }) => handleProxy(request)
  return {
    GET: any,
    POST: any,
    PUT: any,
    PATCH: any,
    DELETE: any,
    HEAD: any,
    OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
  }
}
