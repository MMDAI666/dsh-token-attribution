/**
 * Automatic data-directory migration and legacy-profile adoption.
 *
 * The store owns `state/<profile>/pointer.json` (the authoritative data root)
 * while `Config.dataDir` expresses the desired root. At startup, after the
 * per-profile lock is acquired and before the ledger is opened, this module
 * reconciles the two:
 *
 * - pointer root === configured root → no-op (`ok`);
 * - pointer root !== configured root and the target is absent/empty → copy into
 *   a sibling staging directory, verify record counts/token sums/daily files,
 *   rename staging into place, atomically switch the pointer, then rename the old
 *   root to `<old>.migrated-<ts>` (`ok`);
 * - any failure (non-empty target, copy error, verification mismatch, pointer
 *   write error) → keep the old root and record `failed` with diagnostics;
 * - no pointer and a legacy `state/default` ledger exists while the running
 *   profile is not `default` → copy that ledger into the profile's root and
 *   record `adopted`; the `default` directories are left in place as a backup.
 *
 * The copy is synchronous and bounded by `MIGRATION_MAX_BYTES`: the store is
 * created synchronously during plugin activation, before the collector or any
 * other writer exists, so no concurrent ledger write can observe a half copy.
 * `pointer.json` is only rewritten after the target has been fully copied and
 * verified, so a failure can never point the ledger at partial data.
 *
 * @module dsh-token-attribution/host/migration
 */

import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync, ensureDir, isValidDayKey, nowMs, readJsonFile } from './util.mjs'

/** Migration state-file revision. */
export const MIGRATION_VERSION = 1

/** File name of the migration state inside the profile state root. */
export const MIGRATION_FILE = 'migration.json'

/** Days a `<dataRoot>.migrated-*` backup is kept before startup pruning. */
export const MIGRATION_BACKUP_DAYS = 7

/** Hard cap for one migration copy (512 MiB). */
export const MIGRATION_MAX_BYTES = 512 * 1024 * 1024

/** Accepted migration state statuses. */
export const MIGRATION_STATUSES = Object.freeze(['ok', 'adopted', 'migrating', 'failed'])

/** Backup directories are named `<oldRoot>.migrated-<timestamp>`. */
const BACKUP_MARKER = '.migrated-'

/** Temporary copy directories are named `<target>.staging-<pid>-<timestamp>`. */
const STAGING_MARKER = '.staging-'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Build an Error carrying a machine-readable migration code.
 * @param {string} code - stable error code.
 * @param {string} message - human-readable message.
 * @returns {Error} tagged error.
 */
function migrationError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Error message text for any thrown value.
 * @param {unknown} error - thrown value.
 * @returns {string} message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Case-normalized absolute path key used only for comparisons.
 * @param {string} value - path to normalize.
 * @returns {string} comparison key.
 */
