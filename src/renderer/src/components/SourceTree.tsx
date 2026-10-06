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
import type {
  ConnectionState,
  ContainerNode,
  ContainerRole,
  EntryNode,
  Environment,
  FoldedNode,
  LogNode,
  PodNode,
  PodStatus,
  ReadyCount,
  SourceInfo,
  SourcePath,
  TreeNode
} from '@shared/core-api'
import type { Theme } from '@shared/settings'
import { core, describeError, describeFailure } from '../core-client'
import { t } from '../i18n'
import { formatDateTime, formatRelativeTime, formatSize } from '../i18n/format'
import { uiFor } from '../source-types'
import { followsFiles } from '../workspace'
import type { MenuItem } from './ContextMenu'
import { EnvironmentBadge } from './EnvironmentBadge'
import { ChevronIcon, ReloadIcon, WarningIcon } from './icons'
import { KubernetesIcon } from './KubernetesIcon'
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
  /** The row selected in the sidebar, which is where the keyboard is too when it's in the sidebar. */
  selectedKey: string | null
  onSelect(key: string): void
  /** Opens a file in the preview tab, or in a tab of its own when pinned. */
  onOpenFile(source: SourceInfo, node: EntryNode, options?: { pinned: boolean }): void
  /** Opens a container's Log Stream in the preview tab, or in a tab of its own when pinned. */
  onOpenLog(source: SourceInfo, node: ContainerNode, options?: { pinned: boolean }): void
  /** Follows a file of a Local or Kubernetes Files Source in a log view; without it, files offer no Follow. */
  onFollowFile?(source: SourceInfo, node: EntryNode): void
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

/** What a tree shows as a row: a File Source's folders and files, or a Log Source's groups, Workloads, pods and containers. */
type ShownNode = EntryNode | LogNode

const isLogNode = (node: ShownNode): node is LogNode => node.kind !== 'folder' && node.kind !== 'file'

/** A listing once loaded, or once it failed, keeps the level folded into its node, if any (see FoldedNode). */
type Listing =
  | { state: 'loading' }
  | { state: 'loaded'; nodes: ShownNode[]; more?: More; folded?: FoldedNode }
  | { state: 'failed'; message: string; folded?: FoldedNode }

/** A page of listed nodes as a listing, or a failed one if it's an error node; `before` are the pages loaded already. */
function listingOf(page: TreeNode[], before: ShownNode[] = []): Listing {
  const folded = page.find((n) => n.kind === 'folded')
  const withFolded = folded && { folded }
  const failure = page.find((n) => n.kind === 'error')
  if (failure) return { state: 'failed', message: describeFailure(failure), ...withFolded }
  const more = page.find((n) => n.kind === 'more')
  const entries = [...before, ...page.filter((n): n is ShownNode => n.kind !== 'error' && n.kind !== 'more' && n.kind !== 'folded')]
  // Each page comes folders first; joined, a later page's folders still go ahead of every file.
  const nodes = [...entries.filter((n) => n.kind === 'folder'), ...entries.filter((n) => n.kind !== 'folder')]
  const moreOf = more && { more: { cursor: more.cursor, state: 'idle' } as const }
  return { state: 'loaded', nodes, ...moreOf, ...withFolded }
}

