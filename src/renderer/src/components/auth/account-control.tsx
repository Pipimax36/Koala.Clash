import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowUpRight,
  ExternalLink,
  LoaderCircle,
  LogOut,
  UserRound,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { useKoalaAuth } from '@renderer/hooks/use-koala-auth'
import AccountServices from './account-services'
import './account-control.css'

export default function AccountControl() {
  const { t } = useTranslation()
  const { state, loading, busy, restoring, openAccount, login, reopenLogin, logout, cancelLogin } =
    useKoalaAuth()
  const [open, setOpen] = useState(false)
  const previousStatus = useRef(state.status)
  const previousError = useRef(state.error)
  const accountButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const signedIn = state.status === 'signed-in'
  const signingIn = state.status === 'signing-in'
  const waiting = !signedIn && !state.error && (signingIn || busy)
  const accountName = state.user?.name || state.user?.email || t('auth.account')
  const label = signedIn ? accountName : t(signingIn ? 'auth.signingIn' : 'auth.signIn')

  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = state.status
    if (previous === 'signing-in' && state.status === 'signed-in') {
      setOpen(false)
      toast.success(t('auth.loginSuccess'))
    } else if (previous !== 'signed-out' && state.status === 'signed-out' && !state.error) {
      setOpen(false)
    }
  }, [state.status, state.error, t])

  useEffect(() => {
    if (state.error && state.error !== previousError.current && !open) {
      toast.error(t(`auth.errors.${state.error}`))
    }
    previousError.current = state.error
  }, [state.error, open, t])

  const showAccount = (): void => {
    if (loading || busy) return
    setOpen(true)
    void openAccount()
  }

  const title = restoring
    ? t('auth.accountTitle')
    : state.error
      ? t('auth.loginFailed')
      : t('auth.waitingTitle')
  const description = restoring
    ? t('auth.loading')
    : state.error
      ? t(`auth.errors.${state.error}`)
      : t('auth.waitingDescription')

  return (
    <div className="ui-sidebar-account">
      <button
        ref={accountButton}
        type="button"
        className="ui-nav-button"
        title={label}
        aria-label={signedIn ? t('auth.accountFor', { name: accountName }) : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-active={open}
        disabled={loading || busy}
        onClick={showAccount}
      >
        {loading || signingIn ? (
          <LoaderCircle className="animate-spin" aria-hidden />
        ) : (
          <UserRound aria-hidden />
        )}
        <span className="ui-account-label">
          <span>{label}</span>
          <span className="ui-account-caption">
            {t(loading ? 'auth.loading' : signedIn ? 'auth.signedIn' : 'auth.signedOut')}
          </span>
        </span>
      </button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent
            className={
              signedIn
                ? 'ui-auth-dialog ui-auth-dialog-account sm:max-w-[440px]'
                : 'ui-auth-dialog sm:max-w-[380px]'
            }
            showCloseButton={!signedIn}
            onEscapeKeyDown={() => {
              if (signedIn) setOpen(false)
            }}
            onInteractOutside={() => {
              if (signedIn) setOpen(false)
            }}
            onOpenAutoFocus={(event) => {
              if (signedIn) {
                event.preventDefault()
                closeButton.current?.focus()
              }
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              accountButton.current?.focus()
            }}
          >
            {signedIn && (
              <button
                ref={closeButton}
                type="button"
                className="ui-auth-dismiss"
                aria-label={t('common.close')}
                onClick={() => setOpen(false)}
              >
                <X aria-hidden />
              </button>
            )}
            {signedIn ? (
              <DialogHeader className="ui-account-header">
                <DialogTitle className="ui-account-title">{t('auth.accountTitle')}</DialogTitle>
                <DialogDescription className="sr-only">
                  {t('auth.accountFor', { name: accountName })}
                </DialogDescription>
              </DialogHeader>
            ) : (
              <DialogHeader className="ui-auth-header">
                <div
                  className="ui-auth-symbol"
                  data-state={state.error ? 'error' : 'waiting'}
                  aria-hidden
                >
                  {restoring ? <UserRound /> : state.error ? <AlertCircle /> : <ExternalLink />}
                </div>
                <span className="ui-auth-brand">COOLGO</span>
                <DialogTitle className="ui-auth-title">{title}</DialogTitle>
                <DialogDescription
                  className="ui-auth-description"
                  role={state.error ? 'alert' : undefined}
                >
                  {description}
                </DialogDescription>
              </DialogHeader>
            )}

            {signedIn ? (
              <div className="ui-auth-account">
                <div className="ui-auth-identity">
                  <p>{accountName}</p>
                  {state.user?.email && state.user.email !== accountName && (
                    <span>{state.user.email}</span>
                  )}
                </div>
              </div>
            ) : waiting ? (
              <div className="ui-auth-progress" role="status">
                <LoaderCircle className="animate-spin" aria-hidden />
                <span>
                  {t(restoring ? 'auth.loading' : busy ? 'auth.openingBrowser' : 'auth.waiting')}
                </span>
              </div>
            ) : null}

            {signedIn && <AccountServices key={state.user?.id} />}

            <DialogFooter className={signedIn ? 'ui-account-actions' : 'ui-auth-actions'}>
              {signedIn ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ui-account-signout"
                  disabled={busy}
                  onClick={() => {
                    setOpen(false)
                    void logout()
                  }}
                >
                  {busy ? (
                    <LoaderCircle className="animate-spin" aria-hidden />
                  ) : (
                    <LogOut aria-hidden />
                  )}
                  {t('auth.signOut')}
                </Button>
              ) : (
                <>
                  {signingIn ? (
                    <Button variant="ghost" disabled={busy} onClick={() => void cancelLogin()}>
                      {t('auth.cancelLogin')}
                    </Button>
                  ) : (
                    <DialogClose asChild>
                      <Button variant="ghost">{t('common.close')}</Button>
                    </DialogClose>
                  )}
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void (signingIn
                        ? reopenLogin()
                        : state.error === 'storage-error'
                          ? openAccount()
                          : login())
                    }
                  >
                    {busy ? (
                      <LoaderCircle className="animate-spin" aria-hidden />
                    ) : (
                      <ArrowUpRight aria-hidden />
                    )}
                    {t(signingIn ? 'auth.reopenBrowser' : 'auth.tryAgain')}
                  </Button>
                </>
              )}
            </DialogFooter>
            {!signedIn && !restoring && (
              <p className="ui-auth-footnote">
                {t(signingIn ? 'auth.waitingHint' : 'auth.providerHint')}
              </p>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
