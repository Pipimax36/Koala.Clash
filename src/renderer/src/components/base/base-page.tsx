import { Button } from '@renderer/components/ui/button'
import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { ChevronLeft } from 'lucide-react'

const sidebarPaths = new Set([
  '/home',
  '/profiles',
  '/proxies',
  '/connections',
  '/rules',
  '/logs',
  '/mihomo',
  '/settings'
])

interface Props {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  header?: React.ReactNode
  children?: React.ReactNode
  contentClassName?: string
  showBackButton?: boolean
}

const BasePage = forwardRef<HTMLDivElement, Props>((props, ref) => {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const isSubPage = !sidebarPaths.has(location.pathname)

  const contentRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => {
    return contentRef.current as HTMLDivElement
  })

  return (
    <div ref={contentRef} className="ui-base-page flex h-full w-full min-h-0 flex-col">
      <div className="ui-page-header">
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="title flex min-w-0 items-center gap-2">
              {(isSubPage || props.showBackButton) && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="app-nodrag"
                  aria-label={t('redesign.back')}
                  onClick={() => navigate(-1)}
                >
                  <ChevronLeft className="size-5" />
                </Button>
              )}
              <h1>{props.title}</h1>
            </div>
            {props.subtitle && <p className="ui-page-subtitle">{props.subtitle}</p>}
          </div>
          <div className="header app-nodrag flex flex-wrap items-center gap-2">{props.header}</div>
        </div>
      </div>
      <div
        className={cn(
          'content ui-page min-h-0 flex-1 overflow-y-auto custom-scrollbar',
          props.contentClassName
        )}
      >
        {props.children}
      </div>
    </div>
  )
})

BasePage.displayName = 'BasePage'
export default BasePage