function pathKey(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Whether two paths resolve to the same location (case-insensitive on Windows).
 * @param {string} left - first path.
 * @param {string} right - second path.
 * @returns {boolean} true when the paths are the same location.
 */
export function samePath(left, right) {
  return pathKey(left) === pathKey(right)
}

/**
 * Whether `child` is nested inside `parent` (not equal to it).
 * @param {string} parent - candidate parent directory.
 * @param {string} child - candidate descendant.
 * @returns {boolean} true when `child` is a strict descendant of `parent`.
 */
export function isSubpath(parent, child) {
  const parentKey = pathKey(parent)
  const childKey = pathKey(child)
  if (parentKey === childKey) return false
  const prefix = parentKey.endsWith(path.sep) ? parentKey : `${parentKey}${path.sep}`
  return childKey.startsWith(prefix)
}

/**
 * Stat a path without throwing.
 * @param {string} target - file or directory path.
 * @returns {fs.Stats | null} stats or null.
 */
function statSafe(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

/**
 * List directory entries without throwing.
 * @param {string} dir - directory path.
 * @returns {string[]} entry names (empty if unreadable).
 */
function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Describe whether a target directory is missing, empty, or non-empty.
 * @param {string} dir - directory path.
 * @returns {{exists: boolean, directory: boolean, empty: boolean}} directory state.
 */
export function directoryState(dir) {
  const stats = statSafe(dir)
  if (stats === null) return { exists: false, directory: false, empty: true }
  if (!stats.isDirectory()) return { exists: true, directory: false, empty: false }
  return { exists: true, directory: true, empty: readdirSafe(dir).length === 0 }
}

/**
 * Coerce a token counter to a finite number (never throws).
 * @param {unknown} value - raw counter.
 * @returns {number} finite number or 0.
 */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Inspect one ledger data root for migration verification.
 *
 * Parses every `requests/YYYY-MM-DD.jsonl` file, counting valid JSON records and
 * summing `promptTokens`/`outputTokens`; malformed lines are counted and ignored.
 * Daily aggregate file names and `meta.json` presence are collected too. A
 * missing root is treated as an empty ledger.
 *
 * @param {string} dataRoot - ledger data root.
 * @returns {{root: string, requests: {files: string[], records: number, promptTokens: number, outputTokens: number, corruptLines: number}, daily: {files: string[]}, meta: {exists: boolean}}} snapshot.
 */
export function inspectDataRoot(dataRoot) {
  const root = path.resolve(dataRoot)
  const requests = { files: [], records: 0, promptTokens: 0, outputTokens: 0, corruptLines: 0 }
  const requestsRoot = path.join(root, 'requests')
  for (const name of readdirSafe(requestsRoot)) {
    if (!name.endsWith('.jsonl') || !isValidDayKey(name.slice(0, 10))) continue
    requests.files.push(name)
    let text
    try {
      text = fs.readFileSync(path.join(requestsRoot, name), 'utf8')
    } catch {
      requests.corruptLines += 1
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        requests.corruptLines += 1
        continue
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        requests.corruptLines += 1
        continue
      }
      requests.records += 1
      requests.promptTokens += numberOrZero(record.promptTokens)
      requests.outputTokens += numberOrZero(record.outputTokens)
    }
  }
  requests.files.sort()

  const daily = { files: [] }
  const dailyRoot = path.join(root, 'daily')
  for (const name of readdirSafe(dailyRoot)) {
    if (!name.endsWith('.json') || !isValidDayKey(name.slice(0, 10))) continue
    daily.files.push(name)
  }
  daily.files.sort()

  const metaStat = statSafe(path.join(root, 'meta.json'))
  return {
    root,
    requests,
    daily,
    meta: { exists: metaStat !== null && metaStat.isFile() },
  }
}

/**
 * Compare two roots and decide whether a copy is a faithful replica.
 *
 * Equality is exact for request-file names, record count, summed prompt/output
 * tokens, daily-file names, and `meta.json` presence. Corrupt JSONL lines are
 * ignored for the counters and merely reported.
 *
 * @param {string} sourceRoot - original data root.
 * @param {string} targetRoot - copied data root.
 * @returns {{ok: boolean, problems: string[], corruptLines: number, source: object, target: object}} verification result.
 */
export function verifyCopiedDataRoot(sourceRoot, targetRoot) {
  const source = inspectDataRoot(sourceRoot)
  const target = inspectDataRoot(targetRoot)
  const problems = []
  if (source.requests.files.join('\n') !== target.requests.files.join('\n')) {
    problems.push(`request files differ (source ${source.requests.files.length}, target ${target.requests.files.length})`)
  }
  if (source.requests.records !== target.requests.records) {
    problems.push(`request record count differs (source ${source.requests.records}, target ${target.requests.records})`)
  }
  if (source.requests.promptTokens !== target.requests.promptTokens) {
    problems.push(`promptTokens sum differs (source ${source.requests.promptTokens}, target ${target.requests.promptTokens})`)
  }
  if (source.requests.outputTokens !== target.requests.outputTokens) {
    problems.push(`outputTokens sum differs (source ${source.requests.outputTokens}, target ${target.requests.outputTokens})`)
  }
  if (source.daily.files.join('\n') !== target.daily.files.join('\n')) {
    problems.push(`daily files differ (source ${source.daily.files.length}, target ${target.daily.files.length})`)
  }
  if (source.meta.exists !== target.meta.exists) {
    problems.push(`meta.json presence differs (source ${source.meta.exists}, target ${target.meta.exists})`)
  }
  return {
    ok: problems.length === 0,
    problems,
    corruptLines: source.requests.corruptLines + target.requests.corruptLines,
    source,
    target,
  }
}

/**
 * Recursively copy one directory, counting bytes as it goes.
 * @param {string} sourceDir - directory to read.
 * @param {string} targetDir - directory to create/extend.
 * @param {{files: number, bytes: number}} state - running copy counters.
 * @param {number} maxBytes - byte cap for the whole copy.
 * @returns {void}
 */
function copyDirectory(sourceDir, targetDir, state, maxBytes) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(sourceDir, entry.name)
    const to = path.join(targetDir, entry.name)
    const stats = fs.lstatSync(from)
    if (stats.isSymbolicLink()) {
      throw migrationError('copy-failed', `symbolic links are not supported in a data root (${from})`)
    }
    if (stats.isDirectory()) {
      ensureDir(to)
      copyDirectory(from, to, state, maxBytes)
      continue
    }
    if (!stats.isFile()) continue
    const nextBytes = state.bytes + stats.size
    if (nextBytes > maxBytes) {
      throw migrationError(
        'size-limit',
        `data root exceeds the ${maxBytes}-byte migration cap; migration aborted to keep the old root`,
      )
    }
    fs.copyFileSync(from, to)
    state.bytes = nextBytes
    state.files += 1
  }
}

