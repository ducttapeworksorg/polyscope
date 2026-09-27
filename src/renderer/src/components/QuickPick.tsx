import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface PickOption {
  value: string
  label: string
  /** A quieter note after the label, e.g. 'detected'. */
  detail?: string
}

interface Props {
  label: string
  placeholder: string
  options: PickOption[]
  /** The option shown as current, and highlighted first. */
  selected?: string
  /** The element the picker opens above, e.g. a status bar item. */
  anchor: HTMLElement
  onPick(value: string): void
  onClose(): void
}

/** A filterable list opened above an element; type to narrow, arrows to move, Enter to pick, Escape to close. */
export function QuickPick({ label, placeholder, options, selected, anchor, onPick, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()
  const [filter, setFilter] = useState('')
  const shown = options.filter((option) => option.label.toLowerCase().includes(filter.trim().toLowerCase()))
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((option) => option.value === selected)))
  const current = Math.min(active, shown.length - 1)

  useLayoutEffect(() => {
    const root = rootRef.current!
    const rect = anchor.getBoundingClientRect()
    root.style.bottom = `${window.innerHeight - rect.top + 4}px`
    root.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - root.offsetWidth - 4))}px`
  }, [anchor])

  useEffect(() => {
    const closeOutside = (event: Event) => {
      if (!rootRef.current!.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', closeOutside, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const pick = (value: string) => {
    onClose()
    onPick(value)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step && shown.length) setActive((current + step + shown.length) % shown.length)
    else if (event.key === 'Enter' && shown[current]) pick(shown[current].value)
    else if (event.key === 'Escape' || event.key === 'Tab') onClose()
    else return
    event.preventDefault()
  }

  return (
    <div ref={rootRef} className="quick-pick" role="dialog" aria-label={label}>
      <input
        className="field__input"
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={shown[current] ? `${listId}-${current}` : undefined}
        placeholder={placeholder}
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
      />
      <ul ref={listRef} id={listId} className="quick-pick__list" role="listbox" aria-label={label}>
        {shown.map((option, index) => (
          <li
            key={option.value}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === current}
            className="quick-pick__option"
            onPointerMove={() => setActive(index)}
            onClick={() => pick(option.value)}
          >
            {option.label}
            {option.detail && <span className="quick-pick__detail">{option.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
