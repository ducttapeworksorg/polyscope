import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import type { ConnectionState, EntryNode, Environment, SourceInfo, SourcePath, TreeNode } from '@shared/core-api'
import type { Theme } from '@shared/settings'
import { core, describeError, describeFailure } from '../core-client'
import { t } from '../i18n'
import { formatDateTime, formatRelativeTime, formatSize } from '../i18n/format'
import { uiFor } from '../source-types'
import type { MenuItem } from './ContextMenu'
import { EnvironmentBadge } from './EnvironmentBadge'
import { ChevronIcon, ReloadIcon, WarningIcon } from './icons'
import { MaterialIcon } from './MaterialIcon'

interface Props {
  source: SourceInfo
  connection: ConnectionState
  /** The Environment the Source is labelled with, shown as a badge after its name. */
  environment?: Environment
  /** Connects the Source, resolving to its root's children or null if it couldn't connect. */
  onConnect(): Promise<TreeNode[] | null>
  /** Buttons at the end of the Source's own row; the tree puts its own, like Refresh, ahead of them. */
  sourceActions: SourceAction[]
  onContextMenu(event: MouseEvent<HTMLElement>, label: string, items: MenuItem[]): void
  selectedKey: string | null
  onSelect(key: string): void
  /** Opens a file in the preview tab, or in a tab of its own when pinned. */
  onOpenFile(source: SourceInfo, node: EntryNode, options?: { pinned: boolean }): void
  /** Extra attributes for the Source's own row, e.g. for dragging it. */
  sourceRowProps?: HTMLAttributes<HTMLDivElement>
  /** Extra attributes for the whole tree, e.g. to make it a drop target. */
  treeProps?: HTMLAttributes<HTMLDivElement>
  /** Whether entries show their size and modified time after their name. */
  showDetails: boolean
  theme: Theme
}

/** One of a Source's actions, offered as an icon button on its row. */
export interface SourceAction {
  label: string
  icon: ReactNode
  onSelect(): void
  /** Destructive, like Delete: tinted as a warning under the pointer. */
  danger?: boolean
}

export const nodeKey = (sourceId: string, path: SourcePath) => `${sourceId}:${path}`

/** The rest of a folder too long to list at once: what lists its next page, and how that's going. */
type More =
  | { cursor: string; state: 'idle' }
  | { cursor: string; state: 'loading' }
  | { cursor: string; state: 'failed'; message: string }

type Listing = { state: 'loading' } | { state: 'loaded'; nodes: EntryNode[]; more?: More } | { state: 'failed'; message: string }

/** A page of listed nodes as a listing, or a failed one if it's an error node; `before` are the pages loaded already. */
function listingOf(page: TreeNode[], before: EntryNode[] = []): Listing {
  const failure = page.find((n) => n.kind === 'error')
  if (failure) return { state: 'failed', message: describeFailure(failure) }
  const more = page.find((n) => n.kind === 'more')
  const entries = [...before, ...page.filter((n): n is EntryNode => n.kind === 'folder' || n.kind === 'file')]
  // Each page comes folders first; joined, a later page's folders still go ahead of every file.
  const nodes = [...entries.filter((n) => n.kind === 'folder'), ...entries.filter((n) => n.kind === 'file')]
  return more ? { state: 'loaded', nodes, more: { cursor: more.cursor, state: 'idle' } } : { state: 'loaded', nodes }
}

interface RowProps {
  path: SourcePath
  depth: number
  label: string
  icon: ReactNode
  folder: boolean
  onActivate(): void
  /** What a double-click does beyond activating twice, e.g. pinning a file's tab. */
  onDoubleActivate?(): void
  menuItems?: MenuItem[]
  status?: ReactNode
  /** Shown right after the name, e.g. the Source's Environment badge. */
  badge?: ReactNode
  /** Size and modified time, dimmed after the name. */
  details?: ReactNode
  /** Buttons at the end of the row, e.g. the Source's actions. */
  actions?: ReactNode
  /** Names the row by these elements, when its content holds more than its name (like buttons). */
  labelledBy?: string
  className?: string
  extra?: HTMLAttributes<HTMLDivElement>
}

const depthStyle = (depth: number) => ({ '--depth': depth }) as CSSProperties