/**
 * Copy a ledger data root into a staging directory.
 *
 * A missing source copies as an empty directory (nothing to migrate). The copy
 * is recursive, byte-capped, and refuses symbolic links so a link cannot pull
 * unrelated files into the ledger.
 *
 * @param {string} sourceRoot - ledger data root.
 * @param {string} targetRoot - staging directory to fill.
 * @param {{maxBytes?: number}} [options] - copy options.
 * @returns {{files: number, bytes: number}} copied file/byte counts.
 */
export function copyDataRootSync(sourceRoot, targetRoot, { maxBytes = MIGRATION_MAX_BYTES } = {}) {
  const state = { files: 0, bytes: 0 }
  const sourceStat = statSafe(sourceRoot)
  if (sourceStat === null) {
    ensureDir(targetRoot)
    return state
  }
  if (!sourceStat.isDirectory()) {
    throw migrationError('copy-failed', `data root is not a directory: ${sourceRoot}`)
  }
  ensureDir(targetRoot)
  copyDirectory(sourceRoot, targetRoot, state, maxBytes)
  return state
}

/**
 * Normalize a parsed migration state file.
 * @param {unknown} value - parsed JSON value.
 * @returns {object | null} normalized state or null for a non-object.
 */
export function normalizeMigrationState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const status = MIGRATION_STATUSES.includes(value.status) ? value.status : 'failed'
  const state = {
    v: MIGRATION_VERSION,
    status,
    from: typeof value.from === 'string' ? value.from : null,
    to: typeof value.to === 'string' ? value.to : null,
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : null,
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : null,
    error: typeof value.error === 'string' ? value.error : null,
    backup: typeof value.backup === 'string' ? value.backup : null,
  }
  if (Array.isArray(value.diagnostics)) {
    state.diagnostics = value.diagnostics.filter(entry => typeof entry === 'string')
  }
  return state
}

/**
 * Read `<stateRoot>/migration.json`.
 * @param {string} stateRoot - profile state root.
 * @returns {object | null} migration state or null.
 */
export function readMigrationState(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) return null
  return normalizeMigrationState(readJsonFile(path.join(path.resolve(stateRoot), MIGRATION_FILE)))
}

/**
 * Atomically write `<stateRoot>/migration.json`.
 * @param {string} stateRoot - profile state root.
 * @param {object} state - migration state.
 * @returns {void}
 */
export function writeMigrationState(stateRoot, state) {
  ensureDir(stateRoot)
  atomicWriteFileSync(path.join(path.resolve(stateRoot), MIGRATION_FILE), JSON.stringify(state))
}

/**
 * Format an epoch-milliseconds instant for a backup directory suffix.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} compact local timestamp.
 */
