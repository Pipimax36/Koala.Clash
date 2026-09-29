import BasePage from '@renderer/components/base/base-page'
import RuleItem from '@renderer/components/rules/rule-item'
import EditRulesModal from '@renderer/components/profiles/edit-rules-modal'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Button } from '@renderer/components/ui/button'
import { useRules } from '@renderer/hooks/use-rules'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { includesIgnoreCase } from '@renderer/utils/includes'
import {
  getProfileConfig,
  getProfileParseStr,
  getRuleStr,
  mihomoHotReloadConfig,
  setRuleStr
} from '@renderer/utils/ipc'
import { Database, Ellipsis, Plus, Search } from 'lucide-react'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Virtuoso } from 'react-virtuoso'
import { toast } from 'sonner'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import '@renderer/components/rules/rules-page.css'

type RuleCategory = 'all' | 'ruleSet' | 'other' | 'geo'

function normalizedRuleType(rule: ControllerRulesDetail): string {
  return rule.type.replace(/[^a-z0-9]/gi, '').toUpperCase()
}

function matchesCategory(rule: ControllerRulesDetail, category: RuleCategory): boolean {
  if (category === 'all') return true
  const type = normalizedRuleType(rule)
  const isRuleSet = type === 'RULESET'
  const isGeo = type === 'GEOSITE' || type === 'GEOIP' || type === 'SRCGEOIP'
  if (category === 'ruleSet') return isRuleSet
  if (category === 'geo') return isGeo
  return !isRuleSet && !isGeo
}

const domainSuffixPattern =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/

function getRuleTargets(profileContent: string): string[] {
  const document = parseDocument(profileContent)
  if (document.errors.length) throw document.errors[0]
  const profile = document.toJS()
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Profile is not a YAML mapping')
  }

  const names: string[] = []
  for (const key of ['proxy-groups', 'proxies']) {
    const entries = (profile as Record<string, unknown>)[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const name = (entry as Record<string, unknown>).name
      if (typeof name === 'string' && name.trim() && !/[,\r\n]/.test(name)) names.push(name)
    }
  }

  const preferred = names.includes('PROXY') ? 'PROXY' : (names[0] ?? 'DIRECT')
  return [...new Set([preferred, 'DIRECT', 'REJECT', ...names])]
}

function addPrependRule(rawOverrides: string, rule: string): string {
  const document = parseDocument(rawOverrides)
  if (document.errors.length) throw document.errors[0]
  if (!document.contents) {
    document.set('prepend', [rule])
    return String(document)
  }
  if (!isMap(document.contents)) throw new Error('Rule overrides are not a YAML mapping')

  const existing = document.toJS() as Record<string, unknown>
  if (Array.isArray(existing.delete) && existing.delete.includes(rule)) {
    throw new Error('The same rule is marked for deletion in the existing overrides')
  }

  const prepend = document.get('prepend', true)
  if (prepend === undefined || (isScalar(prepend) && prepend.value === null)) {
    document.set('prepend', [rule])
  } else if (
    isSeq(prepend) &&
    prepend.items.every((item) => isScalar(item) && typeof item.value === 'string')
  ) {
    prepend.items.unshift(document.createNode(rule))
  } else {
    throw new Error('Existing prepend rules are not a string list')
  }

  return String(document)
}

