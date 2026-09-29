import React from 'react'
interface Props {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  divider?: boolean
}
const SettingItem: React.FC<Props> = ({ title, description, actions, children }) => (
  <div className="ui-setting-row">
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <h4>{title}</h4>
        {actions}
      </div>
      {description && <p>{description}</p>}
    </div>
    {children}
  </div>
)
export default SettingItem