/** The level folded into a listing, null if none is; undefined while it's loading, or if it failed before telling. */
const foldedOf = (listing: Listing | undefined) =>
  !listing || listing.state === 'loading' ? undefined
  : listing.folded ? listing.folded
  : listing.state === 'failed' ? undefined
  : null

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
  const { source, connection, onConnect, sourceActions, onContextMenu, selectedKey, onSelect, onOpenFile, onOpenLog, onFollowFile } = props
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

  // A root that folds in another level than before (a Workload's one pod replaced, say) collapses everything below
  // it: their paths went through the level it folded in.
  const rootFolded = foldedOf(listings.get(''))
  const rootFoldedPath = rootFolded === undefined ? undefined : (rootFolded?.path ?? '')
  const lastRootFolded = useRef(rootFoldedPath)
  useEffect(() => {
    if (rootFoldedPath === undefined) return
    const before = lastRootFolded.current
    lastRootFolded.current = rootFoldedPath
    if (before === undefined || before === rootFoldedPath) return
    setExpanded((prev) => new Set([...prev].filter((path) => path === '')))
    setListings((prev) => new Map([...prev].filter(([path]) => path === '')))
  }, [rootFoldedPath])

  const setListing = (path: SourcePath, listing: Listing) => setListings((prev) => new Map(prev).set(path, listing))

  const load = (path: SourcePath) => {
    const loadedIn = generation.current
    const settle = (listing: Listing) => loadedIn === generation.current && setListing(path, listing)
    setListing(path, { state: 'loading' })
    core.expand(source.id, path).then(
      (nodes) => {
        settle(listingOf(nodes))
        // The pod folded into the root is gone: the root lists what's there now instead.
        const inFolded = rootFolded && path.startsWith(`${rootFolded.path}/`)
        const podGone = nodes.some((n) => n.kind === 'error' && n.code === 'POD_GONE')
        if (inFolded && podGone && loadedIn === generation.current) load('')
      },
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

  /** Reloads a folder's (or other node's) children and makes sure they're shown. */
  const refreshNode = (path: SourcePath) => {
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

  // The tree is one stop for Tab: its selected row, if it's shown, or else the Source's own row.
  let selectedShown = false

  const row = (props: RowProps) => {
    const { path, depth, label, icon, folder, onActivate, onDoubleActivate, menuItems, status, badge, details, actions, labelledBy } = props
    const { className = '', extra } = props
    const key = nodeKey(source.id, path)
    const isExpanded = folder && expanded.has(path)
    const selected = selectedKey === key
    if (selected) selectedShown = true
    const activate = () => {
      onSelect(key)
      onActivate()
    }
    // Enter opens a file in a tab of its own, like a double-click; Space previews it, like a click. On a
    // folder, either opens or closes it, as do Right and Left; the sidebar moves between rows with the rest.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const pressed = event.key
      const toggles = (pressed === 'ArrowRight' && folder && !isExpanded) || (pressed === 'ArrowLeft' && isExpanded)
      if (pressed !== 'Enter' && pressed !== ' ' && !toggles) return
      event.preventDefault()
      if (pressed === 'Enter' && onDoubleActivate) {
        onSelect(key)
        onDoubleActivate()
      } else activate()
    }
    const openMenu = (event: MouseEvent<HTMLElement>) => {
      if (menuItems?.length) onContextMenu(event, t('tree.menuLabel', { name: label }), menuItems)
    }
    return (
      <div
        {...extra}
        key={key}
        role="treeitem"
        tabIndex={selected || (path === '' && !selectedShown) ? 0 : -1}
        aria-level={depth + 1}
        aria-expanded={folder ? isExpanded : undefined}
        aria-selected={selected}
        aria-labelledby={labelledBy}
        className={`tree-row ${className} ${extra?.className ?? ''}`}
        style={depthStyle(depth)}
        onClick={activate}
        onDoubleClick={onDoubleActivate}
        onKeyDown={onKeyDown}
        // Moving to a row selects it; focus reaching one of its buttons doesn't.
        onFocus={(event) => event.target === event.currentTarget && !selected && onSelect(key)}
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

  /** Where the entry really is and, when known, exactly when it was last modified; for a pod, how it's doing. */
  const tooltip = (node: ShownNode) => {
    const where = uiFor(source.type).fullPath(source, node.path)
    if (node.kind === 'pod') return podTooltip(node.path, node.status)
    if ('kubernetes' in node && node.kubernetes?.kind === 'pod') return podTooltip(node.path, node.kubernetes.status)
    if (!('modifiedTime' in node) || node.modifiedTime === undefined) return where
    return `${where}\n${t('tree.modified', { time: formatDateTime(node.modifiedTime) })}`
  }

  /** Where a pod's folder or node is, and how the pod is doing. */
  const podTooltip = (path: SourcePath, status: PodStatus) => [uiFor(source.type).fullPath(source, path), ...podStatusLines(status)].join('\n')

  /** A pod's status, and when and why it last restarted if it has. */
  const podStatusLines = ({ reason, restarts, lastRestart, lastTerminationReason }: PodStatus) => [
    t('pod.status', { reason }),
    ...(restarts > 0 ? [t('pod.restarts', { count: restarts })] : []),
    ...(lastRestart !== undefined ? [t('pod.lastRestart', { time: formatDateTime(lastRestart) })] : []),
    ...(lastTerminationReason ? [t('pod.lastTermination', { reason: lastTerminationReason })] : [])
  ]

  /** ↻ N, for a pod or container that has restarted N times. */
  const restartBadge = (restarts: number) => {
    const label = t('pod.restarts', { count: restarts })
    return (
      <span className="restart-badge" role="img" aria-label={label} title={label}>
        ↻ {restarts}
      </span>
    )
  }

  /** A pod's status dot, coloured by its health, after its restart badge if it has one container and that has restarted. */
  const podIndicators = ({ status, containerCount }: Pick<PodNode, 'status' | 'containerCount'>) => (
    <span className="tree-row__indicators">
      {containerCount === 1 && status.restarts > 0 && restartBadge(status.restarts)}
      <span className={`pod-status pod-status--${status.health}`} role="img" aria-label={t('pod.status', { reason: status.reason })} />
    </span>
  )

  /** A Workload's Ready Count, marked when fewer are ready than it wants. */
  const readyCount = ({ ready, desired }: ReadyCount) => (
    <span className="tree-row__indicators">
      <span className={`ready-count ${ready < desired ? 'is-short' : ''}`} title={t('workload.readyCount.tooltip', { ready, desired })}>
        {ready}/{desired}
      </span>
    </span>
  )

  /** Whether the pod a container is in has other containers, going by the pod's listed node. */
  const inSeveralContainers = (container: SourcePath) => {
    const pod = container.slice(0, container.lastIndexOf('/'))
    const listing = listings.get(pod.slice(0, Math.max(0, pod.lastIndexOf('/'))))
    const node = listing?.state === 'loaded' ? listing.nodes.find((n) => n.path === pod) : undefined
    return node?.kind === 'pod' && node.containerCount > 1
  }

  /** A container's role, labelled after its name. */
  const roleBadge = (role: ContainerRole | undefined) =>
    role && (
      <span className="tree-row__role" title={t(`containerRole.${role}.tooltip`)}>
        {t(`containerRole.${role}`)}
      </span>
    )

  /** A Log Source's node: groups, Workloads and pods expand like folders; a container opens its Log Stream. */
  const logRow = (node: LogNode, depth: number) => {
    const refresh = { label: t('sourceActions.refresh'), onSelect: () => refreshNode(node.path) }
    const common = { path: node.path, depth, extra: { title: tooltip(node) } }
    if (node.kind === 'container') {
      const role = roleBadge(node.role)
      // A pod with one container carries its restarts itself; with several, each container carries its own.
      const restarts = node.restarts && inSeveralContainers(node.path) ? node.restarts : 0
      return row({
        ...common,
        label: node.name,
        folder: false,
        icon: <KubernetesIcon container role={node.role} />,
        onActivate: () => onOpenLog(source, node),
        onDoubleActivate: () => onOpenLog(source, node, { pinned: true }),
        badge: role,
        status: restarts > 0 ? <span className="tree-row__indicators">{restartBadge(restarts)}</span> : undefined
      })
    }
    const status =
      node.kind === 'pod' ? podIndicators(node)
      : node.kind === 'workload' && node.readyCount ? readyCount(node.readyCount)
      : undefined
    return row({
      ...common,
      label: node.kind === 'group' ? t(`workloadGroup.${node.workloadKind}`) : node.name,
      folder: true,
      icon: <KubernetesIcon workloadKind={node.kind === 'pod' ? 'Pod' : node.workloadKind} />,
      onActivate: () => toggle(node.path),
      menuItems: [refresh],
      status
    })
  }

  /** What an empty listing says: a namespace or node of a Log Source has no folders to be empty. */
  const emptyNote = (path: SourcePath) =>
    source.type === 'kubernetesFiles' && !path && !rootFolded ? 'tree.noPods'
    : source.type !== 'kubernetesLogs' ? 'tree.emptyFolder'
    : path ? 'tree.emptyLogNode'
    : 'tree.emptyNamespace'

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
    if (listing.nodes.length === 0 && !listing.more) return [note(path, depth, t(emptyNote(path)))]
    const rows = listing.nodes.flatMap((node) => {
      if (isLogNode(node)) {
        const self = logRow(node, depth)
        return node.kind !== 'container' && expanded.has(node.path) ? [self, ...renderChildren(node.path, depth + 1)] : [self]
      }
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
      // A Kubernetes Files Source's pods and containers are folders, shown the way the Logs tree shows them.
      const { kubernetes } = node
      const self = row({
        path: node.path,
        depth,
        label: node.name,
        folder: isFolder,
        icon:
          kubernetes?.kind === 'pod' ? <KubernetesIcon workloadKind="Pod" />
          : kubernetes?.kind === 'container' ? <KubernetesIcon container role={kubernetes.role} />
          : <MaterialIcon icon={node.icon} theme={theme} open={isFolder && expanded.has(node.path)} />,
        badge: kubernetes?.kind === 'container' ? roleBadge(kubernetes.role) : undefined,
        status: kubernetes?.kind === 'pod' ? podIndicators(kubernetes) : undefined,
        onActivate: () => (isFolder ? toggle(node.path) : onOpenFile(source, node)),
        onDoubleActivate: isFolder ? undefined : () => onOpenFile(source, node, { pinned: true }),
        menuItems:
          isFolder ? [{ label: t('sourceActions.refresh'), onSelect: () => refreshNode(node.path) }]
          : followsFiles(source) && onFollowFile ? [{ label: t('tree.follow'), onSelect: () => onFollowFile(source, node) }]
          : undefined,
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
    ...(connected ? [{ label: t('sourceActions.refresh'), icon: <ReloadIcon />, onSelect: () => refreshNode('') }] : []),
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
  // Always there while verification is off, connected or not, so it's never forgotten.
  const tlsOff = source.type === 's3' && !source.verifyTls
  const badges = (
    <>
      {tlsOff && (
        <span id={`${id}-tls`} className="tls-badge" role="img" aria-label={t('tree.tlsOff.tooltip')} title={t('tree.tlsOff.tooltip')}>
          <WarningIcon />
          {t('tree.tlsOff')}
        </span>
      )}
      {environment && <EnvironmentBadge id={`${id}-badge`} environment={environment} />}
    </>
  )

  // Rendered ahead of the Source's own row, so that row knows whether the selected one is among them.
  const children = connected && expanded.has('') ? renderChildren('', 1) : null
  // A level folded into the root, like a Workload's one pod, has no row: the Source's tooltip tells of it instead.
  const foldedTooltip = connected && rootFolded?.kubernetes?.kind === 'pod' ? podTooltip(rootFolded.path, rootFolded.kubernetes.status) : undefined

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
        badge: badges,
        actions: actionButtons,
        labelledBy: [`${id}-label`, tlsOff && `${id}-tls`, environment && `${id}-badge`].filter(Boolean).join(' '),
        className: `tree-row--source ${connectError ? 'is-error' : ''}`,
        extra: { ...sourceRowProps, title: connectError ?? foldedTooltip }
      })}
      {children}
    </div>
  )
}
