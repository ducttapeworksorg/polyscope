import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'

export interface MenuItem {
  label: string
  onSelect(): void
}

interface Props {
  label: string
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

/**
 * Where a context menu is open and what it's for: `open` places it at the pointer, or below the
 * element when opened from the keyboard; `close` hands focus back to that element.
 */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<(T & { x: number; y: number }) | null>(null)
  const trigger = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    setMenu(null)
    trigger.current?.focus()
  }, [])

  const open = (event: MouseEvent<HTMLElement>, about: T) => {
    event.preventDefault()
    trigger.current = event.currentTarget
    // Opened from the keyboard (menu key, Shift+F10) the event has no pointer position.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ ...about, x: fromKeyboard ? rect.left + 24 : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY })
  }

  return { menu, open, close }
}

/** A menu at a point; closes on Escape, on picking an item, or on any press outside it. */
export function ContextMenu({ label, x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const menu = menuRef.current!
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    // Keep the whole menu on screen when opened near the window's edge.
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`

    const closeOutside = (event: Event) => {
      if (!menu.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', closeOutside, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      window.removeEventListener('blur', onClose)
    }
  }, [x, y, onClose])

  const onKeyDown = (event: KeyboardEvent) => {
    const entries = [...menuRef.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const at = entries.indexOf(document.activeElement as HTMLElement)
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step) entries[(at + step + entries.length) % entries.length]?.focus()
    else if (event.key === 'Escape' || event.key === 'Tab') onClose()
    else return
    event.preventDefault()
  }

  return (
    <div ref={menuRef} className="context-menu" role="menu" aria-label={label} onKeyDown={onKeyDown} style={{ left: x, top: y }}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="context-menu__item"
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
