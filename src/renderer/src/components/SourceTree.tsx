import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { SourceInfo, SourcePath, TreeNode } from '@shared/core-api'
import { core, describeError } from '../core-client'
import { t } from '../i18n'
import { ChevronIcon, FileIcon, FolderIcon, HardDriveIcon } from './icons'

interface Props {
  source: SourceInfo
  selectedKey: string | null
  onSelect(key: string): void
  onOpenFile(source: SourceInfo, node: TreeNode): void
}

export const nodeKey = (sourceId: string, path: SourcePath) => `${sourceId}:${path}`

type Listing = { state: 'loading' } | { state: 'loaded'; nodes: TreeNode[] } | { state: 'failed'; message: string }

interface RowProps {
  path: SourcePath
  depth: number
  label: string
  icon: ReactNode
  folder: boolean
  onActivate(): void
  className?: string
}

const depthStyle = (depth: number) => ({ '--depth': depth }) as CSSProperties

export function SourceTree({ source, selectedKey, onSelect, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<SourcePath>>(new Set())
  const [listings, setListings] = useState<ReadonlyMap<SourcePath, Listing>>(new Map())

  const setListing = (path: SourcePath, listing: Listing) => setListings((prev) => new Map(prev).set(path, listing))

  const load = (path: SourcePath) => {
    setListing(path, { state: 'loading' })
    core.expand(source.id, path).then(
      (nodes) => setListing(path, { state: 'loaded', nodes }),
      (error) => setListing(path, { state: 'failed', message: describeError(error) })
    )
  }

  const toggle = (path: SourcePath) => {
    const next = new Set(expanded)
    if (next.delete(path)) return setExpanded(next)
    setExpanded(next.add(path))
    const listing = listings.get(path)
    if (!listing || listing.state === 'failed') load(path)
  }

  const row = ({ path, depth, label, icon, folder, onActivate, className = '' }: RowProps) => {
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
    return (
      <div
        key={key}
        role="treeitem"
        tabIndex={0}
        aria-level={depth + 1}
        aria-expanded={folder ? isExpanded : undefined}
        aria-selected={selectedKey === key}
        className={`tree-row ${className}`}
        style={depthStyle(depth)}
        onClick={activate}
        onKeyDown={onKeyDown}
      >
        <span className={`tree-row__twisty ${isExpanded ? 'is-open' : ''}`}>{folder && <ChevronIcon />}</span>
        <span className="tree-row__icon">{icon}</span>
        <span className="tree-row__label">{label}</span>
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
          <span className="tree-note__message">{listing.message}</span>
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
        onActivate: () => (isFolder ? toggle(node.path) : onOpenFile(source, node))
      })
      return isFolder && expanded.has(node.path) ? [self, ...renderChildren(node.path, depth + 1)] : [self]
    })
  }

  return (
    <div role="tree" aria-label={source.name} className="source-tree">
      {row({
        path: '',
        depth: 0,
        label: source.name,
        folder: true,
        icon: <HardDriveIcon />,
        onActivate: () => toggle(''),
        className: 'tree-row--source'
      })}
      {expanded.has('') && renderChildren('', 1)}
    </div>
  )
}
