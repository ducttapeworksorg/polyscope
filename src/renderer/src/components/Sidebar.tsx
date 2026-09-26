import { useCallback, useRef, useState, type DragEvent, type HTMLAttributes, type MouseEvent } from 'react'
import type { SourceInfo, SourceTypeId, TreeNode } from '@shared/core-api'
import { core, describeError } from '../core-client'
import { t } from '../i18n'
import { uiFor } from '../source-types'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu } from './ContextMenu'
import { PlusIcon } from './icons'
import { SourceDialog } from './SourceDialog'
import { SourceTree } from './SourceTree'

interface Props {
  /** In sidebar order: grouped by Source Type, groups in their user-chosen order. */
  sources: SourceInfo[]
  /** Something about the Sources changed; the caller reloads them from the core. */
  onSourcesChanged(): void
  onOpenFile(source: SourceInfo, node: TreeNode): void
}

interface Group {
  type: SourceTypeId
  sources: SourceInfo[]
}

type Dialog = { kind: 'add' } | { kind: 'edit'; source: SourceInfo } | { kind: 'delete'; source: SourceInfo }
type Dragging = { kind: 'source'; id: string; type: SourceTypeId } | { kind: 'group'; type: SourceTypeId }
/** Where a drop would land: before or after the Source (by id) or group (by type) under the pointer. */
type DropAt = { key: string; after: boolean }

/** Groups arrive already in order, so each new type seen starts the next group. Empty groups never appear. */
function groupByType(sources: SourceInfo[]): Group[] {
  const groups: Group[] = []
  for (const source of sources) {
    const last = groups.at(-1)
    if (last?.type === source.type) last.sources.push(source)
    else groups.push({ type: source.type, sources: [source] })
  }
  return groups
}

/** The position `dragged` takes among `keys` when dropped next to `target`. */
function dropIndex(keys: string[], dragged: string, { key, after }: DropAt) {
  const rest = keys.filter((k) => k !== dragged)
  return rest.indexOf(key) + (after ? 1 : 0)
}

const isAfter = (event: DragEvent<HTMLElement>) => {
  const { top, height } = event.currentTarget.getBoundingClientRect()
  return event.clientY > top + height / 2
}

