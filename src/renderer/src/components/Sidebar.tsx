import { useState, type DragEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type Ref } from 'react'
import type { ConnectionState, ContainerNode, EntryNode, Environment, SourceInfo, SourceTypeId, TreeNode } from '@shared/core-api'
import type { Theme } from '@shared/settings'
import { core, describeError } from '../core-client'
import { environmentOf } from '../environments'
import { t } from '../i18n'
import { targetOf, uiFor } from '../source-types'
import { createTypeAhead, treeFocusTarget, treeNavigationKeys, typeAheadTarget, type TreeRow } from '../tree-navigation'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu'
import { DetailsIcon, DuplicateIcon, GearIcon, PencilIcon, PlusIcon, ThemeIcon, TrashIcon, UnlinkIcon } from './icons'
import { SourceDialog } from './SourceDialog'
import { SourceTree, type SourceAction } from './SourceTree'

interface Props {
  ref?: Ref<HTMLElement>
  /** In sidebar order: grouped by Source Type, groups in their user-chosen order. */
  sources: SourceInfo[]
  /** Every Environment, for labelling Sources. */
  environments: Environment[]
  onManageEnvironments(): void
  /** Each Source's connection state; Sources without an entry are Disconnected. */
  connections: ReadonlyMap<string, ConnectionState>
  /** Connects a Source, resolving to its root's children or null if it couldn't connect. */
  onConnect(source: SourceInfo): Promise<TreeNode[] | null>
  onDisconnect(source: SourceInfo): void
  /** Something about the Sources changed; the caller reloads them from the core. */
  onSourcesChanged(): void
  /** Opens a file in the preview tab, or in a tab of its own when pinned. */
  onOpenFile(source: SourceInfo, node: EntryNode, options?: { pinned: boolean }): void
  /** Opens a container's Log Stream in the preview tab, or in a tab of its own when pinned. */
  onOpenLog(source: SourceInfo, node: ContainerNode, options?: { pinned: boolean }): void
  /** Follows a file of a Local or Kubernetes Files Source in a log view. */
  onFollowFile(source: SourceInfo, node: EntryNode): void
  onOpenSettings(): void
  /** Whether tree rows show their size and modified time. */
  showDetails: boolean
  onToggleDetails(): void
  theme: Theme
  /** Switches between the dark and light themes. */
  onToggleTheme(): void
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

/** A tree row as keyboard navigation sees it, read from its element. */
const treeRowOf = (item: HTMLElement): TreeRow => {
  const expanded = item.getAttribute('aria-expanded')
  return {
    label: item.querySelector('.tree-row__label')?.textContent ?? '',
    level: Number(item.getAttribute('aria-level')),
    expanded: expanded === null ? undefined : expanded === 'true'
  }
}

const disconnected: ConnectionState = { state: 'disconnected' }
const settingsShortcut = navigator.userAgent.includes('Mac') ? '⌘,' : 'Ctrl+,'

export function Sidebar(props: Props) {
  const { sources, connections, onConnect, onDisconnect, onSourcesChanged, onOpenFile, onOpenLog, onFollowFile, onOpenSettings } = props
  const { showDetails, onToggleDetails, theme, onToggleTheme, environments, onManageEnvironments, ref } = props
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const { menu, open: openContextMenu, close: closeMenu } = useContextMenu<{ label: string; items: MenuItem[] }>()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [dragging, setDragging] = useState<Dragging | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typeAhead] = useState(() => createTypeAhead())
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

  const openMenu = (event: MouseEvent<HTMLElement>, label: string, items: MenuItem[]) => openContextMenu(event, { label, items })

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

  // Right-aligned, so the ones every Source has keep their place whether or not it's connected.
  const sourceActions = (source: SourceInfo): SourceAction[] => [
    ...((connections.get(source.id) ?? disconnected).state !== 'disconnected'
      ? [{ label: t('sourceActions.disconnect'), icon: <UnlinkIcon />, onSelect: () => onDisconnect(source) }]
      : []),
    { label: t('sourceActions.edit'), icon: <PencilIcon />, onSelect: () => setDialog({ kind: 'edit', source }) },
    { label: t('sourceActions.duplicate'), icon: <DuplicateIcon />, onSelect: () => void run(() => core.duplicateSource(source.id)) },
    { label: t('sourceActions.delete'), icon: <TrashIcon />, onSelect: () => setDialog({ kind: 'delete', source }), danger: true }
  ]

