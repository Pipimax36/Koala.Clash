import React from 'react'
import { cn } from '@renderer/lib/utils'

interface Props {
  title?: string
  children?: React.ReactNode
  className?: string
}
const SettingCard: React.FC<Props> = ({ title, children, className }) => (
  <section className={cn('ui-setting-section', className)}>
    {title && <h2 className="ui-setting-heading">{title}</h2>}
    <div className="ui-list">{children}</div>
  </section>
)
export default SettingCard