export function Sidebar({ sources, onSourcesChanged, onOpenFile }: Props) {
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [menu, setMenu] = useState<{ source: SourceInfo; x: number; y: number } | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [dragging, setDragging] = useState<Dragging | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const menuTrigger = useRef<HTMLElement | null>(null)
  const groups = groupByType(sources)

  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(describeError(e))
    }
    onSourcesChanged()
  }

  const closeMenu = useCallback(() => {
    setMenu(null)
    menuTrigger.current?.focus()
  }, [])

  const openMenu = (event: MouseEvent<HTMLElement>, source: SourceInfo) => {
    event.preventDefault()
    menuTrigger.current = event.currentTarget
    // Opened from the keyboard (menu key, Shift+F10) the event has no pointer position.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ source, x: fromKeyboard ? rect.left + 24 : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY })
  }

  const endDrag = () => {
    setDragging(null)
    setDropAt(null)
  }

  const trackDrop = (event: DragEvent<HTMLElement>, key: string) => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const after = isAfter(event)
    if (dropAt?.key !== key || dropAt.after !== after) setDropAt({ key, after })
  }

  const dropClass = (key: string) => (dropAt?.key === key ? (dropAt.after ? 'is-drop-after' : 'is-drop-before') : '')

  const startDrag = (event: DragEvent<HTMLElement>, what: Dragging, label: string) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', label)
    setDragging(what)
  }

  const sourceRowProps = (source: SourceInfo): HTMLAttributes<HTMLDivElement> => ({
    draggable: true,
    onContextMenu: (event) => openMenu(event, source),
    onDragStart: (event) => startDrag(event, { kind: 'source', id: source.id, type: source.type }, source.name),
    onDragEnd: endDrag
  })

  // The whole tree takes the drop, so an expanded Source lands before or after all of its rows.
  const treeProps = (source: SourceInfo, group: Group): HTMLAttributes<HTMLDivElement> => ({
    className: dropClass(source.id),
    onDragOver: (event) => {
      // Sources only move within their own group; anything else is left to the group below.
      if (dragging?.kind === 'source' && dragging.type === source.type) trackDrop(event, source.id)
    },
    onDrop: (event) => {
      if (dragging?.kind !== 'source' || !dropAt) return
      event.preventDefault()
      event.stopPropagation()
      const index = dropIndex(group.sources.map((s) => s.id), dragging.id, dropAt)
      endDrag()
      if (dragging.id !== dropAt.key) void run(() => core.moveSource(dragging.id, index))
    }
  })

  const groupProps = (group: Group): HTMLAttributes<HTMLElement> => ({
    className: `source-group ${dropClass(group.type)}`,
    onDragOver: (event) => {
      if (dragging?.kind === 'group') trackDrop(event, group.type)
    },
    onDrop: (event) => {
      if (dragging?.kind !== 'group' || !dropAt) return
      event.preventDefault()
      const index = dropIndex(groups.map((g) => g.type), dragging.type, dropAt)
      endDrag()
      if (dragging.type !== dropAt.key) void run(() => core.moveSourceGroup(dragging.type, index))
    }
  })

  const isEmpty = sources.length === 0

  return (
    <nav className="sidebar" aria-label={t('sidebar.heading')}>
      <header className="sidebar__header">
        <h2 className="sidebar__heading">{t('sidebar.heading')}</h2>
        {!isEmpty && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('sidebar.add')}
            title={t('sidebar.add')}
            onClick={() => setDialog({ kind: 'add' })}
          >
            <PlusIcon />
          </button>
        )}
      </header>

      {error && (
        <p className="sidebar__error" role="alert">
          {error}
        </p>
      )}

      {isEmpty && (
        <div className="sidebar__empty">
          <p className="sidebar__empty-title">{t('sidebar.empty.title')}</p>
          <p className="sidebar__empty-body">{t('sidebar.empty.body')}</p>
          <button type="button" className="button button--primary" onClick={() => setDialog({ kind: 'add' })}>
            {t('sidebar.add')}
          </button>
        </div>
      )}

      <div className="sidebar__sources">
        {groups.map((group) => {
          const { Icon, label } = uiFor(group.type)
          return (
            <section key={group.type} aria-label={t(label)} {...groupProps(group)}>
              <h3
                className="source-group__header"
                draggable
                onDragStart={(event) => startDrag(event, { kind: 'group', type: group.type }, t(label))}
                onDragEnd={endDrag}
              >
                <Icon />
                {t(label)}
              </h3>
              {group.sources.map((source) => (
                <SourceTree
                  // A new root means a new tree: nothing expanded under the old one carries over.
                  key={`${source.id}:${source.rootPath}`}
                  source={source}
                  selectedKey={selectedKey}
                  onSelect={setSelectedKey}
                  onOpenFile={onOpenFile}
                  sourceRowProps={sourceRowProps(source)}
                  treeProps={treeProps(source, group)}
                />
              ))}
            </section>
          )
        })}
      </div>

      {menu && (
        <ContextMenu
          label={t('sourceMenu.label', { name: menu.source.name })}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            { label: t('sourceMenu.edit'), onSelect: () => setDialog({ kind: 'edit', source: menu.source }) },
            { label: t('sourceMenu.duplicate'), onSelect: () => void run(() => core.duplicateSource(menu.source.id)) },
            { label: t('sourceMenu.delete'), onSelect: () => setDialog({ kind: 'delete', source: menu.source }) }
          ]}
        />
      )}

      {(dialog?.kind === 'add' || dialog?.kind === 'edit') && (
        <SourceDialog
          editing={dialog.kind === 'edit' ? dialog.source : undefined}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            onSourcesChanged()
          }}
        />
      )}

      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={t('deleteSource.title', { name: dialog.source.name })}
          body={t('deleteSource.body')}
          confirmLabel={t('deleteSource.confirm')}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null)
            void run(() => core.deleteSource(dialog.source.id))
          }}
        />
      )}
    </nav>
  )
}
