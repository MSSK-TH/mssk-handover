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
import {
  Activity,
  Boxes,
  ChevronDown,
  ChevronRight,
  Coins,
  KeyRound,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import { fetchCodexQuota } from './codex-quota-api'
import {
  shareOf,
  USAGE_RANGES,
  useUsageTotals,
  type UsageRangeId,
} from './mssk-usage-data'
import { PanelWrapper } from '../ui/panel-wrapper'
import { StatCard } from '../ui/stat-card'

const MODEL_ROWS_LIMIT = 10

/** Compact token counts with one decimal, e.g. 23.1娴?/ 1.2B. */
function compact(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

export function UsageRangeSwitch(props: {
  value: UsageRangeId
  onChange: (next: UsageRangeId) => void
}) {
  const { t } = useTranslation()

  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {USAGE_RANGES.map((item) => (
        <Button
          key={item.id}
          size='sm'
          variant={item.id === props.value ? 'default' : 'outline'}
          className='h-7 px-2.5 text-xs'
          onClick={() => props.onChange(item.id)}
        >
          {t(item.label)}
        </Button>
      ))}
    </div>
  )
}

export function MsskUsageOverview(props: {
  rangeId: UsageRangeId
  onRangeChange: (next: UsageRangeId) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language)
  const { totals, isLoading, isError } = useUsageTotals(props.rangeId)
  const range =
    USAGE_RANGES.find((item) => item.id === props.rangeId) ?? USAGE_RANGES[2]
  const rangeLabel = t(range.label)

  const cards = [
    {
      key: 'tokens',
      title: t('Tokens ({{range}})', { range: rangeLabel }),
      value: compact(totals.tokens, locale),
      description: t('Prompt and completion tokens'),
      icon: Coins,
      tone: 'accent-1' as const,
    },
    {
      key: 'requests',
      title: t('Requests ({{range}})', { range: rangeLabel }),
      value: formatNumber(totals.requests, locale),
      description: t('Counted per API call'),
      icon: Activity,
      tone: 'accent-2' as const,
    },
    {
      key: 'models',
      title: t('Active models ({{range}})', { range: rangeLabel }),
      value: formatNumber(totals.models, locale),
      description: t('Models with recorded usage'),
      icon: Boxes,
      tone: 'accent-3' as const,
    },
    {
      key: 'keys',
      title: t('Active API keys'),
      value: formatNumber(totals.keys.length, locale),
      description: t('Keys with usage in this range'),
      icon: KeyRound,
      tone: 'accent-1' as const,
    },
  ]

  return (
    <PanelWrapper
      title={t('Usage overview')}
      description={t('Monitor tokens, requests and active models')}
      headerActions={
        <UsageRangeSwitch value={props.rangeId} onChange={props.onRangeChange} />
      }
    >
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        {cards.map((card) => (
          <div
            key={card.key}
            className='bg-card rounded-2xl border p-4 shadow-xs'
          >
            <StatCard
              title={card.title}
              value={card.value}
              description={card.description}
              icon={card.icon}
              tone={card.tone}
              loading={isLoading}
              error={isError}
            />
          </div>
        ))}
      </div>
    </PanelWrapper>
  )
}

export function MsskApiUsageTable(props: { rangeId: UsageRangeId }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language)
  const { totals, isLoading } = useUsageTotals(props.rangeId)
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])

  const quotaQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'codex-quota'],
    queryFn: fetchCodexQuota,
    staleTime: 60 * 1000,
  })

  const weeklyUsedPercentRaw = Number(quotaQuery.data?.weekly?.used_percent)
  const weeklyUsedPercent = Number.isFinite(weeklyUsedPercentRaw)
    ? Math.max(0, Math.min(100, weeklyUsedPercentRaw))
    : null

  const toggleKey = (key: string) => {
    setExpandedKeys((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    )
  }

  return (
    <PanelWrapper
      title={t('Usage by API key')}
      description={`${t('Click a key row to see which models consumed it')} 璺?mssk-v6`}
      loading={isLoading}
      empty={!isLoading && totals.keys.length === 0}
      emptyMessage={t('No usage recorded in this range')}
      contentClassName='p-0 sm:p-0'
      headerActions={
        <span className='text-muted-foreground hidden shrink-0 text-xs sm:block'>
          {t('Weighted spend in quota units')}
        </span>
      }
    >
      <div className='overflow-x-auto'>
        <table className='w-full min-w-[46rem] text-sm'>
          <thead className='text-muted-foreground border-b text-xs'>
            <tr>
              <th className='px-4 py-2.5 text-left font-medium'>
                {t('API key')}
              </th>
              <th className='px-3 py-2.5 text-right font-medium'>
                {t('Token')}
              </th>
              <th className='px-3 py-2.5 text-right font-medium'>
                {t('Weighted spend')}
              </th>
              <th className='px-3 py-2.5 text-right font-medium'>
                {t('Usage share')}
              </th>
              <th className='px-3 py-2.5 text-right font-medium'>
                {t('Share of weekly quota')}
              </th>
              <th className='px-3 py-2.5 text-right font-medium'>
                {t('Requests')}
              </th>
              <th className='px-4 py-2.5 text-right font-medium'>
                {t('Models')}
              </th>
            </tr>
          </thead>
          <tbody>
            {totals.keys.map((row) => {
              const expanded = expandedKeys.includes(row.name)
              const quotaShare = shareOf(row.quota, totals.quota)
              const weeklyShare =
                weeklyUsedPercent === null
                  ? null
                  : (quotaShare / 100) * weeklyUsedPercent
              return [
                <tr
                  key={row.name}
                  className='hover:bg-muted/40 cursor-pointer border-b'
                  onClick={() => toggleKey(row.name)}
                >
                  <td className='px-4 py-2.5'>
                    <span className='flex items-center gap-1.5'>
                      {expanded ? (
                        <ChevronDown
                          className='text-muted-foreground size-3.5 shrink-0'
                          aria-hidden='true'
                        />
                      ) : (
                        <ChevronRight
                          className='text-muted-foreground size-3.5 shrink-0'
                          aria-hidden='true'
                        />
                      )}
                      <span className='max-w-[16rem] truncate font-medium'>
                        {row.name}
                      </span>
                    </span>
                  </td>
                  <td className='px-3 py-2.5 text-right tabular-nums'>
                    {compact(row.tokens, locale)}
                  </td>
                  <td className='px-3 py-2.5 text-right tabular-nums'>
                    {compact(row.quota, locale)}
                  </td>
                  <td className='px-3 py-2.5 text-right tabular-nums'>
                    {quotaShare.toFixed(1)}%
                  </td>
                  <td className='px-3 py-2.5 text-right tabular-nums'>
                    {weeklyShare === null ? '-' : `${weeklyShare.toFixed(1)}%`}
                  </td>
                  <td className='px-3 py-2.5 text-right tabular-nums'>
                    {formatNumber(row.requests, locale)}
                  </td>
                  <td className='px-4 py-2.5 text-right tabular-nums'>
                    {row.models.length}
                  </td>
                </tr>,
                expanded ? (
                  <tr key={`${row.name}-models`} className='bg-muted/30 border-b'>
                    <td colSpan={7} className='px-4 py-3'>
                      <div className='flex flex-col gap-2'>
                        <div className='text-muted-foreground text-xs'>
                          {t('Model breakdown for this key')}
                        </div>
                        {row.models.map((model) => {
                          const modelShare = shareOf(model.tokens, row.tokens)
                          return (
                            <div
                              key={`${row.name}-${model.name}`}
                              className='flex items-center gap-3'
                            >
                              <span className='w-44 shrink-0 truncate font-mono text-xs'>
                                {model.name}
                              </span>
                              <div className='bg-muted h-2 min-w-24 flex-1 overflow-hidden rounded-full'>
                                <div
                                  className='bg-primary h-full rounded-full'
                                  style={{
                                    width: `${Math.min(100, modelShare)}%`,
                                  }}
                                />
                              </div>
                              <span className='w-14 shrink-0 text-right text-xs tabular-nums'>
                                {modelShare.toFixed(1)}%
                              </span>
                              <span className='text-muted-foreground w-20 shrink-0 text-right text-xs tabular-nums'>
                                {compact(model.tokens, locale)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </td>
                  </tr>
                ) : null,
              ]
            })}
          </tbody>
        </table>
      </div>
      <div className='text-muted-foreground border-t px-4 py-2.5 text-xs'>
        {t(
          'Aggregated from usage logs through the official flow endpoint. Balance, top-up and wallet are hidden for this internal deployment.'
        )}
      </div>
    </PanelWrapper>
  )
}

export function MsskModelUsagePanel(props: { rangeId: UsageRangeId }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language)
  const { totals, isLoading } = useUsageTotals(props.rangeId)

  return (
    <PanelWrapper
      title={t('Usage by model')}
      description={t('Each model as a share of total tokens')}
      loading={isLoading}
      empty={!isLoading && totals.tokensByModel.length === 0}
      emptyMessage={t('No usage recorded in this range')}
    >
      <div className='flex flex-col gap-2'>
        <div className='text-muted-foreground flex items-center gap-3 text-xs'>
          <span className='w-44 shrink-0'>{t('Model')}</span>
          <span className='flex-1'>{t('Usage share')}</span>
          <span className='w-14 shrink-0 text-right'>{t('Percent')}</span>
          <span className='hidden w-20 shrink-0 text-right sm:block'>
            {t('Requests')}
          </span>
        </div>
        {totals.tokensByModel.slice(0, MODEL_ROWS_LIMIT).map((model) => {
          const modelShare = shareOf(model.tokens, totals.tokens)
          return (
            <div key={model.name} className='flex items-center gap-3'>
              <span
                className='w-44 shrink-0 truncate font-mono text-xs'
                title={model.name}
              >
                {model.name}
              </span>
              <div className='bg-muted h-2 min-w-24 flex-1 overflow-hidden rounded-full'>
                <div
                  className={cn('bg-primary h-full rounded-full')}
                  style={{ width: `${Math.min(100, modelShare)}%` }}
                />
              </div>
              <span className='w-14 shrink-0 text-right text-xs font-medium tabular-nums'>
                {modelShare.toFixed(1)}%
              </span>
              <span className='text-muted-foreground hidden w-20 shrink-0 text-right text-xs tabular-nums sm:block'>
                {formatNumber(model.requests, locale)}
              </span>
            </div>
          )
        })}
      </div>
    </PanelWrapper>
  )
}