  const sourceRowProps = (source: SourceInfo): HTMLAttributes<HTMLDivElement> => ({
    draggable: true,
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

  /**
   * Moves the keyboard between rows: every Source's rows, in order, as one list. A row handles its own keys
   * (Enter, Space, opening and closing a folder) first; typing a name jumps to the next row starting with it.
   */
  const onTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || target.getAttribute('role') !== 'treeitem') return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    const rows = items.map(treeRowOf)
    const index = items.indexOf(target)
    const typed = event.key.length === 1 && event.key !== ' '
    const to = typed ? typeAheadTarget(rows, index, typeAhead.type(event.key)) : treeFocusTarget(rows, index, event.key)
    if (!typed) typeAhead.reset()
    if (!typed && !treeNavigationKeys.includes(event.key)) return
    // Arrows, Home and End would scroll the sidebar besides.
    event.preventDefault()
    if (to !== null) items[to]!.focus()
  }

  const isEmpty = sources.length === 0

  return (
    <nav ref={ref} className="sidebar" aria-label={t('sidebar.heading')}>
      <header className="sidebar__header">
        <h2 className="sidebar__heading">{t('sidebar.heading')}</h2>
        {/* Next to the heading and solid, so it isn't taken for one of the view controls on the right. */}
        <button
          type="button"
          className="add-source"
          aria-label={t('sidebar.add')}
          title={t('sidebar.add')}
          onClick={() => setDialog({ kind: 'add' })}
        >
          <PlusIcon />
        </button>
        <span className="sidebar__actions">
          {!isEmpty && (
            <button
              type="button"
              className="icon-button"
              aria-label={t('sidebar.showDetails')}
              aria-pressed={showDetails}
              title={t('sidebar.showDetails')}
              onClick={onToggleDetails}
            >
              <DetailsIcon />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={t(theme === 'dark' ? 'sidebar.lightTheme' : 'sidebar.darkTheme')}
            title={t(theme === 'dark' ? 'sidebar.lightTheme' : 'sidebar.darkTheme')}
            onClick={onToggleTheme}
          >
            <ThemeIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('sidebar.settings')}
            title={t('sidebar.settingsTooltip', { shortcut: settingsShortcut })}
            onClick={onOpenSettings}
          >
            <GearIcon />
          </button>
        </span>
      </header>

      {error && (
        <p className="sidebar__error" role="alert">
          {error}
        </p>
      )}

      <div className="sidebar__sources" onKeyDown={onTreeKeyDown}>
        {isEmpty && (
          <div className="sidebar__empty">
            <p className="sidebar__empty-title">{t('sidebar.empty.title')}</p>
            <p className="sidebar__empty-body">{t('sidebar.empty.body')}</p>
          </div>
        )}
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
                  // A new target means a new tree: nothing expanded under the old one carries over.
                  key={`${source.id}:${targetOf(source)}`}
                  source={source}
                  connection={connections.get(source.id) ?? disconnected}
                  environment={environmentOf(environments, source)}
                  onConnect={() => onConnect(source)}
                  sourceActions={sourceActions(source)}
                  onContextMenu={openMenu}
                  selectedKey={selectedKey}
                  onSelect={setSelectedKey}
                  onOpenFile={onOpenFile}
                  onOpenLog={onOpenLog}
                  onFollowFile={onFollowFile}
                  sourceRowProps={sourceRowProps(source)}
                  treeProps={treeProps(source, group)}
                  showDetails={showDetails}
                  theme={theme}
                />
              ))}
            </section>
          )
        })}
      </div>

      {menu && (
        <ContextMenu label={menu.label} x={menu.x} y={menu.y} onClose={closeMenu} items={menu.items} />
      )}

      {(dialog?.kind === 'add' || dialog?.kind === 'edit') && (
        <SourceDialog
          editing={dialog.kind === 'edit' ? dialog.source : undefined}
          environments={environments}
          onManageEnvironments={onManageEnvironments}
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