function formatBackupStamp(ms) {
  const date = new Date(ms)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`
}

/**
 * Return `candidate` or a numbered variant when the path already exists.
 * @param {string} candidate - desired path.
 * @returns {string} free path.
 */
function uniqueSiblingPath(candidate) {
  if (!fs.existsSync(candidate)) return candidate
  for (let index = 2; index < 1000; index += 1) {
    const next = `${candidate}-${index}`
    if (!fs.existsSync(next)) return next
  }
  return `${candidate}-${process.pid}`
}

/**
 * Remove abandoned staging directories left by a crashed copy for one target.
 * @param {string} targetRoot - migration target.
 * @param {(message: string) => void} report - diagnostic sink.
 * @returns {void}
 */
function cleanupStaleStaging(targetRoot, report) {
  const parent = path.dirname(path.resolve(targetRoot))
  const base = path.basename(path.resolve(targetRoot))
  for (const name of readdirSafe(parent)) {
    if (!name.startsWith(`${base}${STAGING_MARKER}`)) continue
    try {
      fs.rmSync(path.join(parent, name), { recursive: true, force: true })
    } catch (error) {
      report(`cannot remove stale migration staging "${name}": ${messageOf(error)}`)
    }
  }
}

/**
 * Whether a directory looks like an actual ledger (has requests, daily, or meta).
 * @param {string} dataRoot - candidate ledger root.
 * @returns {boolean} true when at least one ledger artifact exists.
 */
function hasLedgerContent(dataRoot) {
  const requests = readdirSafe(path.join(dataRoot, 'requests'))
  if (requests.some(name => name.endsWith('.jsonl'))) return true
  const daily = readdirSafe(path.join(dataRoot, 'daily'))
  if (daily.some(name => name.endsWith('.json'))) return true
  return statSafe(path.join(dataRoot, 'meta.json')) !== null
}

/**
 * Prune `<dataRoot>.migrated-*` backup directories older than the retention.
 *
 * Backups are created next to the old data root, so the parent directory of each
 * candidate root is scanned for names derived from that root only. Freshly
 * created backups get their mtime reset to migration time (see `runMigration`)
 * so retention counts from the switch, not from the old data's last write.
 *
 * @param {{dataRoots?: string[], now?: number, backupDays?: number, report?: (message: string) => void}} [options] - pruning inputs.
 * @returns {{removed: string[], kept: string[]}} removed/kept backup paths.
 */
export function pruneMigrationBackups({ dataRoots = [], now = nowMs(), backupDays = MIGRATION_BACKUP_DAYS, report } = {}) {
  const removed = []
  const kept = []
  const reportDiagnostic = typeof report === 'function' ? report : () => {}
  const days = Number.isFinite(backupDays) && backupDays >= 0 ? backupDays : MIGRATION_BACKUP_DAYS
  const cutoff = now - days * DAY_MS
  const seen = new Set()
  for (const dataRoot of Array.isArray(dataRoots) ? dataRoots : []) {
    if (typeof dataRoot !== 'string' || dataRoot.length === 0) continue
    const resolved = path.resolve(dataRoot)
    const parent = path.dirname(resolved)
    const base = path.basename(resolved)
    const key = `${pathKey(parent)}\u0000${base}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const name of readdirSafe(parent)) {
      if (!name.startsWith(`${base}${BACKUP_MARKER}`)) continue
      const candidate = path.join(parent, name)
      const stats = statSafe(candidate)
      if (stats === null || !stats.isDirectory()) continue
      if (stats.mtimeMs >= cutoff) {
        kept.push(candidate)
        continue
      }
      try {
        fs.rmSync(candidate, { recursive: true, force: true })
        removed.push(candidate)
      } catch (error) {
        reportDiagnostic(`cannot prune migration backup "${name}": ${messageOf(error)}`)
      }
    }
  }
  return { removed, kept }
}

/**
 * Find the legacy `default` profile ledger, if the current profile may adopt it.
 *
 * The legacy source is `state/default/pointer.json`'s data root (falling back to
 * `data/default` when the pointer is missing or unreadable). Adoption only makes
 * sense when that directory still has ledger content.
 *
 * @param {string} dshHome - DSH home directory.
 * @param {string} profile - running profile name.
 * @param {(message: string) => void} report - diagnostic sink.
 * @returns {string | null} legacy data root or null.
 */
