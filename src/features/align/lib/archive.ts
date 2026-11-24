import type { LyricLine, Project, PublishedSnapshot, Take, TimeRange } from '../../../shared/document'
import type { LineMapping } from './mapping'

export const STORE_PROJECTS = 'projects'
export const STORE_TAKES = 'takes'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('night-session-align', 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_TAKES)) {
        const takes = db.createObjectStore(STORE_TAKES, { keyPath: 'id' })
        takes.createIndex('projectId', 'projectId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact<T>(
  store: string,
  mode: IDBTransactionMode,
  operation: (handle: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode)
      const request = operation(transaction.objectStore(store))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export function readProject(id: string): Promise<Project | undefined> {
  return transact<Project | undefined>(STORE_PROJECTS, 'readonly', store => store.get(id))
}

export function writeProject(project: Project): Promise<IDBValidKey> {
  return transact(STORE_PROJECTS, 'readwrite', store => store.put(project))
}

export function deleteProject(id: string): Promise<undefined> {
  return transact(STORE_PROJECTS, 'readwrite', store => store.delete(id))
}

export function readAllProjects(): Promise<Project[]> {
  return transact<Project[]>(STORE_PROJECTS, 'readonly', store => store.getAll())
}

export function readTakes(projectId: string): Promise<Take[]> {
  const db = openDatabase()
  return db.then(database =>
    new Promise<Take[]>((resolve, reject) => {
      const transaction = database.transaction(STORE_TAKES, 'readonly')
      const index = transaction.objectStore(STORE_TAKES).index('projectId')
      const request = index.getAll(projectId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => database.close()
      transaction.onabort = () => reject(transaction.error)
    }),
  )
}

export function writeTake(take: Take): Promise<IDBValidKey> {
  return transact(STORE_TAKES, 'readwrite', store => store.put(take))
}

export function deleteTake(id: string): Promise<undefined> {
  return transact(STORE_TAKES, 'readwrite', store => store.delete(id))
}

/**
 * A take's playback window is the target-version span captured when it was
 * recorded. It is deliberately not recomputed from the latest alignment: an
 * old recording must still sit where it was actually sung. Only its words are
 * taken from the snapshot in force at record time.
 */
export function takePlaybackRange(take: Take, snapshot: PublishedSnapshot | null): TimeRange {
  void snapshot
  return { start: take.targetStart, end: take.targetEnd }
}

export function takeLyricText(take: Take, snapshot: PublishedSnapshot | null): string {
  if (snapshot) {
    const line = snapshot.lines.find(entry => entry.id === take.lineId)
    if (line) return line.text
  }
  return take.lineText
}

export function snapshotFor(project: Project, id: string | null): PublishedSnapshot | null {
  if (!id) return null
  return project.snapshots.find(entry => entry.id === id) ?? null
}

export function publishSnapshot(
  project: Project,
  plan: readonly LineMapping[],
  label: string,
  note: string,
): PublishedSnapshot {
  const targets: Record<string, TimeRange | null> = {}
  const statuses: Record<string, string> = {}
  for (const mapping of plan) {
    targets[mapping.lineId] = mapping.target ? { start: mapping.target.start, end: mapping.target.end } : null
    statuses[mapping.lineId] = mapping.kind
  }
  return {
    id: `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label,
    createdAt: Date.now(),
    lines: project.lines.map(line => ({ ...line })),
    anchors: project.anchors.map(anchor => ({ ...anchor })),
    spans: project.spans.map(span => ({ ...span })),
    targets,
    statuses,
    note,
  }
}

/** Merge a plan into per-line display rows (used by UI and export). */
export function planRows(lines: readonly LyricLine[], plan: readonly LineMapping[]) {
  const byId = new Map(plan.map(entry => [entry.lineId, entry]))
  return lines.map(line => ({ line, mapping: byId.get(line.id) ?? null }))
}
