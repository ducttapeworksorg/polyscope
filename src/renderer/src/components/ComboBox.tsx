import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { t } from '../i18n'
import { ChevronIcon } from './icons'

interface Props {
  value: string
  /** Only suggestions: anything can be typed in. */
  options: string[]
  onChange(value: string): void
  id?: string
  className?: string
  placeholder?: string
}

/**
 * A text field with suggestions. Unlike a `<datalist>`, opening it shows every suggestion whatever is typed
 * already; only typing narrows them. Arrows move, Enter picks, Escape closes the list (not the dialog around it).
 */
export function ComboBox({ value, options, onChange, id, className = '', placeholder }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  // Opened, it shows every suggestion; typed in since, only those containing what's typed.
  const [filter, setFilter] = useState<string | null>(null)
  const [active, setActive] = useState(-1)
  const shown = filter === null ? options : options.filter((option) => option.toLowerCase().includes(filter.trim().toLowerCase()))
  const expanded = open && shown.length > 0
  const current = Math.min(active, shown.length - 1)

  const show = () => {
    setOpen(true)
    setFilter(null)
    setActive(options.indexOf(value))
  }
  const close = () => setOpen(false)
  const pick = (option: string) => {
    onChange(option)
    close()
  }

  // The dialog clips what overflows it, so the list is placed over it, under the field, and follows it on scroll.
  useLayoutEffect(() => {
    if (!expanded) return
    const place = () => {
      const rect = inputRef.current!.getBoundingClientRect()
      const list = listRef.current!
      list.style.top = `${rect.bottom + 2}px`
      list.style.left = `${rect.left}px`
      list.style.width = `${rect.width}px`
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [expanded])

  useEffect(() => {
    if (expanded) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [expanded, current])

  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step && !expanded) show()
    else if (step) setActive((current + step + shown.length) % shown.length)
    else if (event.key === 'Enter' && expanded && shown[current] !== undefined) pick(shown[current])
    else if (event.key === 'Escape' && expanded) {
      event.stopPropagation()
      close()
    } else return
    event.preventDefault()
  }

  return (
    <div className="combo-box" onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && close()}>
      <input
        ref={inputRef}
        id={id}
        className={`field__input combo-box__input ${className}`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && current >= 0 ? `${listId}-${current}` : undefined}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
          setFilter(event.target.value)
          setActive(-1)
        }}
        onClick={() => (expanded ? close() : show())}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="combo-box__toggle"
        tabIndex={-1}
        aria-label={t('comboBox.showSuggestions')}
        disabled={options.length === 0}
        // Keeps the focus in the field, so the list isn't closed by the field losing it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          inputRef.current!.focus()
          if (expanded) close()
          else show()
        }}
      >
        <ChevronIcon />
      </button>
      {expanded && (
        <ul ref={listRef} id={listId} className="combo-box__list" role="listbox">
          {shown.map((option, index) => (
            <li
              key={option}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === current}
              className={`combo-box__option ${option === value ? 'is-current' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => pick(option)}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
