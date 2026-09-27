import { useEffect, useId, useState, type FormEvent } from 'react'
import { lastNLinesChoices, type LastNLines } from '@shared/core-api'
import { locale, t } from '../i18n'

interface Props {
  value: LastNLines
  onChange(value: LastNLines): void
}

const compact = new Intl.NumberFormat(locale, { notation: 'compact' })

const choiceLabel = (choice: LastNLines) => (choice === 'all' ? t('logView.choice.all') : compact.format(choice))

/**
 * The "Last N lines" a log view fetches and keeps (following included): one of the usual choices, or a
 * number typed in. Sits at the start of every log view's toolbar.
 */
export function LastNLinesControl({ value, onChange }: Props) {
  const id = useId()
  const typedValue = lastNLinesChoices.includes(value) ? '' : String(value)
  const [typed, setTyped] = useState(typedValue)
  // Picking a choice, or another tab's number, replaces whatever was being typed.
  useEffect(() => setTyped(typedValue), [typedValue])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const lines = Number(typed)
    if (Number.isSafeInteger(lines) && lines > 0 && lines !== value) onChange(lines)
    else setTyped(typedValue)
  }

  return (
    <form className="log-toolbar__lines" onSubmit={submit}>
      <span className="log-toolbar__label" id={`${id}-label`}>
        {t('logView.lastNLines')}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`${id}-label`}>
        {lastNLinesChoices.map((choice) => (
          <label key={choice} className="segmented__option">
            <input type="radio" name={`${id}-lines`} checked={value === choice} onChange={() => onChange(choice)} />
            {choiceLabel(choice)}
          </label>
        ))}
      </div>
      <input
        className="field__input log-toolbar__input"
        inputMode="numeric"
        aria-label={t('logView.typed')}
        placeholder={t('logView.typed')}
        value={typed}
        onChange={(e) => setTyped(e.target.value.replace(/\D/g, ''))}
        onBlur={submit}
      />
    </form>
  )
}
