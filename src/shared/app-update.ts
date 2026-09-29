import { repository } from './release-source.json'

export const appRepositoryUrl = `https://github.com/${repository}`
export const appReleasesApi = `https://api.github.com/repos/${repository}/releases`

export function appReleaseUrl(tag: string): string {
  return `${appRepositoryUrl}/releases/tag/${encodeURIComponent(tag)}`
}
