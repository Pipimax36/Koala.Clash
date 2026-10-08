import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useAccountServices } from '@renderer/hooks/use-account-services'

export default function AccountServices() {
  const { t, i18n } = useTranslation()
  const { state, importing, importErrors, refresh, importService } = useAccountServices()
  const headingId = useId()

  const dueDate = (value: string): string | undefined => {
    // Date-only billing values must not move to the previous day in western time zones.
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match || value.startsWith('0000')) return undefined
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (
      date.getFullYear() !== Number(match[1]) ||
      date.getMonth() !== Number(match[2]) - 1 ||
      date.getDate() !== Number(match[3])
    )
      return undefined
    return date.toLocaleDateString(i18n.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  return (
    <section
      className="ui-account-services"
      aria-labelledby={headingId}
      aria-busy={state.status === 'loading'}
    >
      <div className="ui-account-services-heading">
        <h3 id={headingId}>{t('auth.services.title')}</h3>
      </div>

      {state.status === 'loading' ? (
        <div className="ui-account-services-message" role="status">
          <LoaderCircle className="animate-spin" aria-hidden />
          <p>{t('auth.services.loading')}</p>
        </div>
      ) : state.status === 'error' ? (
        <div className="ui-account-services-message" role="alert">
          <AlertCircle aria-hidden />
          <p>{t(`auth.services.errors.${state.error}`)}</p>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw aria-hidden />
            {t('auth.services.retry')}
          </Button>
        </div>
      ) : state.services.length === 0 ? (
        <div className="ui-account-services-message" role="status">
          <p>{t('auth.services.empty')}</p>
        </div>
      ) : (
        <ul className="ui-account-services-list" tabIndex={0} aria-label={t('auth.services.title')}>
          {state.services.map((service) => {
            const working = importing.includes(service.id)
            const date = service.nextDueDate && dueDate(service.nextDueDate)
            const error = importErrors[service.id]
            return (
              <li key={service.id} className="ui-account-service" data-active={service.active}>
                <div className="ui-account-service-row">
                  <div className="ui-account-service-details">
                    <p className="ui-account-service-name">{service.name}</p>
                    {date && (
                      <span className="ui-account-service-meta">
                        {t('auth.services.nextDueDate', { date })}
                      </span>
                    )}
                  </div>
                  <Button
                    variant={service.active ? 'ghost' : 'outline'}
                    size="sm"
                    disabled={working || service.active}
                    aria-label={t(
                      service.active
                        ? 'auth.services.activeName'
                        : service.imported
                          ? 'auth.services.activateName'
                          : 'auth.services.importName',
                      { name: service.name }
                    )}
                    onClick={() => void importService(service.id)}
                  >
                    {working ? (
                      <LoaderCircle className="animate-spin" aria-hidden />
                    ) : service.active ? (
                      <Check aria-hidden />
                    ) : null}
                    {t(
                      working
                        ? service.imported
                          ? 'auth.services.activating'
                          : 'auth.services.importing'
                        : service.active
                          ? 'auth.services.active'
                          : service.imported
                            ? 'auth.services.activate'
                            : 'auth.services.import'
                    )}
                  </Button>
                </div>
                {error && (
                  <p className="ui-account-service-error" role="alert">
                    {t(`auth.services.errors.${error}`)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
