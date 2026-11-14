/**
 * Public proxy endpoint — /api/public/proxy?u=<encoded url>
 *
 * Lives under /api/public/ so external players and published sites can reach
 * it without site auth. Abuse control is inside the engine: private/loopback
 * targets are refused, PROXY_ALLOWED_HOSTS can pin an allowlist, and PROXY_KEY
 * can require ?key= on every request.
 */
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/lib/proxy-engine'

export const Route = createFileRoute('/api/public/proxy')({
  server: { handlers: proxyHandlers() },
})
