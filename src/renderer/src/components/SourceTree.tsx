import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import type { ConnectionState, EntryNode, ErrorNode, SourceInfo, SourcePath } from '@shared/core-api'
import { core, describeError, describeFailure } from '../core-client'
import { t } from '../i18n'
import { uiFor } from '../source-types'
import type { MenuItem } from './ContextMenu'
import { ChevronIcon, FileIcon, FolderIcon, WarningIcon } from './icons'

interface Props {
  source: SourceInfo
  connection: ConnectionState
  /** Connects the Source, resolving to its root's children or null if it couldn't connect. */
  onConnect(): Promise<EntryNode[] | null>
  /** Menu items for the Source's own row; the tree puts its own, like Refresh, ahead of them. */
  sourceMenuItems: MenuItem[]
  onContextMenu(event: MouseEvent<HTMLElement>, label: string, items: MenuItem[]): void
  selectedKey: string | null
  onSelect(key: string): void
  onOpenFile(source: SourceInfo, node: EntryNode): void
  /** Extra attributes for the Source's own row, e.g. for dragging it. */
  sourceRowProps?: HTMLAttributes<HTMLDivElement>
  /** Extra attributes for the whole tree, e.g. to make it a drop target. */
  treeProps?: HTMLAttributes<HTMLDivElement>
}

export const nodeKey = (sourceId: string, path: SourcePath) => `${sourceId}:${path}`

type Listing = { state: 'loading' } | { state: 'loaded'; nodes: EntryNode[] } | { state: 'failed'; message: string }

const isError = (node: EntryNode | ErrorNode): node is ErrorNode => node.kind === 'error'

interface RowProps {
  path: SourcePath
  depth: number
  label: string
  icon: ReactNode
  folder: boolean
  onActivate(): void
  menuItems?: MenuItem[]
  status?: ReactNode
  className?: string
  extra?: HTMLAttributes<HTMLDivElement>
}

const depthStyle = (depth: number) => ({ '--depth': depth }) as CSSProperties

export function SourceTree(props: Props) {
  const { source, connection, onConnect, sourceMenuItems, onContextMenu, selectedKey, onSelect, onOpenFile } = props
  const { sourceRowProps, treeProps } = props
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
      (nodes) => {
        const failure = nodes.find(isError)
        if (failure) settle({ state: 'failed', message: describeFailure(failure) })
        else settle({ state: 'loaded', nodes: nodes.filter((n): n is EntryNode => !isError(n)) })
      },
      (error) => settle({ state: 'failed', message: describeError(error) })
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
    setListing('', { state: 'loaded', nodes })
    setExpanded((prev) => new Set(prev).add(''))
  }

  const row = ({ path, depth, label, icon, folder, onActivate, menuItems, status, className = '', extra }: RowProps) => {
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
        className={`tree-row ${className} ${extra?.className ?? ''}`}
        style={depthStyle(depth)}
        onClick={activate}
        onKeyDown={onKeyDown}
        onContextMenu={openMenu}
      >
        <span className={`tree-row__twisty ${isExpanded ? 'is-open' : ''}`}>{folder && <ChevronIcon />}</span>
        <span className="tree-row__icon">{icon}</span>
        <span className="tree-row__label">{label}</span>
        {status}
      </div>
    )
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
    if (listing.nodes.length === 0) return [note(path, depth, t('tree.emptyFolder'))]
    return listing.nodes.flatMap((node) => {
      const isFolder = node.kind === 'folder'
      const self = row({
        path: node.path,
        depth,
        label: node.name,
        folder: isFolder,
        icon: isFolder ? <FolderIcon open={expanded.has(node.path)} /> : <FileIcon />,
        onActivate: () => (isFolder ? toggle(node.path) : onOpenFile(source, node)),
        menuItems: isFolder ? [{ label: t('sourceMenu.refresh'), onSelect: () => refresh(node.path) }] : undefined
      })
      return isFolder && expanded.has(node.path) ? [self, ...renderChildren(node.path, depth + 1)] : [self]
    })
  }

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
        menuItems: [...(connected ? [{ label: t('sourceMenu.refresh'), onSelect: () => refresh('') }] : []), ...sourceMenuItems],
        status,
        className: `tree-row--source ${connectError ? 'is-error' : ''}`,
        extra: { ...sourceRowProps, title: connectError ?? undefined }
      })}
      {connected && expanded.has('') && renderChildren('', 1)}
    </div>
  )
}