function findLegacyDefaultDataRoot(dshHome, profile, report) {
  if (profile === 'default') return null
  if (typeof dshHome !== 'string' || dshHome.length === 0) return null
  const legacyStateRoot = path.join(path.resolve(dshHome), 'token-attribution', 'state', 'default')
  const stateStat = statSafe(legacyStateRoot)
  if (stateStat === null || !stateStat.isDirectory()) return null
  const legacyPointer = readJsonFile(path.join(legacyStateRoot, 'pointer.json'))
  let legacyDataRoot
  if (legacyPointer !== null && typeof legacyPointer === 'object' && typeof legacyPointer.dataRoot === 'string') {
    legacyDataRoot = path.resolve(legacyPointer.dataRoot)
  } else {
    legacyDataRoot = path.join(path.resolve(dshHome), 'token-attribution', 'data', 'default')
    if (legacyPointer !== null || statSafe(path.join(legacyStateRoot, 'pointer.json')) !== null) {
      report('legacy default-profile pointer is unreadable; adopting the default data directory instead')
    }
  }
  const dataStat = statSafe(legacyDataRoot)
  if (dataStat === null || !dataStat.isDirectory()) return null
  if (!hasLedgerContent(legacyDataRoot)) return null
  return legacyDataRoot
}

/**
 * Copy, verify, switch, and back up one data root.
 *
 * This is the shared body of both the configured-root migration and legacy
 * adoption. The target directory must be missing or empty; the copy goes into a
 * sibling staging directory first so the target is never partially visible, and
 * `pointer.json` is rewritten only after verification.
 *
 * @param {object} input - attempt inputs.
 * @param {string} input.sourceRoot - old data root (may be missing).
 * @param {string} input.targetRoot - configured target root.
 * @param {string} input.stateRoot - profile state root.
 * @param {string} input.pointerPath - pointer file path.
 * @param {number} input.startedAt - attempt start timestamp.
 * @param {'migrate'|'adopt'} input.kind - migration kind.
 * @param {number} input.maxBytes - copy byte cap.
 * @param {(source: string, target: string, options: {maxBytes: number}) => object} input.copy - copy implementation (injected in tests).
 * @param {(source: string, target: string) => object} input.verify - verification implementation (injected in tests).
 * @param {() => number} input.clock - timestamp source.
 * @param {(message: string) => void} input.note - diagnostic sink.
 * @param {string[]} input.diagnostics - shared diagnostic collector.
 * @returns {object} attempt result with `status`, `dataRoot`, `state`, `backup`, `pointerWritten`.
 */
