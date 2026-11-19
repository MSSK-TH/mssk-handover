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
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { getFlowQuotaDates } from '@/features/dashboard/api'
import type { FlowQuotaDataItem } from '@/features/dashboard/types'
import { requireServerSuccess } from '@/lib/server-error-message'

export const USAGE_RANGES = [
  { id: 'today', days: 1, label: 'Today' },
  { id: '3d', days: 3, label: 'Last 3 days' },
  { id: '7d', days: 7, label: 'Last 7 days' },
  { id: '30d', days: 30, label: 'Last 30 days' },
] as const

export type UsageRangeId = (typeof USAGE_RANGES)[number]['id']

export const DEFAULT_USAGE_RANGE: UsageRangeId = '7d'

export interface ModelShare {
  name: string
  tokens: number
  quota: number
  requests: number
}

export interface KeyUsageRow {
  id: number
  name: string
  tokens: number
  quota: number
  requests: number
  models: ModelShare[]
}

export interface UsageTotals {
  tokens: number
  quota: number
  requests: number
  models: number
  keys: KeyUsageRow[]
  tokensByModel: ModelShare[]
}

export function shareOf(part: number, total: number): number {
  if (total <= 0) return 0
  return (part / total) * 100
}

function buildUsageTotals(
  rows: FlowQuotaDataItem[],
  deletedLabel: (tokenId: number) => string
): UsageTotals {
  const byKey = new Map<string, KeyUsageRow>()
  const byModel = new Map<string, ModelShare>()

  for (const row of rows) {
    const tokens = Number(row.token_used) || 0
    const quota = Number(row.quota) || 0
    const requests = Number(row.count) || 0
    if (tokens <= 0 && quota <= 0 && requests <= 0) continue

    const tokenId = Number(row.token_id) || 0
    const keyName = row.token_name?.trim() || deletedLabel(tokenId)
    const modelName = row.model_name?.trim() || '-'

    const keyEntry = byKey.get(keyName) ?? {
      id: tokenId,
      name: keyName,
      tokens: 0,
      quota: 0,
      requests: 0,
      models: [],
    }
    keyEntry.tokens += tokens
    keyEntry.quota += quota
    keyEntry.requests += requests
    const keyModel = keyEntry.models.find((item) => item.name === modelName)
    if (keyModel) {
      keyModel.tokens += tokens
      keyModel.quota += quota
      keyModel.requests += requests
    } else {
      keyEntry.models.push({ name: modelName, tokens, quota, requests })
    }
    byKey.set(keyName, keyEntry)

    const modelEntry = byModel.get(modelName) ?? {
      name: modelName,
      tokens: 0,
      quota: 0,
      requests: 0,
    }
    modelEntry.tokens += tokens
    modelEntry.quota += quota
    modelEntry.requests += requests
    byModel.set(modelName, modelEntry)
  }

  const keys = [...byKey.values()]
    .map((entry) => ({
      ...entry,
      models: entry.models.sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.quota - a.quota || b.tokens - a.tokens)

  const tokensByModel = [...byModel.values()].sort(
    (a, b) => b.tokens - a.tokens
  )

  return {
    tokens: keys.reduce((total, entry) => total + entry.tokens, 0),
    quota: keys.reduce((total, entry) => total + entry.quota, 0),
    requests: keys.reduce((total, entry) => total + entry.requests, 0),
    models: tokensByModel.length,
    keys,
    tokensByModel,
  }
}

/** Shared flow/self query so the overview panels fetch a range only once. */
export function useUsageTotals(rangeId: UsageRangeId): {
  totals: UsageTotals
  isLoading: boolean
  isError: boolean
} {
  const { t } = useTranslation()
  const range =
    USAGE_RANGES.find((item) => item.id === rangeId) ?? USAGE_RANGES[2]

  const flowQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'mssk-usage', rangeId],
    queryFn: async () => {
      const end = Math.floor(Date.now() / 1000)
      const res = await getFlowQuotaDates({
        start_timestamp: end - range.days * 86400,
        end_timestamp: end,
      })
      requireServerSuccess(res)
      return res.data ?? []
    },
    staleTime: 60 * 1000,
  })

  const deletedLabel = useMemo(
    () => (tokenId: number) => t('Deleted ({{id}})', { id: tokenId }),
    [t]
  )

  const totals = useMemo<UsageTotals>(
    () =>
      flowQuery.data
        ? buildUsageTotals(flowQuery.data, deletedLabel)
        : {
            tokens: 0,
            quota: 0,
            requests: 0,
            models: 0,
            keys: [],
            tokensByModel: [],
          },
    [deletedLabel, flowQuery.data]
  )

  return {
    totals,
    isLoading: flowQuery.isLoading,
    isError: flowQuery.isError,
  }
}
