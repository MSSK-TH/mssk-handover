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
import { Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { toIntlLocale } from '@/i18n/languages'
import { cn } from '@/lib/utils'

import { PanelWrapper } from '../ui/panel-wrapper'
import { fetchCodexQuota } from './codex-quota-api'

function formatMoment(locale: string | undefined, value?: string): string {
  if (!value) return '-'
  const moment = new Date(value)
  if (Number.isNaN(moment.getTime())) return '-'
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(moment)
}

export function CodexQuotaPanel() {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language)
  const quotaQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'codex-quota'],
    queryFn: fetchCodexQuota,
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })

  const weekly = quotaQuery.data?.weekly ?? null
  const percentRaw = weekly ? Number(weekly.used_percent) : 0
  const usedPercent = Number.isFinite(percentRaw)
    ? Math.max(0, Math.min(100, percentRaw))
    : 0
  const remainingPercent = Math.max(0, 100 - usedPercent)

  return (
    <PanelWrapper
      title={
        <span className='flex items-center gap-2'>
          <Gauge className='size-4' aria-hidden='true' />
          {t('Subscription quota')}
        </span>
      }
      description={t(
        'Upstream Codex subscription usage. The percentage comes from the upstream weighted cost, not a plain token count.'
      )}
      loading={quotaQuery.isLoading}
      empty={!quotaQuery.isLoading && !weekly}
      emptyMessage={t('No subscription quota data')}
      headerActions={
        <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>
          {formatMoment(locale, quotaQuery.data?.updated_at)}
        </span>
      }
    >
      <div className='flex flex-col gap-3'>
        <div className='flex flex-wrap items-baseline justify-between gap-2'>
          <span className='text-sm font-medium'>{t('Weekly quota')}</span>
          <span className='font-mono text-lg font-semibold tabular-nums'>
            {usedPercent.toFixed(1)}%
          </span>
        </div>

        <div className='bg-muted h-2 overflow-hidden rounded-full'>
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500',
              quotaQuery.data?.limit_reached
                ? 'bg-destructive'
                : 'bg-primary'
            )}
            style={{ width: `${usedPercent}%` }}
          />
        </div>

        <div className='text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1 text-xs'>
          <span>
            {t('Remaining')}{' '}
            <span className='text-foreground font-medium tabular-nums'>
              {remainingPercent.toFixed(1)}%
            </span>
          </span>
          <span>
            {t('Resets at')}{' '}
            <span className='text-foreground font-medium tabular-nums'>
              {formatMoment(locale, weekly?.resets_at)}
            </span>
          </span>
          <span>
            {t('Plan')}{' '}
            <span className='text-foreground font-medium'>
              {quotaQuery.data?.plan ?? '-'}
            </span>
          </span>
          <span>
            {t('Reset credits available')}{' '}
            <span className='text-foreground font-medium tabular-nums'>
              {quotaQuery.data?.reset_credits ?? 0}
            </span>
          </span>
        </div>
      </div>
    </PanelWrapper>
  )
}