function performCopy({ sourceRoot, targetRoot, stateRoot, pointerPath, startedAt, kind, maxBytes, copy, verify, clock, note, diagnostics }) {
  const legacy = kind === 'adopt'
  const from = path.resolve(sourceRoot)
  const to = path.resolve(targetRoot)
  let state = null

  const writeState = (status, { error = null, backup = null } = {}) => {
    state = {
      v: MIGRATION_VERSION,
      status,
      from,
      to,
      startedAt,
      finishedAt: status === 'migrating' ? null : clock(),
      error,
      backup,
      ...(diagnostics.length > 0 ? { diagnostics: [...diagnostics] } : {}),
    }
    try {
      writeMigrationState(stateRoot, state)
    } catch (writeError) {
      note(`cannot write migration.json: ${messageOf(writeError)}`)
    }
    return state
  }

  const targetState = directoryState(to)
  if (targetState.exists && (!targetState.directory || !targetState.empty)) {
    const reason = targetState.directory
      ? `target data directory is not empty: ${to}`
      : `target data directory path exists and is not a directory: ${to}`
    note(reason)
    const failedState = writeState('failed', { error: reason })
    return {
      attempted: true,
      status: 'failed',
      dataRoot: legacy ? to : from,
      adopted: false,
      pointerWritten: false,
      backup: null,
      state: failedState,
      diagnostics,
    }
  }
  if (samePath(from, to)) {
    // A pointer pointing at the configured root would have been a no-op before
    // this function was called; keep the guard so a bad caller cannot self-copy.
    return {
      attempted: false,
      status: 'ok',
      dataRoot: to,
      adopted: false,
      pointerWritten: false,
      backup: null,
      state: null,
      diagnostics,
    }
  }
  if (isSubpath(from, to) || isSubpath(to, from)) {
    const reason = `refusing to migrate a data root into or out of itself (${from} -> ${to})`
    note(reason)
    const failedState = writeState('failed', { error: reason })
    return {
      attempted: true,
      status: 'failed',
      dataRoot: from,
      adopted: false,
      pointerWritten: false,
      backup: null,
      state: failedState,
      diagnostics,
    }
  }

  cleanupStaleStaging(to, note)
  writeState('migrating')

  const stamp = formatBackupStamp(startedAt)
  const stagingRoot = uniqueSiblingPath(`${to}${STAGING_MARKER}${process.pid}-${stamp}`)
  let switched = false
  try {
    ensureDir(path.dirname(to))
    copy(from, stagingRoot, { maxBytes })
    const verification = verify(from, stagingRoot)
    if (verification && Number.isFinite(verification.corruptLines) && verification.corruptLines > 0) {
      note(`copy contains ${verification.corruptLines} corrupt JSONL line(s); they were ignored during verification`)
    }
    if (verification === null || typeof verification !== 'object' || verification.ok !== true) {
      const problems = Array.isArray(verification?.problems) ? verification.problems.join('; ') : 'unknown verification failure'
      throw migrationError('verify-failed', `migration verification failed: ${problems}`)
    }
    // Re-check the target: a concurrent writer is excluded by the ledger lock,
    // but the directory could still have changed through external action.
    const switchState = directoryState(to)
    if (switchState.exists && !switchState.empty) {
      throw migrationError('target-not-empty', `target data directory is not empty: ${to}`)
    }
    if (switchState.exists) fs.rmdirSync(to)
    fs.renameSync(stagingRoot, to)
    switched = true

    atomicWriteFileSync(pointerPath, JSON.stringify({
      v: 1,
      dataRoot: to,
      schemaVersion: 1,
      updatedAt: clock(),
      previousDataRoot: from,
    }))

    let backup = null
    if (legacy) {
      // The legacy default-profile directories stay in place as a backup; they
      // are intentionally not renamed or deleted.
      backup = from
    } else {
      try {
        if (fs.existsSync(from)) {
          backup = uniqueSiblingPath(`${from}${BACKUP_MARKER}${stamp}`)
          fs.renameSync(from, backup)
          try {
            const touched = new Date(clock())
            fs.utimesSync(backup, touched, touched)
          } catch {
            // Backup pruning has a fallback: a directory we cannot touch simply
            // keeps its original mtime.
          }
        }
      } catch (backupError) {
        backup = null
        note(`cannot rename old data root to a backup: ${messageOf(backupError)}`)
      }
    }

    const finishedState = writeState(legacy ? 'adopted' : 'ok', { backup })
    return {
      attempted: true,
      status: legacy ? 'adopted' : 'ok',
      dataRoot: to,
      adopted: legacy,
      pointerWritten: true,
      backup,
      state: finishedState,
      diagnostics,
    }
  } catch (error) {
    const reason = messageOf(error)
    note(`migration failed: ${reason}`)
    try {
      fs.rmSync(stagingRoot, { recursive: true, force: true })
    } catch {
      // Best-effort staging cleanup; the pointer was never switched below the
      // success branch, so a leftover staging directory is inert.
    }
    if (switched) {
      // The pointer write or a post-switch step failed: restore the old root as
      // the effective root and remove the complete-but-unpointed copy so a later
      // startup can retry cleanly.
      try {
        fs.rmSync(to, { recursive: true, force: true })
      } catch {
        // If the target cannot be removed it stays a complete copy; the next
        // startup reports a non-empty target rather than corrupting data.
      }
    }
    const failedState = writeState('failed', { error: reason })
    return {
      attempted: true,
      status: 'failed',
      dataRoot: legacy ? to : from,
      adopted: false,
      pointerWritten: false,
      backup: null,
      state: failedState,
      diagnostics,
    }
  }
}

