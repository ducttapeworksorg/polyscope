import type { CoreErrorCode } from '@shared/core-api'

export const en = {
  'sidebar.heading': 'Sources',
  'sidebar.add': 'Add Source',
  'sidebar.empty.title': 'No Sources yet',
  'sidebar.empty.body': 'Add a folder on this computer to browse its files.',

  'addSource.title': 'Local Filesystem Source',
  'addSource.name': 'Name',
  'addSource.namePlaceholder': 'App logs',
  'addSource.rootPath': 'Root path',
  'addSource.browse': 'Browse…',
  'addSource.submit': 'Add Source',
  'addSource.cancel': 'Cancel',

  'tree.loading': 'Loading…',
  'tree.emptyFolder': 'Empty folder',
  'tree.retry': 'Retry',

  'tabs.close': 'Close {name}',

  'viewer.empty.noSources': 'Add a Source to start browsing.',
  'viewer.empty.noTabs': 'Open a file from the sidebar to read it here.',
  'viewer.opening': 'Opening {name}…',

  'status.readOnly': 'Read-only',

  'error.NAME_REQUIRED': 'Enter a name for this Source.',
  'error.ROOT_NOT_FOUND': 'That folder doesn’t exist.',
  'error.ROOT_NOT_A_FOLDER': 'That path is a file. Choose a folder.',
  'error.SOURCE_NOT_FOUND': 'This Source no longer exists.',
  'error.PATH_OUTSIDE_SOURCE': 'That path is outside the Source’s root folder.',
  'error.NOT_FOUND': 'This item no longer exists.',
  'error.NOT_A_FOLDER': 'This is a file, not a folder.',
  'error.NOT_A_FILE': 'This is a folder, not a file.',
  'error.UNKNOWN': 'Couldn’t complete that: {message}'
} satisfies Record<string, string> & Record<`error.${CoreErrorCode}`, string>
