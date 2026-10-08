import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { calcTraffic } from '@renderer/utils/calc'
import dayjs from 'dayjs'
import React, { useMemo, useState } from 'react'
import EditFileModal from './edit-file-modal'
import EditRulesModal from './edit-rules-modal'
import EditInfoModal from './edit-info-modal'
import { openFile } from '@renderer/utils/ipc'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import {
  EllipsisVertical,
  ExternalLink,
  FileText,
  FolderOpen,
  HeadsetIcon,
  Layers3,
  ListTree,
  Pencil,
  RefreshCcw,
  Settings2,
  ChevronRight,
  Trash2
} from 'lucide-react'

interface Props {
  info: ProfileItem
  isCurrent: boolean
  addProfileItem: (item: Partial<ProfileItem>) => Promise<void>
  updateProfileItem: (item: ProfileItem) => Promise<void>
  removeProfileItem: (id: string) => Promise<void>
  onClick: () => Promise<void>
  switching: boolean
}

interface MenuItem {
  key: string
  label: string
  icon: React.ReactNode
  showDivider: boolean
  variant: 'default' | 'destructive'
}

const ProfileItem: React.FC<Props> = (props) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    info,
    addProfileItem,
    removeProfileItem,
    updateProfileItem,
    onClick,
    isCurrent,
    switching
  } = props
  const extra = info?.extra
  const usage = (extra?.upload ?? 0) + (extra?.download ?? 0)
  const total = extra?.total ?? 0
  const [updating, setUpdating] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [openInfoEditor, setOpenInfoEditor] = useState(false)
  const [openFileEditor, setOpenFileEditor] = useState(false)
  const [openRulesEditor, setOpenRulesEditor] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const updatedFromNow = info.updated ? dayjs(info.updated).fromNow() : t('redesign.notProvided')

  const hasLimit = total > 0
  const expired = extra?.expire ? dayjs.unix(extra.expire).isBefore(dayjs()) : false

  const daysRemaining = useMemo(() => {
    if (info.type !== 'remote' || !extra) return null
    if (!extra.expire) return null
    if (expired) return '0'
    const days = Math.ceil(dayjs.unix(extra.expire).diff(dayjs(), 'day', true))
    return days.toString()
  }, [info.type, extra, expired])

  const intervalLabel = useMemo(() => {
    if (!info.interval || info.interval <= 0) return null
    const hours = Math.floor(info.interval / 60)
    if (hours >= 24) {
      const days = Math.floor(hours / 24)
      return `${days}${t('profile.dayShort')}`
    }
    if (hours > 0) return `${hours}${t('profile.hourShort')}`
    return `${info.interval}${t('profile.minuteShort')}`
  }, [info.interval, t])

  const menuItems: MenuItem[] = useMemo(() => {
    const list: MenuItem[] = []
    list.push({
      key: 'nodes',
      label: t('redesign.nodes'),
      icon: <ChevronRight />,
      showDivider: false,
      variant: 'default'
    })
    if (info.home) {
      list.push({
        key: 'home',
        label: t('profile.homepage'),
        icon: <ExternalLink />,
        showDivider: false,
        variant: 'default'
      })
    }
    if (info.supportUrl) {
      list.push({
        key: 'support',
        label: t('profile.support'),
        icon: <HeadsetIcon />,
        showDivider: false,
        variant: 'default'
      })
    }
    list.push(
      {
        key: 'edit-info',
        label: t('profile.editInfo'),
        icon: <Pencil />,
        showDivider: false,
        variant: 'default'
      },
      {
        key: 'edit-file',
        label: t('profile.editFile'),
        icon: <FileText />,
        showDivider: false,
        variant: 'default'
      },
      {
        key: 'edit-rules',
        label: t('profile.editRule'),
        icon: <ListTree />,
        showDivider: false,
        variant: 'default'
      },
      {
        key: 'open-file',
        label: t('profile.openFile'),
        icon: <FolderOpen />,
        showDivider: true,
        variant: 'default'
      },
      {
        key: 'delete',
        label: t('profile.delete'),
        icon: <Trash2 />,
        showDivider: false,
        variant: 'destructive'
      }
    )
    return list
  }, [info, t])

  const onMenuAction = async (key: string): Promise<void> => {
    switch (key) {
      case 'update': {
        setUpdating(true)
        try {
          await addProfileItem(info)
        } finally {
          setUpdating(false)
        }
        break
      }
      case 'nodes': {
        navigate('/proxies', { state: { profileId: info.id } })
        break
      }
      case 'edit-info': {
        setOpenInfoEditor(true)
        break
      }
      case 'edit-file': {
        setOpenFileEditor(true)
        break
      }
      case 'edit-rules': {
        setOpenRulesEditor(true)
        break
      }
      case 'open-file': {
        openFile(info.id)
        break
      }
      case 'delete': {
        setConfirmOpen(true)
        break
      }
      case 'home': {
        open(info.home)
        break
      }
      case 'support': {
        open(info.supportUrl)
        break
      }
    }
  }

  const handleSelect = (): void => {
    if (switching) return
    setSelecting(true)
    onClick()
      .catch((error) => toast.error(String(error)))
      .finally(() => setSelecting(false))
  }

  return (
    <div className="koala-profile-detail">
      {openFileEditor && <EditFileModal id={info.id} onClose={() => setOpenFileEditor(false)} />}
      {openRulesEditor && <EditRulesModal id={info.id} onClose={() => setOpenRulesEditor(false)} />}
      {openInfoEditor && (
        <EditInfoModal
          item={info}
          isCurrent={isCurrent}
          onClose={() => setOpenInfoEditor(false)}
          updateProfileItem={updateProfileItem}
        />
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 className="size-8 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('profile.confirmDeleteProfile')}</AlertDialogTitle>
            <AlertDialogDescription className="truncate max-w-3xs">
              {info.name}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setTimeout(() => removeProfileItem(info.id), 200)
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div
        data-current={isCurrent}
        aria-busy={selecting || switching}
        className={cn('ui-panel koala-profile-detail-panel', switching && 'cursor-wait')}
      >
        <div className="koala-profile-detail-top">
          {info.logo ? (
            <img
              src={info.logo}
              alt=""
              className="koala-profile-detail-icon"
              onError={(event) => {
                ;(event.target as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            <Layers3 className="koala-profile-detail-icon" aria-hidden="true" />
          )}
          <span className="koala-profile-status" data-active={isCurrent}>
            {t(isCurrent ? 'redesign.currentUse' : 'redesign.notActive')}
          </span>
        </div>
        <div className="koala-profile-detail-identity">
          <h2 title={info.name} className="koala-profile-detail-title">
            {info.name}
          </h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="koala-profile-menu-trigger"
                aria-label={t('redesign.moreSettings')}
              >
                <EllipsisVertical aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menuItems.map((item) => (
                <React.Fragment key={item.key}>
                  <DropdownMenuItem variant={item.variant} onClick={() => onMenuAction(item.key)}>
                    {item.icon}
                    {item.label}
                  </DropdownMenuItem>
                  {item.showDivider && <DropdownMenuSeparator />}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p className="koala-profile-detail-subtitle">
          {info.homeName ||
            t(info.type === 'remote' ? 'redesign.remoteProfileLabel' : 'profile.localProfileLabel')}
        </p>

        <div className="koala-profile-quota">
          <p>{t('profile.trafficRemaining')}</p>
          <div className="koala-profile-quota-value">
            <strong>
              {hasLimit ? calcTraffic(Math.max(0, total - usage)) : t('redesign.notProvided')}
            </strong>
            {hasLimit && <small>/ {calcTraffic(total)}</small>}
          </div>
          {hasLimit && (
            <div
              className="koala-profile-quota-track"
              role="progressbar"
              aria-label={t('profile.trafficRemaining')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.max(
                0,
                Math.min(100, Math.round(((total - usage) / total) * 100))
              )}
            >
              <div
                style={{ width: `${Math.max(0, Math.min(100, ((total - usage) / total) * 100))}%` }}
              />
            </div>
          )}
          <div className="koala-profile-usage">
            <span>
              {t('redesign.usedTraffic')} {extra ? calcTraffic(usage) : t('redesign.notProvided')}
            </span>
            <span>
              {daysRemaining !== null
                ? t('redesign.remainingDays', { count: Number(daysRemaining) })
                : t('profile.longTermValid')}
            </span>
          </div>
        </div>
        <div className="koala-profile-summary">
          <div>
            <span>{t('redesign.lastUpdated')}</span>
            <span>{updatedFromNow}</span>
          </div>
          {info.type === 'remote' && (
            <div>
              <span>{t('redesign.autoUpdate')}</span>
              <span>
                {info.autoUpdate
                  ? intervalLabel || t('redesign.autoUpdate')
                  : t('redesign.manualUpdate')}
              </span>
            </div>
          )}
        </div>
        <div className="koala-profile-actions">
          {!isCurrent && (
            <Button
              size="sm"
              variant="default"
              disabled={switching || selecting}
              aria-busy={selecting}
              onClick={handleSelect}
            >
              {selecting ? <Spinner aria-hidden="true" /> : <Settings2 aria-hidden="true" />}
              {t('redesign.setCurrent')}
            </Button>
          )}
          {info.type === 'remote' && (
            <Button
              size="sm"
              variant="outline"
              disabled={updating}
              onClick={() => void onMenuAction('update')}
            >
              <RefreshCcw className={cn(updating && 'animate-spin')} aria-hidden="true" />
              {t('profile.updateSubscription')}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setOpenFileEditor(true)}>
            <FileText aria-hidden="true" />
            {t('profile.editFile')}
          </Button>
          {isCurrent && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate('/proxies', { state: { profileId: info.id } })}
            >
              {t('redesign.nodes')}
              <ChevronRight aria-hidden="true" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 aria-hidden="true" />
            {t('profile.delete')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default ProfileItem
