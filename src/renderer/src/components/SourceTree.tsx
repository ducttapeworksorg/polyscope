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
  ContainerRole,
  EntryNode,
  Environment,
  FoldedNode,
  HostKey,
  LogNode,
  LogStreamNode,
  NodeStatus,
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
import { ChevronIcon, ContainerIcon, KeyIcon, ReloadIcon, WarningIcon } from './icons'
import { KubernetesIcon } from './KubernetesIcon'
import { MaterialIcon } from './MaterialIcon'

interface Props {
  source: SourceInfo
  connection: ConnectionState
  /** The Environment the Source is labelled with, shown as a badge after its name. */
  environment?: Environment
  /** Connects the Source, resolving to its root's children or null if it couldn't connect. */
  onConnect(): Promise<TreeNode[] | null>
  /**
   * Asks whether to trust an SSH server's host key, which connecting found unknown, and trusts it if so: resolves to
   * whether it's trusted now. Without it, a Source in Error offers no trust step.
   */
  onTrustHostKey?(hostKey: HostKey): Promise<boolean>
  /** Buttons at the end of the Source's own row; the tree puts its own, like Refresh, ahead of them. */
  sourceActions: SourceAction[]
  onContextMenu(event: MouseEvent<HTMLElement>, label: string, items: MenuItem[]): void
  /** The row selected in the sidebar, which is where the keyboard is too when it's in the sidebar. */
  selectedKey: string | null
  onSelect(key: string): void
  /** Opens a file in the preview tab, or in a tab of its own when pinned. */
  onOpenFile(source: SourceInfo, node: EntryNode, options?: { pinned: boolean }): void
  /** Opens a Log Stream in the preview tab, or in a tab of its own when pinned. */
  onOpenLog(source: SourceInfo, node: LogStreamNode, options?: { pinned: boolean }): void
  /** Follows a file of a Local, Kubernetes Files or SSH Files Source in a log view; without it, files offer no Follow. */
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

/** What a tree shows as a row: a File Source's folders and files, or a Log Source's groups and Log Streams. */
type ShownNode = EntryNode | LogNode

const isLogNode = (node: ShownNode): node is LogNode => node.kind !== 'folder' && node.kind !== 'file'

/** Whether a Log Source's node opens its log rather than expanding: a Log Stream without children. */
const opensLog = (node: LogNode): node is LogStreamNode => node.kind === 'logStream' && !node.hasChildren

/** Whether a Log Source's node may fold its only child into it: a group, unless it never folds (Kubernetes' groups of Workloads). */
const canFold = (node: LogNode) => node.kind === 'group' && !node.unfoldable

/** A Log Source level's only child, if its listing has loaded with just the one. */
const onlyChild = (listing: Listing | undefined) =>
  listing?.state === 'loaded' && !listing.more && listing.nodes.length === 1 ? listing.nodes[0] : undefined

/** The level a Log Source's node carries folded in, as it was listed: a CronJob's only Job, a Workload's only pod, a pod's only container. */
const carriedFold = (node: LogNode): LogNode | undefined => (node.kind === 'group' ? node.folded : undefined)

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
  const { sourceRowProps, treeProps, showDetails, theme, environment, onTrustHostKey } = props
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
        // A node folds just as it's listed now, and so do the levels folded into it: what their own rows listed
        // before is out of date. The last level's children stay, as an open folder's do.
        if (loadedIn === generation.current) {
          setListings((prev) => {
            const outdated = (n: LogNode): SourcePath[] => {
              const folded = carriedFold(n)
              if (folded) return [n.path, ...outdated(folded)]
              // Folding nothing in, a level keeps its own listing (an open folder's children), unless that says it does.
              const own = prev.get(n.path)
              return canFold(n) && own?.state === 'loaded' && onlyChild(own) ? [n.path] : []
            }
            const stale = new Set(nodes.flatMap((n) => (n.kind === 'group' || n.kind === 'logStream' ? outdated(n) : [])))
            return stale.size > 0 ? new Map([...prev].filter(([listed]) => !stale.has(listed))) : prev
          })
        }
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

