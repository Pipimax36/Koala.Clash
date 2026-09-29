import { getAppConfig } from '../config'
import { mihomoVersion } from '../core/mihomoApi'
import { version } from '../../../package.json'

export async function getUserAgent(): Promise<string> {
  const { userAgent } = await getAppConfig()
  if (userAgent) {
    return userAgent
  }

  // Subscription servers use this token to select Mihomo's protocol set.
  // A plain "koala-clash" token can select legacy Clash and omit AnyTLS.
  try {
    const runtime = await mihomoVersion()
    const coreVersion = runtime.version.match(/^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/)?.[1]
    if (coreVersion) return `clash.meta/${coreVersion} koala-clash/${version}`
  } catch {
    // Subscription imports must also work while the core is unavailable.
  }

  // Do not let a subscription server mistake the app version for the core version.
  return 'clash.meta (koala-clash)'
}
