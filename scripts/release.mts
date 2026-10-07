// Releases Polyscope from the branch that ends with the release, as docs/development.md#releasing describes: bumps the
// version as that branch's last commit, opens its pull request, waits for CI, merges it, and tags the release on main,
// which runs the release workflow. Run it again at any point and it picks up where the release is: on a branch that
// has bumped the version, even with fixes committed after that, it goes on to the pull request; once that's merged, or
// on main with an untagged version, it tags the branch's last commit.
//
//   npm run release                   suggests a version from the branch's commits, then asks before each step
//   npm run release -- 1.2.3          releases 1.2.3 (or 1.3.0-beta.1, etc.) without suggesting one
//   npm run release -- --dry-run      prints each step's commands without running them, to follow by hand
//   npm run release -- --yes          doesn't ask before each step

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const yes = args.includes('--yes') || args.includes('-y')
const requested = args.find((arg) => !arg.startsWith('-'))?.replace(/^v/, '')

const main = 'main'
const remote = 'origin'
const releaseSubject = (version: string): string => `chore: release ${version}`

// ---- Running things ----

/** Runs a read-only command and returns its trimmed output; runs even in a dry run. */
const read = (command: string, commandArgs: string[]): string =>
  execFileSync(command, commandArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const tryRead = (command: string, commandArgs: string[]): string | undefined => {
  try {
    return read(command, commandArgs)
  } catch {
    return undefined
  }
}

const quote = (arg: string): string => (/^[\w./:@=^-]+$/.test(arg) ? arg : `"${arg}"`)

/** Runs a command that changes something, showing its output; in a dry run, only prints it. */
const run = (command: string, commandArgs: string[]): void => {
  console.log(`  $ ${[command, ...commandArgs].map(quote).join(' ')}`)
  if (dryRun) return
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) fail(`\`${command} ${commandArgs.join(' ')}\` failed.`)
}

/** npm is a .cmd script on Windows, which needs a shell; through `npm run`, npm's own script is at hand instead. */
const npm = (commandArgs: string[]): void => {
  console.log(`  $ npm ${commandArgs.map(quote).join(' ')}`)
  if (dryRun) return
  const npmCli = process.env.npm_execpath
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...commandArgs], { cwd: root, stdio: 'inherit' })
    : spawnSync('npm', commandArgs, { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) fail(`\`npm ${commandArgs.join(' ')}\` failed.`)
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

const prompt = createInterface({ input: process.stdin, output: process.stdout })

const ask = async (question: string): Promise<string> => (await prompt.question(question)).trim()

/** Says what a step does and, unless told not to ask, whether to go ahead; stopping leaves the release resumable. */
const step = async (title: string): Promise<void> => {
  console.log(`\n▶ ${title}`)
  if (yes || dryRun) return
  const answer = (await ask('  Go ahead? [Y/n] ')).toLowerCase()
  if (answer === 'n' || answer === 'no') {
    console.log('\nStopped. Run `npm run release` again to pick up from here.')
    process.exit(0)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// ---- Versions ----

type Version = { major: number; minor: number; patch: number; pre?: { id: string; n: number } }

/** Parses the versions Polyscope uses: x.y.z, or x.y.z-alpha.n / x.y.z-beta.n (see Pre-releases in the docs). */
const parse = (text: string): Version | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/.exec(text)
  if (!match) return undefined
  const [, major = '', minor = '', patch = '', id, n = ''] = match
  return { major: +major, minor: +minor, patch: +patch, pre: id ? { id, n: +n } : undefined }
}

const format = (v: Version): string => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre.id}.${v.pre.n}` : ''}`

const compare = (a: Version, b: Version): number => {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (core) return core
  if (!a.pre || !b.pre) return (a.pre ? -1 : 0) - (b.pre ? -1 : 0)
  return a.pre.id.localeCompare(b.pre.id) || a.pre.n - b.pre.n
}

type Bump = 'major' | 'minor' | 'patch'

const bumped = (v: Version, bump: Bump): Version =>
  bump === 'major' ? { major: v.major + 1, minor: 0, patch: 0 }
  : bump === 'minor' ? { major: v.major, minor: v.minor + 1, patch: 0 }
  : { major: v.major, minor: v.minor, patch: v.patch + 1 }

/** The bump the Conventional Commits since the last release call for; before 1.0, a breaking change is a minor bump. */
const bumpFor = (commits: string[], current: Version): Bump => {
  const breaking = commits.some((c) => /^\w+(\([^)]*\))?!:/.test(c) || /^BREAKING[ -]CHANGE:/m.test(c))
  if (breaking) return current.major === 0 ? 'minor' : 'major'
  if (commits.some((c) => /^feat(\([^)]*\))?:/.test(c))) return 'minor'
  return 'patch'
}