  /** Opens or closes a row; what it shows when open is `listed`'s children, its own unless it stands in for a level folded into it. */
  const toggle = (path: SourcePath, listed = path) => {
    const next = new Set(expanded)
    if (next.delete(path)) return setExpanded(next)
    setExpanded(next.add(path))
    const listing = listings.get(listed)
    if (!listing || listing.state === 'failed') load(listed)
  }

  /**
   * A Log Source's node and the levels folded into it, down to the one its row stands in for. A level's own listing,
   * once loaded, says what it folds now (a Refresh during a rollout, say); until then, what it was listed carrying.
   * A level whose listing failed folds nothing, so its row shows why.
   */
  const foldedChain = (node: LogNode): LogNode[] => {
    const listing = listings.get(node.path)
    const only = onlyChild(listing)
    const next =
      !canFold(node) ? undefined
      : !listing || listing.state === 'loading' ? carriedFold(node)
      : only && isLogNode(only) ? only
      : undefined
    return next ? [node, ...foldedChain(next)] : [node]
  }

  /** Whether a Log Source's level has nothing under it: as its own listing says once loaded, else as it was listed. */
  const isEmpty = (level: LogNode) => {
    const listing = listings.get(level.path)
    if (listing?.state === 'loaded') return listing.nodes.length === 0 && !listing.more
    return listing?.state !== 'failed' && Boolean(level.empty)
  }

