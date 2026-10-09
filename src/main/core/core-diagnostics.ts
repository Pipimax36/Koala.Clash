export function parseCoreStartupIssue(line: string): CoreStartupIssue | undefined {
  if (/\bbatch read packet:\s*bad file descriptor\b/i.test(line)) {
    return { reason: 'tun-read-failed' }
  }
  if (line.includes('Start TUN listening error:')) {
    if (/add route:.*(?:file exists|already exists)/i.test(line)) {
      return { reason: 'tun-route-conflict' }
    }
    if (/operation not permitted|permission denied/i.test(line)) {
      return { reason: 'tun-permission-denied' }
    }
    return { reason: 'tun-start-failed' }
  }
  if (
    /Start .*server error:.*(?:address already in use|Only one usage of each socket address)/i.test(
      line
    )
  ) {
    const port = line.match(/:(\d+):?\s+(?:bind|listen)/i)?.[1]
    return { reason: 'port-in-use', ...(port ? { port: Number(port) } : {}) }
  }
  return undefined
}

export function createCoreDiagnostics() {
  let cursor = 0
  const entries: { cursor: number; issue: CoreStartupIssue }[] = []
  const buffers = { stdout: '', stderr: '' }
  return {
    push(chunk: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
      const lines = (buffers[stream] + chunk).split('\n')
      buffers[stream] = (lines.pop() ?? '').slice(-8192)
      for (const line of lines) {
        const issue = parseCoreStartupIssue(line)
        if (!issue) continue
        entries.push({ cursor: ++cursor, issue })
        if (entries.length > 32) entries.shift()
      }
    },
    resetBuffers(): void {
      buffers.stdout = ''
      buffers.stderr = ''
    },
    read(after = cursor): CoreDiagnosticsSnapshot {
      const unique = new Map<string, CoreStartupIssue>()
      for (const entry of entries) {
        if (entry.cursor > after) unique.set(JSON.stringify(entry.issue), entry.issue)
      }
      return { cursor, issues: [...unique.values()] }
    }
  }
}

export const coreDiagnostics = createCoreDiagnostics()