const packageVersion = (ref?: string): string => {
  const text = ref ? read('git', ['show', `${ref}:package.json`]) : readFileSync(join(root, 'package.json'), 'utf8')
  return (JSON.parse(text) as { version: string }).version
}

const tagExists = (version: string): boolean =>
  tryRead('git', ['rev-parse', '-q', '--verify', `refs/tags/v${version}`]) !== undefined

/** Offers the release the commits call for, and pre-releases of it, with the first as the default. */
const chooseVersion = async (current: Version): Promise<string> => {
  const lastTag = tryRead('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'])
  const lastStableTag = tryRead('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', 'v*-*'])
  const commits = read('git', ['log', '--format=%B%x00', lastTag ? `${lastTag}..HEAD` : 'HEAD'])
    .split('\0').map((c) => c.trim()).filter(Boolean)
  const subjects = commits.map((c) => c.split('\n')[0])

  console.log(`\n${subjects.length} commit(s) since ${lastTag ?? 'the first commit'}:`)
  for (const subject of subjects) console.log(`  ${subject}`)

  // Counting from the last release rather than the last pre-release, so 1.3.0-beta.1 plus a fix is still 1.3.0.
  const stableBase = parse(lastStableTag?.slice(1) ?? '') ?? { major: 0, minor: 0, patch: 0 }
  const sinceStable = lastStableTag
    ? read('git', ['log', '--format=%B%x00', `${lastStableTag}..HEAD`]).split('\0').map((c) => c.trim()).filter(Boolean)
    : commits
  const bump = bumpFor(sinceStable, current)
  let target = bumped(stableBase, bump)
  const currentCore = { ...current, pre: undefined }
  if (current.pre && compare(currentCore, target) > 0) target = currentCore

  const nextPre = (id: string): Version => ({
    ...target,
    pre: { id, n: current.pre?.id === id && compare(currentCore, target) === 0 ? current.pre.n + 1 : 1 }
  })
  const choices = [format(target), format(nextPre('beta')), format(nextPre('alpha'))]
    .filter((v) => compare(parse(v)!, current) > 0)

  console.log(`\nCurrent version: ${format(current)}. The commits since ${lastStableTag ?? 'the start'} call for a ${bump} bump.`)
  choices.forEach((v, i) => console.log(`  ${i + 1}) ${v}${i === 0 ? '   (suggested)' : ''}`))
  console.log(`  or type a version`)
  const answer = (await ask(`Version [1]: `)) || '1'
  return choices[+answer - 1] ?? answer.replace(/^v/, '')
}

const checkVersion = (version: string, current: Version): void => {
  const parsed = parse(version)
  if (!parsed) fail(`${version} isn't a version Polyscope releases: use x.y.z, x.y.z-beta.n or x.y.z-alpha.n.`)
  if (compare(parsed, current) <= 0) fail(`${version} isn't later than the current version, ${format(current)}.`)
  if (tagExists(version)) fail(`v${version} is already tagged.`)
}

// ---- The pull request ----

type PullRequest = { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; url: string }

const pullRequest = (branch: string): PullRequest | undefined => {
  const json = tryRead('gh', ['pr', 'view', branch, '--json', 'number,state,url'])
  return json ? (JSON.parse(json) as PullRequest) : undefined
}

const label = (pr: PullRequest): string => (pr.number ? `#${pr.number}` : 'the new pull request')

/** Waits for CI on the pull request; its checks take a moment to show up after a push. */
const waitForChecks = async (branch: string, pr: PullRequest): Promise<void> => {
  await step(`Wait for CI on ${label(pr)} to pass`)
  console.log(`  $ gh pr checks ${branch} --watch --fail-fast`)
  if (dryRun) return
  for (let tries = 0; tries < 30; tries++) {
    const out = spawnSync('gh', ['pr', 'checks', branch], { cwd: root, encoding: 'utf8' })
    if (!/no checks reported/i.test(`${out.stdout}${out.stderr}`)) break
    await sleep(5000)
  }
  const result = spawnSync('gh', ['pr', 'checks', branch, '--watch', '--fail-fast'], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) fail(`CI didn't pass on ${pr.url}. Fix it on the branch, then run \`npm run release\` again.`)
}

// ---- The steps ----

/** Bumps the version as the branch's last commit. */
const prepare = async (branch: string): Promise<string> => {
  const current = parse(packageVersion())
  if (!current) fail(`package.json's version, ${packageVersion()}, isn't one this script understands.`)
  const version = requested ?? (await chooseVersion(current))
  checkVersion(version, current)

  await step(`Bump the version to ${version} and commit it to ${branch}`)
  npm(['version', version, '--no-git-tag-version'])
  run('git', ['commit', '-am', releaseSubject(version)])
  return version
}

