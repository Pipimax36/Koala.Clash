import { useTranslation } from 'react-i18next'

const RuleItem: React.FC<ControllerRulesDetail & { index: number }> = ({
  index,
  type,
  payload,
  proxy,
  size
}) => {
  const { t } = useTranslation()
  const match = payload || t('redesign.matchAll')
  return (
    <div className="koala-rule-row">
      <span className="koala-rule-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="koala-rule-match" title={match}>
        <span className="koala-rule-match-text">{match}</span>
        {size > 1 && (
          <span className="koala-rule-count">{t('redesign.ruleCount', { count: size })}</span>
        )}
      </span>
      <span className="koala-rule-type" title={type}>
        <span>{type}</span>
      </span>
      <span className="koala-rule-target" title={proxy}>
        {proxy}
      </span>
    </div>
  )
}

export default RuleItem