  /** Re-lists a Log Source's row: its own level, which may now fold differently, and each level folded into it. */
  const refreshLogRow = (chain: LogNode[]) => {
    if (!opensLog(chain.at(-1)!)) setExpanded((prev) => new Set(prev).add(chain[0]!.path))
    for (const level of chain) if (!opensLog(level)) load(level.path)
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

  /**
   * Where the entry really is and, when known, exactly when it was last modified; for a node with a status (a pod, a
   * Docker container), how it's doing; for a CloudWatch log group or stream, what CloudWatch tells of it.
   */
  const tooltip = (node: ShownNode) => {
    const where = uiFor(source.type).fullPath(source, node.path)
    if (isLogNode(node) && node.status) return [statusTooltip(node.path, node.status), ...dockerLines(node), ...unitLines(node)].join('\n')
    if (isLogNode(node) && node.kind === 'logStream' && node.cloudwatch) return [where, ...cloudwatchLines(node.cloudwatch)].join('\n')
    if (!isLogNode(node) && node.kubernetes?.kind === 'pod') return statusTooltip(node.path, node.kubernetes.status)
    if (!('modifiedTime' in node) || node.modifiedTime === undefined) return where
    return `${where}\n${t('tree.modified', { time: formatDateTime(node.modifiedTime) })}`
  }

  /** Where a node (a pod's folder or node, say) is, and how it's doing. */
  const statusTooltip = (path: SourcePath, status: NodeStatus) => [uiFor(source.type).fullPath(source, path), ...statusLines(status)].join('\n')

  /** A node's status, and when and why what it runs last restarted if it has. */
  const statusLines = ({ reason, restarts, lastRestart, lastTerminationReason }: NodeStatus) => [
    t('pod.status', { reason }),
    ...(restarts > 0 ? [t('pod.restarts', { count: restarts })] : []),
    ...(lastRestart !== undefined ? [t('pod.lastRestart', { time: formatDateTime(lastRestart) })] : []),
    ...(lastTerminationReason ? [t('pod.lastTermination', { reason: lastTerminationReason })] : [])
  ]

  /** A Docker container's image, and when it started, or exited if it isn't running. */
  const dockerLines = ({ docker }: LogNode): string[] => {
    if (docker?.kind !== 'container') return []
    const { image, startedAt, finishedAt } = docker
    return [
      ...(image ? [t('container.image', { image })] : []),
      ...(finishedAt !== undefined ? [t('container.exited', { time: formatDateTime(finishedAt) })]
      : startedAt !== undefined ? [t('container.started', { time: formatDateTime(startedAt) })]
      : [])
    ]
  }

  /** What systemd says a unit is. */
  const unitLines = (node: LogNode): string[] =>
    node.kind === 'logStream' && node.systemd?.description ? [t('unit.description', { description: node.systemd.description })] : []

  /** A CloudWatch log group's size and how long it keeps its events, or a log stream's last event time. */
  const cloudwatchLines = (cloudwatch: NonNullable<LogStreamNode['cloudwatch']>): string[] => {
    if (cloudwatch.kind === 'logGroup') {
      const { storedBytes, retentionDays } = cloudwatch
      return [
        ...(storedBytes !== undefined ? [t('logGroup.stored', { size: formatSize(storedBytes) })] : []),
        retentionDays === undefined ? t('logGroup.keptForever') : t('logGroup.retention', { count: retentionDays })
      ]
    }
    const { lastEventTime } = cloudwatch
    return [lastEventTime === undefined ? t('logStream.noEvents') : t('logStream.lastEvent', { time: formatDateTime(lastEventTime) })]
  }

  /** How long ago a CloudWatch log stream last logged, shown like a file's modified time. */
  const lastEventDetails = ({ cloudwatch }: LogStreamNode) =>
    cloudwatch?.kind !== 'logStream' || cloudwatch.lastEventTime === undefined ? undefined : (
      <span className="tree-row__details">
        <span>{formatRelativeTime(cloudwatch.lastEventTime, now)}</span>
      </span>
    )

  /** ↻ N, for a pod or container that has restarted N times. */
  const restartBadge = (restarts: number) => {
    const label = t('pod.restarts', { count: restarts })
    return (
      <span className="restart-badge" role="img" aria-label={label} title={label}>
        ↻ {restarts}
      </span>
    )
  }

  /** A node's status dot (a pod's, a Docker container's), coloured by its health. */
  const statusDot = ({ health, reason }: NodeStatus) => (
    <span className={`pod-status pod-status--${health}`} role="img" aria-label={t('pod.status', { reason })} />
  )

  /** A node's status dot, after its restart badge if it has one Log Stream and that has restarted. */
  const statusIndicators = (status: NodeStatus, oneContainer: boolean) => (
    <>
      {oneContainer && status.restarts > 0 && restartBadge(status.restarts)}
      {statusDot(status)}
    </>
  )

  /** A Workload's Ready Count, marked when fewer are ready than it wants. */
  const readyCount = ({ ready, desired }: ReadyCount) => (
    <span className={`ready-count ${ready < desired ? 'is-short' : ''}`} title={t('workload.readyCount.tooltip', { ready, desired })}>
      {ready}/{desired}
    </span>
  )

  /** What a row shows after its name about how it's doing: restarts, health, Ready Count. */
  const indicators = (content: ReactNode) => <span className="tree-row__indicators">{content}</span>

  /** Whether a Log Stream's parent (a container's pod) has other children, going by those listed under it. */
  const amongSeveral = (logStream: SourcePath) => {
    const listing = listings.get(logStream.slice(0, logStream.lastIndexOf('/')))
    return listing?.state === 'loaded' && listing.nodes.length > 1
  }

  /** What a folded container adds to the tooltip of the row standing in for it: its name, and its role if it has one. */
  const containerLine = (name: string, role: ContainerRole | undefined) =>
    role ? t('pod.containerWithRole', { name, role: t(`containerRole.${role}`) }) : t('pod.container', { name })

  /** What a level folded into a row adds to its tooltip: which Job, pod, container or other node the row stands in for, and how it's doing. */
  const foldedLines = (level: LogNode): string[] => {
    const status = level.status ? statusLines(level.status) : []
    const line =
      level.kind === 'logStream' ? (level.kubernetes ? containerLine(level.name, level.kubernetes.role) : level.name)
      : level.kubernetes?.kind === 'workload' ? t('workload.job', { name: level.name })
      : level.kubernetes?.kind === 'pod' ? t('workload.pod', { name: level.name })
      : level.name
    return [line, ...status, ...dockerLines(level)]
  }

  /** A container's role, labelled after its name. */
  const roleBadge = (role: ContainerRole | undefined) =>
    role && (
      <span className="tree-row__role" title={t(`containerRole.${role}.tooltip`)}>
        {t(`containerRole.${role}`)}
      </span>
    )

  /** Puts a name on the clipboard, from a row's menu. */
  const copyItem = (label: string, name: string): MenuItem => ({ label, onSelect: () => void window.polyscope.copyText(name) })

  /** A row's Copy items: its own name, then that of each level folded into it, for pasting into kubectl, say. */
  const copyItems = (chain: LogNode[]): MenuItem[] =>
    chain.flatMap((level, i) => {
      const kind = level.kubernetes?.kind
      return (
        kind === 'workloads' ? []
        : kind === 'pod' ? [copyItem(t('tree.copyPodName'), level.name)]
        : kind === 'container' ? [copyItem(t('tree.copyContainerName'), level.name)]
        : [copyItem(kind === 'workload' && i > 0 ? t('tree.copyJobName') : t('tree.copyName'), level.name)]
      )
    })

  /** A Log Source's node's icon: what it is in Kubernetes, or else a folder or a log. */
  const logIcon = (node: LogNode) => {
    const { kubernetes } = node
    if (kubernetes?.kind === 'container') return <KubernetesIcon container role={kubernetes.role} />
    if (kubernetes?.kind === 'pod') return <KubernetesIcon workloadKind="Pod" />
    if (kubernetes) return <KubernetesIcon workloadKind={kubernetes.workloadKind} />
    if (node.docker?.kind === 'container') return <ContainerIcon />
    if (node.kind === 'logStream') return <MaterialIcon icon="log" theme={theme} />
    return <MaterialIcon icon="folder" theme={theme} open={expanded.has(node.path)} />
  }

  /** Opens a Log Stream's log, from its row or a row standing in for it. */
  const openLogItems = (logStream: LogStreamNode) => ({
    onActivate: () => onOpenLog(source, logStream),
    onDoubleActivate: () => onOpenLog(source, logStream, { pinned: true })
  })

  /**
   * A Log Source's node: groups expand like folders; a Log Stream opens its log, or, if it has children, expands like
   * a folder, its menu opening its log. A row with levels folded into it stands in for the last: it opens that one's
   * Log Stream, or expands to its children. A group with nothing under it (a CronJob, no Jobs) has nothing to expand.
   */
  const logRow = (node: LogNode, depth: number) => {
    if (opensLog(node)) {
      const role = roleBadge(node.kubernetes?.role)
      // A pod with one container carries its restarts itself; with several, each container carries its own. A Log Stream
      // with a status of its own (a Docker container's) always does.
      const restarts = node.restarts && (node.status || amongSeveral(node.path)) ? node.restarts : 0
      return row({
        path: node.path,
        depth,
        extra: { title: tooltip(node) },
        label: node.name,
        folder: false,
        icon: logIcon(node),
        ...openLogItems(node),
        menuItems: copyItems([node]),
        badge: role,
        details: showDetails ? lastEventDetails(node) : undefined,
        status:
          restarts > 0 || node.status ?
            indicators(
              <>
                {restarts > 0 && restartBadge(restarts)}
                {node.status && statusDot(node.status)}
              </>
            )
          : undefined
      })
    }
    const chain = foldedChain(node)
    const shown = chain.at(-1)!
    const refresh = { label: t('sourceActions.refresh'), onSelect: () => refreshLogRow(chain) }
    // A Log Stream with children of its own expands, and opens its log from its menu.
    const openLog = shown.kind === 'logStream' && !opensLog(shown) ? [{ label: t('tree.openLog'), onSelect: () => onOpenLog(source, shown) }] : []
    // The folded pod's Pod Status, and restarts if it's down to one container, go after the Workload's Ready Count.
    const withStatus = chain.find((level) => level.status)
    const ready = node.kubernetes?.kind === 'workload' && node.kubernetes.readyCount
    const empty = !opensLog(shown) && isEmpty(shown)
    const common = {
      path: node.path,
      depth,
      label:
        node.kubernetes?.kind === 'workloads' ? t(`workloadGroup.${node.kubernetes.workloadKind}`)
        : node.docker?.kind === 'standalone' ? t('dockerGroup.standalone')
        : node.name,
      icon: logIcon(node),
      menuItems: [refresh, ...openLog, ...copyItems(chain)],
      status:
        ready || withStatus?.status ?
          indicators(
            <>
              {ready && readyCount(ready)}
              {withStatus?.status && statusIndicators(withStatus.status, opensLog(shown))}
            </>
          )
        : undefined,
      extra: { title: [tooltip(node), ...chain.slice(1).flatMap(foldedLines), ...(empty ? [emptyLine(shown)] : [])].join('\n') }
    }
    if (opensLog(shown)) {
      // Folded down to one Log Stream, the row opens it, as that Log Stream's row would; Refresh can unfold it.
      return row({ ...common, folder: false, ...openLogItems(shown) })
    }
    if (empty) return row({ ...common, folder: false, onActivate: () => undefined })
    return row({ ...common, folder: true, onActivate: () => toggle(node.path, shown.path) })
  }

  /** What an empty node's tooltip adds: that a Workload has no pods, or a CronJob no Jobs; for anything else, that it's empty. */
  const emptyLine = (level: LogNode) =>
    level.kubernetes?.kind !== 'workload' ? t('tree.emptyLogNode')
    : t(level.kubernetes.workloadKind === 'CronJob' ? 'workload.noJobs' : 'workload.noPods')

  /** What an empty listing says: a namespace or node of a Log Source has no folders to be empty. */
  const emptyNote = (path: SourcePath) =>
    source.type === 'kubernetesFiles' && !path && !rootFolded ? 'tree.noPods'
    : source.type === 'dockerLogs' && !path ? 'tree.noContainers'
    : source.type === 'cloudwatchLogs' && !path ? 'tree.noLogGroups'
    : source.type === 'systemdJournal' && !path ? 'tree.noUnits'
    : !['kubernetesLogs', 'dockerLogs', 'cloudwatchLogs', 'systemdJournal'].includes(source.type) ? 'tree.emptyFolder'
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
        // A row standing in for levels folded into it shows the children of the last.
        const shown = foldedChain(node).at(-1)!
        if (opensLog(shown) || isEmpty(shown) || !expanded.has(node.path)) return [self]
        if (!listings.has(shown.path)) unlisted.push(shown.path)
        return [self, ...renderChildren(shown.path, depth + 1)]
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
        status: kubernetes?.kind === 'pod' ? indicators(statusIndicators(kubernetes.status, kubernetes.containerCount === 1)) : undefined,
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

  // A server whose host key isn't known yet connects once it's trusted, as clicking the Source would.
  const hostKey = connection.state === 'error' ? connection.hostKey : undefined
  const trustHostKey = async (key: HostKey) => {
    if (await onTrustHostKey?.(key)) await toggleSource()
  }

  const actions: SourceAction[] = [
    ...(connected ? [{ label: t('sourceActions.refresh'), icon: <ReloadIcon />, onSelect: () => refreshNode('') }] : []),
    ...(hostKey && onTrustHostKey ? [{ label: t('sourceActions.trustHostKey'), icon: <KeyIcon />, onSelect: () => void trustHostKey(hostKey) }] : []),
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

  // Open rows whose children aren't listed yet: a row that came to stand in for another level than before, say.
  const unlisted: SourcePath[] = []
  // Rendered ahead of the Source's own row, so that row knows whether the selected one is among them.
  const children = connected && expanded.has('') ? renderChildren('', 1) : null
  useEffect(() => {
    for (const path of unlisted) load(path)
  })
  // A level folded into the root, like a Workload's one pod, has no row: the Source's tooltip tells of it instead.
  const foldedTooltip = connected && rootFolded?.kubernetes?.kind === 'pod' ? statusTooltip(rootFolded.path, rootFolded.kubernetes.status) : undefined

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
