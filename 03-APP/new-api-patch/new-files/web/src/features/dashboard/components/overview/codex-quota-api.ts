/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

export interface CodexQuotaWindow {
  kind: string
  used_percent: number
  reset_at?: number
  resets_at?: string
  reset_after_seconds?: number
}

export interface CodexQuotaFile {
  plan?: string
  account?: string
  updated_at?: string
  limit_reached?: boolean
  weekly?: CodexQuotaWindow | null
  reset_credits?: number
}

/** Reads the quota snapshot published next to the console build. */
export async function fetchCodexQuota(): Promise<CodexQuotaFile | null> {
  try {
    const res = await fetch(`/codex-quota.json?t=${Date.now()}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as CodexQuotaFile
  } catch {
    return null
  }
}