/** Pushes the branch, opens its pull request if there isn't one, waits for CI and merges. */
const ship = async (branch: string, version: string): Promise<void> => {
  // A closed pull request for the branch is an earlier attempt; open a new one.
  let pr = pullRequest(branch)
  if (pr?.state !== 'OPEN') pr = undefined
  await step(pr ? `Push ${branch} to #${pr.number}` : `Push ${branch} and open its pull request`)
  run('git', ['push', '-u', remote, branch])
  if (!pr) {
    run('gh', ['pr', 'create', '--base', main, '--fill-first'])
    pr = dryRun ? { number: 0, state: 'OPEN', url: '(the new pull request)' } : pullRequest(branch)
    if (!pr) fail(`Couldn't find the pull request for ${branch}.`)
  }
  console.log(`  ${pr.url}`)

  await waitForChecks(branch, pr)

  await step(`Merge ${label(pr)} into ${main} (Rebase and merge) to release ${version}`)
  run('gh', ['pr', 'merge', branch, '--rebase'])
}

/** Brings main up to date, tags the release on it and pushes the tag, which runs the release workflow. */
const finish = async (version: string, branch?: string): Promise<void> => {
  await step(`Switch to ${main} and pull${branch ? `, then delete ${branch}` : ''}`)
  run('git', ['switch', main])
  run('git', ['pull', '--ff-only', remote, main])
  // -D: rebasing gave the commits new hashes, so git thinks they're unmerged.
  if (branch) run('git', ['branch', '-D', branch])

  // Tag the branch's last commit as it landed on main, so commits after the release one, like a fix for CI, are in
  // the release; without a branch, main as it is.
  const commit = dryRun ? `${remote}/${main}`
    : (branch && tryRead('gh', ['pr', 'view', branch, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'])) ||
      read('git', ['rev-parse', `${remote}/${main}`])
  if (!dryRun && packageVersion(commit) !== version) fail(`package.json at ${commit.slice(0, 7)} isn't at ${version}.`)
  const described = dryRun ? `the branch's last commit on ${main}` : read('git', ['log', '-1', '--format=%h (%s)', commit])

  await step(`Tag ${described} as v${version} and push the tag, which starts the release workflow`)
  run('git', ['tag', `v${version}`, commit])
  run('git', ['push', remote, `v${version}`])

  await step('Watch the release workflow')
  console.log(`  $ gh run watch <the release run for v${version}> --exit-status`)
  if (dryRun) return
  let runId: string | undefined
  for (let tries = 0; !runId && tries < 30; tries++) {
    await sleep(tries ? 5000 : 3000)
    runId = tryRead('gh', ['run', 'list', '--workflow', 'release.yml', '--branch', `v${version}`, '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId']) || undefined
  }
  if (!runId) fail(`The release workflow hasn't started for v${version}; see https://github.com/ducttapeworksorg/polyscope/actions.`)
  const result = spawnSync('gh', ['run', 'watch', runId, '--exit-status'], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) fail(`The release workflow failed: \`gh run view ${runId} --log-failed\`. A rerun picks up the draft release.`)
  run('gh', ['release', 'view', `v${version}`, '--web'])
}

// ---- Where the release is ----

if (dryRun) console.log('Dry run: nothing below is run.')
if (read('git', ['status', '--porcelain'])) fail('The working tree has uncommitted changes; commit or stash them first.')
read('git', ['fetch', '--tags', remote])

const branch = read('git', ['branch', '--show-current'])
if (!branch) fail('HEAD is detached; switch to the branch to release, or to main.')

if (branch === main) {
  // After a merge made outside this script: tag main's version if it isn't yet.
  const version = packageVersion(`${remote}/${main}`)
  if (tagExists(version)) fail(`${main} is at ${version}, which is already tagged. Release from the branch with the changes.`)
  await finish(version)
} else {
  // The branch has bumped the version and it isn't tagged yet: a release under way, even with commits after its
  // release commit, like a fix for CI.
  const version = packageVersion()
  const pending = version !== packageVersion(`${remote}/${main}`) && !tagExists(version) ? version : undefined
  if (pending && requested && requested !== pending) fail(`${branch} is already releasing ${pending}.`)
  if (pending) console.log(`${branch} is releasing ${pending}; picking up from there.`)

  const pr = pullRequest(branch)
  if (pr?.state === 'MERGED') {
    if (!pending) fail(`#${pr.number} for ${branch} is already merged, but doesn't release a version.`)
    await finish(pending, branch)
  } else {
    const version = pending ?? (await prepare(branch))
    await ship(branch, version)
    await finish(version, branch)
  }
}

console.log('\n✔ Done.')
prompt.close()
