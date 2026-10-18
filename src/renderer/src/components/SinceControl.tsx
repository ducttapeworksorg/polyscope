import { useEffect, useId, useState, type FormEvent } from 'react'
import { t } from '../i18n'
import { readSince, shownSince, sinceChoices, type SinceChoice } from '../since'

interface Props {
  /** Any time when left out. */
  value: SinceChoice | undefined
  /** Whether a time is shown and typed in UTC rather than local time. */
  utc: boolean
  onChange(value: SinceChoice | undefined): void
}

const choiceLabel = (minutes: number) => (minutes < 60 ? t('logView.since.minutes', { count: minutes }) : t('logView.since.hours', { count: minutes / 60 }))

/**
 * A log view's Since: any time, one of the usual whiles ago, or a date and time typed in, in local time or UTC as the
 * log view shows its timestamps. A typed time that can't be read is refused, saying so.
 */
export function SinceControl({ value, utc, onChange }: Props) {
  const id = useId()
  const typedValue = value && 'time' in value ? shownSince(value.time, utc) : ''
  const [typed, setTyped] = useState(typedValue)
  const [unreadable, setUnreadable] = useState(false)
  // Picking a choice, another tab's Since, or UTC replaces whatever was being typed.
  useEffect(() => {
    setTyped(typedValue)
    setUnreadable(false)
  }, [typedValue])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (typed.trim() === typedValue) return setUnreadable(false)
    // Cleared: back to any time.
    if (!typed.trim()) {
      setUnreadable(false)
      return onChange(undefined)
    }
    const time = readSince(typed, utc)
    setUnreadable(time === undefined)
    if (time !== undefined) onChange({ time })
  }

  /** Picks a choice, dropping whatever was being typed. */
  const choose = (choice: SinceChoice | undefined) => {
    setTyped('')
    setUnreadable(false)
    onChange(choice)
  }

  const minutesAgo = value && 'minutesAgo' in value ? value.minutesAgo : undefined
  return (
    <form className="log-toolbar__lines" onSubmit={submit}>
      <span className="log-toolbar__label" id={`${id}-label`}>
        {t('logView.since')}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`${id}-label`}>
        <label className="segmented__option">
          <input type="radio" name={`${id}-since`} checked={value === undefined} onChange={() => choose(undefined)} />
          {t('logView.since.any')}
        </label>
        {sinceChoices.map((minutes) => (
          <label key={minutes} className="segmented__option">
            <input type="radio" name={`${id}-since`} checked={minutesAgo === minutes} onChange={() => choose({ minutesAgo: minutes })} />
            {choiceLabel(minutes)}
          </label>
        ))}
      </div>
      <input
        className="field__input log-toolbar__input log-toolbar__input--time"
        aria-label={t('logView.since.typed')}
        aria-invalid={unreadable}
        aria-describedby={unreadable ? `${id}-error` : undefined}
        placeholder={t(utc ? 'logView.since.placeholder.utc' : 'logView.since.placeholder')}
        title={t(utc ? 'logView.since.tooltip.utc' : 'logView.since.tooltip')}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={submit}
      />
      {unreadable && (
        <span className="log-toolbar__error" id={`${id}-error`} role="alert">
          {t('logView.since.unreadable')}
        </span>
      )}
    </form>
  )
}
