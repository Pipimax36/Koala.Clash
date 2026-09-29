import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import BasePage from '@renderer/components/base/base-page'
import ProfileItem from '@renderer/components/profiles/profile-item'
import ProfileSourceItem from '@renderer/components/profiles/profile-source-item'
import EditInfoModal from '@renderer/components/profiles/edit-info-modal'
import ProfileUpdateIntervalSelect from '@renderer/components/profiles/profile-update-interval-select'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { getProfileConfig, readTextFile } from '@renderer/utils/ipc'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useTranslation } from 'react-i18next'
import { Plus, FileDown, RefreshCcw, Ellipsis } from 'lucide-react'
import '@renderer/components/profiles/profiles-page.css'

const emptyItems: ProfileItem[] = []

function isValidSubscriptionUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const Profiles: React.FC = () => {
  const { t } = useTranslation()
  const {
    profileConfig,
    setProfileConfig,
    addProfileItem,
    updateProfileItem,
    removeProfileItem,
    changeCurrentProfile
  } = useProfileConfig()
  const { current, items } = profileConfig || {}
  const itemsArray = items ?? emptyItems
  const [sortedItems, setSortedItems] = useState(itemsArray)
  const [inspectedId, setInspectedId] = useState('')
  const [updating, setUpdating] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingItem, setEditingItem] = useState<ProfileItem | null>(null)
  const [showInlineForm, setShowInlineForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newUpdateInterval, setNewUpdateInterval] = useState<number | null>(24 * 60)
  const [urlTouched, setUrlTouched] = useState(false)
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const [formError, setFormError] = useState('')
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 2
      }
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const pageRef = useRef<HTMLDivElement>(null)
  const dragCounterRef = useRef(0)
  const addProfileItemRef = useRef(addProfileItem)
  addProfileItemRef.current = addProfileItem
  const tRef = useRef(t)
  tRef.current = t

  const onDragEnd = async (event: DragEndEvent): Promise<void> => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const activeIndex = sortedItems.findIndex((item) => item.id === active.id)
    const overIndex = sortedItems.findIndex((item) => item.id === over.id)
    if (activeIndex < 0 || overIndex < 0) return
    const newOrder = arrayMove(sortedItems, activeIndex, overIndex)
    setSortedItems(newOrder)
    await setProfileConfig({ current, items: newOrder })
  }

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) {
      setFileOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setFileOver(false)
    }
  }, [])

  const handleDrop = useCallback(async (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounterRef.current = 0
    setFileOver(false)
    if (event.dataTransfer?.files) {
      const file = event.dataTransfer.files[0]
      if (
        file.name.endsWith('.yml') ||
        file.name.endsWith('.yaml') ||
        file.name.endsWith('.json') ||
        file.name.endsWith('.jsonc') ||
        file.name.endsWith('.json5') ||
        file.name.endsWith('.txt')
      ) {
        try {
          const path = window.api.webUtils.getPathForFile(file)
          const content = await readTextFile(path)
          await addProfileItemRef.current({ name: file.name, type: 'local', file: content })
        } catch (e) {
          toast.error(tRef.current('pages.profiles.fileImportFailed') + e)
        }
      } else {
        toast.error(tRef.current('pages.profiles.unsupportedFileType'))
      }
    }
  }, [])

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    el.addEventListener('dragover', handleDragOver)
    el.addEventListener('dragenter', handleDragEnter)
    el.addEventListener('dragleave', handleDragLeave)
    el.addEventListener('drop', handleDrop)
    return (): void => {
      el.removeEventListener('dragover', handleDragOver)
      el.removeEventListener('dragenter', handleDragEnter)
      el.removeEventListener('dragleave', handleDragLeave)
      el.removeEventListener('drop', handleDrop)
    }
  }, [handleDragOver, handleDragEnter, handleDragLeave, handleDrop])

  useEffect(() => {
    setSortedItems(itemsArray)
  }, [itemsArray])

  const handleAdvancedCreate = (): void => {
    if (creatingRef.current) return
    setShowInlineForm(false)
    const newProfile: ProfileItem = {
      id: '',
      name: '',
      type: 'remote',
      url: '',
      useProxy: false,
      autoUpdate: true,
      interval: 24 * 60
    }
    setEditingItem(newProfile)
    setShowEditModal(true)
  }
  const handleOpenForm = (): void => {
    setFormError('')
    setShowInlineForm(true)
  }
  const handleCancelForm = (): void => {
    setShowInlineForm(false)
    setNewName('')
    setNewUrl('')
    setNewUpdateInterval(24 * 60)
    setUrlTouched(false)
    setFormError('')
  }
  const handleCreateProfile = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (creatingRef.current) return
    const name = newName.trim()
    const url = newUrl.trim()
    setUrlTouched(true)
    if (!name || !isValidSubscriptionUrl(url)) return
    if (itemsArray.some((item) => item.type === 'remote' && item.url === url)) {
      setFormError(t('redesign.duplicateProfile'))
      return
    }
    creatingRef.current = true
    setCreating(true)
    setFormError('')
    const existingIds = new Set(itemsArray.map((item) => item.id))
    try {
      await addProfileItem({
        name,
        type: 'remote',
        url,
        useProxy: false,
        autoUpdate: newUpdateInterval !== null,
        interval: newUpdateInterval ?? 24 * 60
      })
      const refreshed = await getProfileConfig()
      const created = refreshed.items.find(
        (item) => item.type === 'remote' && item.url === url && !existingIds.has(item.id)
      )
      if (!created) {
        setFormError(t('redesign.operationFailed'))
        return
      }
      setInspectedId(created.id)
      handleCancelForm()
    } catch (error) {
      setFormError(String(error))
      toast.error(String(error))
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }
  const inspected =
    sortedItems.find((item) => item.id === inspectedId) ??
    sortedItems.find((item) => item.id === current) ??
    sortedItems[0]
  const hasAutoUpdate = sortedItems.some((item) => item.type === 'remote' && item.autoUpdate)

  async function updateAll(): Promise<void> {
    setUpdating(true)
    try {
      for (const item of itemsArray) {
        if (item.id === current || item.type !== 'remote') continue
        await addProfileItem(item)
      }
      const currentItem = itemsArray.find((item) => item.id === current)
      if (currentItem?.type === 'remote') await addProfileItem(currentItem)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <BasePage
      ref={pageRef}
      title={t('redesign.profilesTitle')}
      subtitle={`${t('redesign.sourceCount', { count: sortedItems.length })}${sortedItems.length ? ` · ${t(hasAutoUpdate ? 'redesign.autoUpdateEnabled' : 'redesign.manualUpdate')}` : ''}`}
      contentClassName="koala-profiles-page"
      header={
        <div className="koala-profiles-header-actions">
          <Button
            size="sm"
            className="new-profile app-nodrag"
            disabled={creating}
            onClick={handleOpenForm}
          >
            <Plus aria-hidden="true" />
            {t('pages.profiles.addProfile')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                className="app-nodrag"
                variant="ghost"
                aria-label={t('redesign.moreSettings')}
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {sortedItems.some((item) => item.type === 'remote') && (
                <>
                  <DropdownMenuItem disabled={updating} onClick={() => void updateAll()}>
                    <RefreshCcw aria-hidden="true" />
                    {t('pages.profiles.updateAll')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem disabled={creating} onClick={handleAdvancedCreate}>
                {t('redesign.advancedCreate')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {showEditModal && editingItem && (
        <EditInfoModal
          item={editingItem}
          isCurrent={editingItem.id === current}
          updateProfileItem={async (item: ProfileItem) => {
            await addProfileItem(item)
          }}
          onClose={() => {
            setShowEditModal(false)
            setEditingItem(null)
          }}
        />
      )}

      {/* File drop overlay */}
      {fileOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5 px-12 py-8">
            <FileDown className="size-10 text-primary" />
            <span className="text-sm font-medium text-primary">
              {t('pages.profiles.dropFileHint')}
            </span>
          </div>
        </div>
      )}

      {showInlineForm && (
        <form
          className="koala-profile-inline-form"
          aria-busy={creating}
          onSubmit={(event) => void handleCreateProfile(event)}
        >
          <h3>{t('pages.profiles.addProfile')}</h3>
          <label>
            {t('profile.name')}
            <Input
              autoFocus
              name="sourceName"
              required
              maxLength={40}
              placeholder={t('redesign.profileNamePlaceholder')}
              value={newName}
              disabled={creating}
              onChange={(event) => {
                setNewName(event.target.value)
                setFormError('')
              }}
            />
          </label>
          <label>
            {t('profile.subscriptionAddress')}
            <Input
              name="sourceUrl"
              type="url"
              required
              placeholder="https://example.com/subscribe"
              value={newUrl}
              disabled={creating}
              aria-invalid={urlTouched && !!newUrl && !isValidSubscriptionUrl(newUrl.trim())}
              onBlur={() => setUrlTouched(true)}
              onChange={(event) => {
                setNewUrl(event.target.value)
                setFormError('')
              }}
            />
            {urlTouched && !!newUrl && !isValidSubscriptionUrl(newUrl.trim()) && (
              <span className="koala-profile-form-error">{t('profile.invalidUrl')}</span>
            )}
          </label>
          <div className="koala-profile-update-row">
            <label htmlFor="new-profile-update-interval">{t('profile.updateInterval')}</label>
            <ProfileUpdateIntervalSelect
              id="new-profile-update-interval"
              value={newUpdateInterval ?? 24 * 60}
              enabled={newUpdateInterval !== null}
              onChange={setNewUpdateInterval}
              disabled={creating}
            />
          </div>
          {formError && (
            <p className="koala-profile-form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="koala-profile-inline-actions">
            <Button type="button" variant="ghost" disabled={creating} onClick={handleCancelForm}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={creating}>
              {creating && <Spinner aria-hidden="true" />}
              {t('pages.profiles.addProfile')}
            </Button>
          </div>
        </form>
      )}

      {sortedItems.length === 0 ? (
        <div className="ui-panel koala-profiles-empty">
          <h2>{t('pages.profiles.emptyTitle')}</h2>
          <p>{t('pages.profiles.emptyDescription')}</p>
          <Button onClick={handleOpenForm}>
            <Plus aria-hidden="true" />
            {t('pages.profiles.addProfile')}
          </Button>
        </div>
      ) : (
        <div className="koala-profiles-workspace">
          <nav className="koala-profile-sources" aria-label={t('redesign.profilesTitle')}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={sortedItems.map((item) => item.id)}>
                {sortedItems.map((item) => (
                  <ProfileSourceItem
                    key={item.id}
                    info={item}
                    isCurrent={item.id === current}
                    inspected={item.id === inspected?.id}
                    onInspect={() => setInspectedId(item.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </nav>
          {inspected && (
            <ProfileItem
              key={inspected.id}
              isCurrent={inspected.id === current}
              addProfileItem={addProfileItem}
              removeProfileItem={removeProfileItem}
              updateProfileItem={updateProfileItem}
              info={inspected}
              switching={switching}
              onClick={async () => {
                setSwitching(true)
                try {
                  await changeCurrentProfile(inspected.id)
                } finally {
                  setSwitching(false)
                }
              }}
            />
          )}
        </div>
      )}
    </BasePage>
  )
}

export default Profiles
