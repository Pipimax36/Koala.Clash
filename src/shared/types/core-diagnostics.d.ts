type CoreStartupIssue = {
  reason: 'tun-route-conflict' | 'tun-permission-denied' | 'tun-start-failed' | 'port-in-use'
  port?: number
}

interface CoreDiagnosticsSnapshot {
  cursor: number
  issues: CoreStartupIssue[]
}