/** The current time, updated every minute while `ticking`, so relative times like '5 min. ago' keep up. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

export function SourceTree(props: Props) {
  const { source, connection, onConnect, sourceActions, onContextMenu, selectedKey, onSelect, onOpenFile } = props
  const { sourceRowProps, treeProps, showDetails, theme, environment } = props
  const now = useNow(showDetails)
  const id = useId()
  const [expanded, setExpanded] = useState<ReadonlySet<SourcePath>>(new Set())
  const [listings, setListings] = useState<ReadonlyMap<SourcePath, Listing>>(new Map())
  // Bumped whenever the connection is lost, so listings still on their way from it are ignored.
  const generation = useRef(0)
  const connected = connection.state === 'connected'

  // Losing the connection drops everything loaded through it; the next expand starts afresh.
  useEffect(() => {
    if (connection.state !== 'disconnected' && connection.state !== 'error') return
    generation.current++
    setExpanded(new Set())
    setListings(new Map())
  }, [connection.state])

  const setListing = (path: SourcePath, listing: Listing) => setListings((prev) => new Map(prev).set(path, listing))

  const load = (path: SourcePath) => {
    const loadedIn = generation.current
    const settle = (listing: Listing) => loadedIn === generation.current && setListing(path, listing)
    setListing(path, { state: 'loading' })
    core.expand(source.id, path).then(
      (nodes) => settle(listingOf(nodes)),
      (error) => settle({ state: 'failed', message: describeError(error) })
    )
  }

  /** Lists the next page of a long folder after the pages already shown. */
  const loadMore = (path: SourcePath) => {
    const listing = listings.get(path)
    if (listing?.state !== 'loaded' || !listing.more || listing.more.state === 'loading') return
    const { cursor } = listing.more
    const loadedIn = generation.current
    // Only the listing this page continues is updated: a refresh meanwhile has replaced it.
    const settle = (next: (current: Extract<Listing, { state: 'loaded' }>) => Listing) =>
      setListings((prev) => {
        const current = prev.get(path)
        if (loadedIn !== generation.current || current?.state !== 'loaded' || current.more?.cursor !== cursor) return prev
        return new Map(prev).set(path, next(current))
      })
    settle((current) => ({ ...current, more: { cursor, state: 'loading' } }))
    core.expand(source.id, path, cursor).then(
      (page) =>
        settle((current) => {
          const next = listingOf(page, current.nodes)
          return next.state === 'failed' ? { ...current, more: { cursor, state: 'failed', message: next.message } } : next
        }),
      (error) => settle((current) => ({ ...current, more: { cursor, state: 'failed', message: describeError(error) } }))
    )
  }

  /** Reloads a folder's children and makes sure they're shown. */
  const refresh = (path: SourcePath) => {
    setExpanded((prev) => new Set(prev).add(path))
    load(path)
  }

  const toggle = (path: SourcePath) => {
    const next = new Set(expanded)
    if (next.delete(path)) return setExpanded(next)
    setExpanded(next.add(path))
    const listing = listings.get(path)
    if (!listing || listing.state === 'failed') load(path)
  }

  // A Source that isn't Connected connects on expanding; after a failure, expanding again retries.
  const toggleSource = async () => {
    if (connected) return toggle('')
    if (connection.state === 'connecting') return
    const nodes = await onConnect()
    if (!nodes) return
    setListing('', listingOf(nodes))
    setExpanded((prev) => new Set(prev).add(''))
  }

  const row = (props: RowProps) => {
    const { path, depth, label, icon, folder, onActivate, onDoubleActivate, menuItems, status, badge, details, actions, labelledBy } = props
    const { className = '', extra } = props
    const key = nodeKey(source.id, path)
    const isExpanded = folder && expanded.has(path)
    const activate = () => {
      onSelect(key)
      onActivate()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      activate()
    }
    const openMenu = (event: MouseEvent<HTMLElement>) => {
      if (menuItems?.length) onContextMenu(event, t('tree.menuLabel', { name: label }), menuItems)
    }
    return (
      <div
        {...extra}
        key={key}
        role="treeitem"
        tabIndex={0}
        aria-level={depth + 1}
        aria-expanded={folder ? isExpanded : undefined}
        aria-selected={selectedKey === key}
        aria-labelledby={labelledBy}
        className={`tree-row ${className} ${extra?.className ?? ''}`}
        style={depthStyle(depth)}
        onClick={activate}
        onDoubleClick={onDoubleActivate}
        onKeyDown={onKeyDown}
        onContextMenu={openMenu}
      >
        <span className={`tree-row__twisty ${isExpanded ? 'is-open' : ''}`}>{folder && <ChevronIcon />}</span>
        <span className="tree-row__icon">{icon}</span>
        <span className="tree-row__label" id={labelledBy && `${id}-label`}>
          {label}
        </span>
        {badge}
        {details}
        {status}
        {actions}
      </div>
    )
  }

  /** Size and relative modified time, each only if the Source reported it. */
  const details = ({ size, modifiedTime }: EntryNode) =>
    size === undefined && modifiedTime === undefined ? undefined : (
      <span className="tree-row__details">
        {size !== undefined && <span>{formatSize(size)}</span>}
        {modifiedTime !== undefined && <span>{formatRelativeTime(modifiedTime, now)}</span>}
      </span>
    )

  /** Where the entry really is and, when known, exactly when it was last modified. */
  const tooltip = (node: EntryNode) => {
    const where = uiFor(source.type).fullPath(source, node.path)
    return node.modifiedTime === undefined ? where : `${where}\n${t('tree.modified', { time: formatDateTime(node.modifiedTime) })}`
  }

  const note = (path: SourcePath, depth: number, children: ReactNode, className = '') => (
    <div key={`${path}#note`} className={`tree-note ${className}`} style={depthStyle(depth)}>
      {children}
    </div>
  )

  const renderChildren = (path: SourcePath, depth: number): ReactNode[] => {
    const listing = listings.get(path)
    if (!listing || listing.state === 'loading') return [note(path, depth, t('tree.loading'))]
    if (listing.state === 'failed') {
      const content = (
        <>
          <span className="tree-note__message" title={listing.message}>
            {listing.message}
          </span>
          <button type="button" className="link-button" onClick={() => load(path)}>
            {t('tree.retry')}
          </button>
        </>
      )
      return [note(path, depth, content, 'tree-note--error')]
    }
    if (listing.nodes.length === 0 && !listing.more) return [note(path, depth, t('tree.emptyFolder'))]
    const rows = listing.nodes.flatMap((node) => {
      if (node.problem) {
        const reason = describeFailure(node.problem)
        return [
          row({
            path: node.path,
            depth,
            label: node.name,
            folder: false,
            icon: <WarningIcon />,
            onActivate: () => undefined,
            status: <span className="tree-row__problem">{reason}</span>,
            className: 'has-problem',
            extra: { title: reason, 'aria-description': reason }
          })
        ]
      }
      const isFolder = node.kind === 'folder'
      const self = row({
        path: node.path,
        depth,
        label: node.name,
        folder: isFolder,
        icon: <MaterialIcon icon={node.icon} theme={theme} open={isFolder && expanded.has(node.path)} />,
        onActivate: () => (isFolder ? toggle(node.path) : onOpenFile(source, node)),
        onDoubleActivate: isFolder ? undefined : () => onOpenFile(source, node, { pinned: true }),
        menuItems: isFolder ? [{ label: t('sourceActions.refresh'), onSelect: () => refresh(node.path) }] : undefined,
        details: showDetails ? details(node) : undefined,
        extra: { title: tooltip(node) }
      })
      return isFolder && expanded.has(node.path) ? [self, ...renderChildren(node.path, depth + 1)] : [self]
    })
    return listing.more ? [...rows, moreNote(path, depth, listing.more)] : rows
  }

  /** Where a long folder's listing stops: a way to list the next page, or how that's going. */
  const moreNote = (path: SourcePath, depth: number, more: More) => {
    if (more.state === 'loading') return note(`${path}#more`, depth, t('tree.loading'))
    const button = (label: string) => (
      <button type="button" className="link-button" onClick={() => loadMore(path)}>
        {label}
      </button>
    )
    if (more.state === 'idle') return note(`${path}#more`, depth, button(t('tree.loadMore')))
    const content = (
      <>
        <span className="tree-note__message" title={more.message}>
          {more.message}
        </span>
        {button(t('tree.retry'))}
      </>
    )
    return note(`${path}#more`, depth, content, 'tree-note--error')
  }

  const actions: SourceAction[] = [
    ...(connected ? [{ label: t('sourceActions.refresh'), icon: <ReloadIcon />, onSelect: () => refresh('') }] : []),
    ...sourceActions
  ]
  // The buttons are the row's own controls: using one neither toggles, selects nor drags the row.
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation()
  const actionButtons = (
    <span className="tree-row__actions" onClick={stop} onDoubleClick={stop} onKeyDown={stop}>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className={`icon-button ${action.danger ? 'icon-button--danger' : ''}`}
          aria-label={action.label}
          title={action.label}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          onClick={action.onSelect}
        >
          {action.icon}
        </button>
      ))}
    </span>
  )

  const { Icon } = uiFor(source.type)
  const connectError = connection.state === 'error' ? t('tree.connectFailed', { message: describeFailure(connection) }) : null
  const status =
    connection.state === 'connecting' ? (
      <span className="tree-row__status">{t('tree.connecting')}</span>
    ) : connectError ? (
      <span className="tree-row__status tree-row__status--error" role="img" aria-label={connectError}>
        <WarningIcon />
      </span>
    ) : null

  return (
    <div {...treeProps} role="tree" aria-label={source.name} className={`source-tree ${treeProps?.className ?? ''}`}>
      {row({
        path: '',
        depth: 0,
        label: source.name,
        folder: true,
        icon: <Icon />,
        onActivate: () => void toggleSource(),
        status,
        badge: environment && <EnvironmentBadge id={`${id}-badge`} environment={environment} />,
        actions: actionButtons,
        labelledBy: environment ? `${id}-label ${id}-badge` : `${id}-label`,
        className: `tree-row--source ${connectError ? 'is-error' : ''}`,
        extra: { ...sourceRowProps, title: connectError ?? undefined }
      })}
      {connected && expanded.has('') && renderChildren('', 1)}
    </div>
  )
}
