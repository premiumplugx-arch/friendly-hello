/** Legacy path kept working: /api/proxy behaves exactly like /api/public/proxy. */
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/lib/proxy-engine'

export const Route = createFileRoute('/api/proxy')({
  server: { handlers: proxyHandlers() },
})