const Rules: React.FC = () => {
  const { t } = useTranslation()
  const { rules, mutate: mutateRules } = useRules()
  const { profileConfig } = useProfileConfig()
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState<RuleCategory>('all')
  const [exactType, setExactType] = useState('all')
  const [showRulesEditor, setShowRulesEditor] = useState(false)
  const [ruleFormProfileId, setRuleFormProfileId] = useState<string | null>(null)
  const [ruleDomain, setRuleDomain] = useState('')
  const [ruleTarget, setRuleTarget] = useState('')
  const [ruleTargets, setRuleTargets] = useState<string[]>([])
  const [ruleFormError, setRuleFormError] = useState<string | null>(null)
  const [loadingTargets, setLoadingTargets] = useState(false)
  const [savingRule, setSavingRule] = useState(false)
  const savingRuleRef = useRef(false)
  const ruleFormRequest = useRef(0)
  const navigate = useNavigate()

  const closeRuleForm = (): void => {
    ruleFormRequest.current += 1
    setRuleFormProfileId(null)
    setRuleFormError(null)
  }

  const openRuleForm = async (): Promise<void> => {
    if (savingRuleRef.current) return
    const id = profileConfig?.current
    if (!id || ruleFormProfileId === id) return
    const request = ++ruleFormRequest.current
    setRuleFormProfileId(id)
    setRuleDomain('')
    setRuleTarget('')
    setRuleTargets([])
    setRuleFormError(null)
    setLoadingTargets(true)

    try {
      const targets = getRuleTargets(await getProfileParseStr(id))
      if (request !== ruleFormRequest.current) return
      setRuleTargets(targets)
      setRuleTarget(targets[0])
    } catch (error) {
      if (request !== ruleFormRequest.current) return
      setRuleFormError(error instanceof Error ? error.message : String(error))
    } finally {
      if (request === ruleFormRequest.current) setLoadingTargets(false)
    }
  }

  const saveInlineRule = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const id = ruleFormProfileId
    const domain = ruleDomain.trim().toLowerCase()
    if (
      !id ||
      id !== profileConfig?.current ||
      savingRuleRef.current ||
      loadingTargets ||
      ruleFormError
    )
      return
    if (!domainSuffixPattern.test(domain)) {
      toast.error(t('profile.editRules.invalidPayload'))
      return
    }
    if (!ruleTargets.includes(ruleTarget)) return

    savingRuleRef.current = true
    setSavingRule(true)
    try {
      const newRule = `DOMAIN-SUFFIX,${domain},${ruleTarget}`
      const overrides = await getRuleStr(id)
      await setRuleStr(id, addPrependRule(overrides, newRule))
      closeRuleForm()
      try {
        if ((await getProfileConfig()).current === id) {
          await mihomoHotReloadConfig()
          mutateRules()
        }
      } catch (error) {
        toast.error(
          `${t('redesign.ruleSavedReloadFailed')} ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } catch (error) {
      toast.error(
        `${t('profile.editRules.saveError')}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      savingRuleRef.current = false
      setSavingRule(false)
    }
  }

  const filteredRules = useMemo(() => {
    if (!rules) return []
    return rules.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => {
        return (
          matchesCategory(rule, category) &&
          (exactType === 'all' || rule.type === exactType) &&
          (includesIgnoreCase(rule.payload, filter) ||
            includesIgnoreCase(rule.type, filter) ||
            includesIgnoreCase(rule.proxy, filter))
        )
      })
  }, [rules, filter, category, exactType])

  const lastRule = rules?.rules.at(-1)
  const ruleTypes = useMemo(() => [...new Set(rules?.rules.map((rule) => rule.type))], [rules])

  return (
    <BasePage
      title={t('sider.rules')}
      subtitle={t('redesign.rulesSubtitle')}
      contentClassName={`koala-rules-page${ruleFormProfileId === profileConfig?.current ? ' koala-rules-page-with-form' : ''}`}
      header={
        <div className="koala-rule-actions">
          <Button
            size="sm"
            disabled={!profileConfig?.current || savingRule}
            title={t('profile.editRules.addRule')}
            onClick={() => void openRuleForm()}
          >
            <Plus className="size-4" />
            {t('profile.editRules.addRule')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                disabled={savingRule}
                title={t('redesign.moreActions')}
                aria-label={t('redesign.moreActions')}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="koala-rule-more-menu">
              <DropdownMenuLabel>{t('redesign.moreActions')}</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={!profileConfig?.current || savingRule}
                onSelect={() => {
                  if (savingRuleRef.current) return
                  closeRuleForm()
                  setShowRulesEditor(true)
                }}
              >
                <Plus className="size-4" />
                {t('profile.editRules.title')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate('/resources')}>
                <Database className="size-4" />
                {t('pages.resources.title')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t('profile.editRules.ruleType')}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setExactType('all')}>
                {t('redesign.allRules')}
                {exactType === 'all' && <span className="ml-auto">✓</span>}
              </DropdownMenuItem>
              {ruleTypes.map((type) => (
                <DropdownMenuItem key={type} onSelect={() => setExactType(type)}>
                  {type}
                  {exactType === type && <span className="ml-auto">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {showRulesEditor && profileConfig?.current && (
        <EditRulesModal id={profileConfig.current} onClose={() => setShowRulesEditor(false)} />
      )}

      {ruleFormProfileId === profileConfig?.current && (
        <form className="koala-rule-form" onSubmit={(event) => void saveInlineRule(event)}>
          <h3>{t('redesign.addCustomRule')}</h3>
          <label className="koala-rule-field">
            <span>{t('redesign.domainSuffix')}</span>
            <input
              autoFocus
              type="text"
              required
              maxLength={253}
              pattern="[A-Za-z0-9.-]+"
              placeholder="example.com"
              value={ruleDomain}
              onChange={(event) => setRuleDomain(event.target.value)}
            />
          </label>
          <label className="koala-rule-field">
            <span>{t('redesign.ruleTarget')}</span>
            <select
              required
              disabled={loadingTargets || !!ruleFormError}
              value={ruleTarget}
              onChange={(event) => setRuleTarget(event.target.value)}
            >
              {ruleTargets.map((target) => (
                <option key={target} value={target}>
                  {target}
                </option>
              ))}
            </select>
          </label>
          {ruleFormError ? (
            <p className="koala-rule-form-error" role="alert">
              {t('profile.editRules.loadError')}: {ruleFormError}
            </p>
          ) : (
            <p className="koala-rule-form-hint">{t('redesign.ruleInsertHint')}</p>
          )}
          <div className="koala-rule-form-actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={savingRule}
              onClick={() => {
                if (!savingRuleRef.current) closeRuleForm()
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={savingRule || loadingTargets || !!ruleFormError || !ruleTarget}
            >
              {t('redesign.saveRule')}
            </Button>
          </div>
        </form>
      )}

      <div
        className="ui-group-tabs koala-rule-tabs"
        role="group"
        aria-label={t('redesign.allRules')}
      >
        {(
          [
            ['all', t('redesign.allRules')],
            ['ruleSet', t('redesign.ruleSets')],
            ['other', t('redesign.otherRules')],
            ['geo', t('redesign.geoRules')]
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={category === key}
            onClick={() => {
              setCategory(key)
              setExactType('all')
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="koala-rule-search">
        <Search className="size-4" aria-hidden />
        <input
          type="search"
          value={filter}
          aria-label={t('redesign.searchRules')}
          placeholder={t('redesign.searchRules')}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>

      <div className="koala-rule-table">
        <div className="koala-rule-table-head">
          <span>{t('redesign.ruleOrder')}</span>
          <span>{t('profile.editRules.payload')}</span>
          <span>{t('profile.editRules.ruleType')}</span>
          <span>{t('redesign.ruleTarget')}</span>
        </div>
        <div className="koala-rule-table-body">
          {filteredRules.length ? (
            <Virtuoso
              style={{ height: '100%' }}
              data={filteredRules}
              itemContent={(_i, { rule, index }) => (
                <RuleItem
                  index={index}
                  type={rule.type}
                  payload={rule.payload}
                  proxy={rule.proxy}
                  size={rule.size}
                />
              )}
            />
          ) : (
            <div className="koala-rule-empty">
              {t(
                filter || category !== 'all' || exactType !== 'all'
                  ? 'redesign.noResults'
                  : 'redesign.noRules'
              )}
            </div>
          )}
        </div>
      </div>
      {lastRule && normalizedRuleType(lastRule) === 'MATCH' && (
        <p className="koala-rule-footer">
          {t('redesign.ruleFallbackHint', { target: lastRule.proxy })}
        </p>
      )}
    </BasePage>
  )
}

export default Rules