/**
 * Reconcile pointer, configured data root, and legacy default-profile data.
 *
 * This function never throws; every failure is reported in the result and the
 * migration state file. The store calls it after acquiring the per-profile lock
 * and uses `result.dataRoot` as the effective ledger root.
 *
 * @param {object} input - migration inputs.
 * @param {string} input.dshHome - DSH home directory (for legacy discovery).
 * @param {string} input.stateRoot - profile state root.
 * @param {string} input.pointerPath - `pointer.json` path.
 * @param {string} input.configuredDataRoot - desired data root from Config.
 * @param {string} [input.profile] - running profile name.
 * @param {(message: string) => void} [input.report] - diagnostic sink.
 * @param {() => number} [input.now] - clock.
 * @param {(source: string, target: string, options: {maxBytes: number}) => object} [input.copy] - copy implementation override.
 * @param {(source: string, target: string) => object} [input.verify] - verification implementation override.
 * @param {number} [input.maxBytes] - copy byte cap.
 * @param {boolean} [input.allowLegacyAdoption] - disable legacy adoption (tests).
 * @returns {{attempted: boolean, status: 'ok'|'adopted'|'failed', dataRoot: string, pointerRoot: string|null, configuredDataRoot: string, adopted: boolean, pointerWritten: boolean, backup: string|null, state: object|null, diagnostics: string[]}} migration result.
 */
export function runMigration({
  dshHome,
  stateRoot,
  pointerPath,
  configuredDataRoot,
  profile = 'default',
  report,
  now = nowMs,
  copy = copyDataRootSync,
  verify = verifyCopiedDataRoot,
  maxBytes = MIGRATION_MAX_BYTES,
  allowLegacyAdoption = true,
} = {}) {
  const diagnostics = []
  const note = (message) => {
    diagnostics.push(message)
    try {
      report?.(message)
    } catch {
      // Diagnostics must never break startup.
    }
  }
  const clock = typeof now === 'function' ? now : () => (Number.isFinite(now) ? now : Date.now())
  const startedAt = clock()
  const targetRoot = typeof configuredDataRoot === 'string' && configuredDataRoot.length > 0
    ? path.resolve(configuredDataRoot)
    : null
  const safeResult = {
    attempted: false,
    status: 'ok',
    dataRoot: targetRoot ?? '',
    pointerRoot: null,
    configuredDataRoot: targetRoot ?? '',
    adopted: false,
    pointerWritten: false,
    backup: null,
    state: null,
    diagnostics,
  }
  if (targetRoot === null || typeof stateRoot !== 'string' || typeof pointerPath !== 'string') return safeResult

  let pointerExists = false
  let pointer = null
  let pointerCorrupt = false
  let pointerRoot = null
  try {
    pointerExists = fs.existsSync(pointerPath)
    pointer = pointerExists ? readJsonFile(pointerPath) : null
    pointerCorrupt = pointerExists && pointer === null
    pointerRoot = pointer !== null && typeof pointer === 'object' && typeof pointer.dataRoot === 'string'
      ? path.resolve(pointer.dataRoot)
      : null
  } catch (error) {
    note(`cannot read pointer.json: ${messageOf(error)}`)
    return { ...safeResult, status: 'failed', dataRoot: targetRoot }
  }
  safeResult.pointerRoot = pointerRoot
  if (pointerCorrupt) {
    note('pointer.json is corrupt; migration is skipped to avoid overwriting it')
    return { ...safeResult, status: 'failed' }
  }

  if (pointerRoot !== null) {
    if (samePath(pointerRoot, targetRoot)) {
      safeResult.dataRoot = targetRoot
      return safeResult
    }
    const result = performCopy({
      sourceRoot: pointerRoot,
      targetRoot,
      stateRoot,
      pointerPath,
      startedAt,
      kind: 'migrate',
      maxBytes,
      copy,
      verify,
      clock,
      note,
      diagnostics,
    })
    return { ...safeResult, ...result, diagnostics }
  }

  // No usable pointer: adopt the legacy `default` ledger when this profile has
  // no data of its own yet. The legacy directories are kept as a backup.
  if (allowLegacyAdoption) {
    const legacyRoot = findLegacyDefaultDataRoot(dshHome, profile, note)
    if (legacyRoot !== null) {
      const targetState = directoryState(targetRoot)
      if (targetState.exists && (!targetState.directory || !targetState.empty)) {
        note(`legacy default-profile data was not adopted because ${targetRoot} already has data`)
        return safeResult
      }
      const result = performCopy({
        sourceRoot: legacyRoot,
        targetRoot,
        stateRoot,
        pointerPath,
        startedAt,
        kind: 'adopt',
        maxBytes,
        copy,
        verify,
        clock,
        note,
        diagnostics,
      })
      return { ...safeResult, ...result, diagnostics }
    }
  }

  return safeResult
}
