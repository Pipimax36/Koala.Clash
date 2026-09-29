import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTranslation } from 'react-i18next'

interface Props {
  info: ProfileItem
  isCurrent: boolean
  inspected: boolean
  onInspect: () => void
}

export default function ProfileSourceItem({ info, isCurrent, inspected, onInspect }: Props) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: info.id
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      className="koala-profile-source"
      {...attributes}
      {...listeners}
      aria-pressed={inspected}
      aria-label={`${info.name}, ${isCurrent ? t('redesign.currentUse') : t('redesign.notActive')}`}
      onClick={onInspect}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined
      }}
    >
      <strong title={info.name}>{info.name}</strong>
      <small>
        {info.type === 'remote' ? t('redesign.remoteProfileLabel') : t('profile.localProfileLabel')}
        {' · '}
        {isCurrent ? t('redesign.usingProfile') : t('redesign.standbyProfile')}
      </small>
    </button>
  )
}
