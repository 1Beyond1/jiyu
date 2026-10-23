import type { Collection, CollectedFile, Participant } from '../types.ts'

export function collectionParticipants(c: Collection, files: CollectedFile[]): Participant[] {
  const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
  const groups = new Map<string, Participant>()
  for (const name of c.expectedSubmitters || []) groups.set(normalized(name), { identity: name, owner: '', expected: true, fileIds: [], bytes: 0, submissions: 0, latestAt: '', duplicates: 0 })
  const hashes = new Map<string, Set<string>>(), submissions = new Map<string, Set<string>>()
  for (const f of files.filter(f => f.collectionId === c.id && !f.deletedAt)) {
    const name = f.participant || f.owner, key = normalized(name)
    const p = groups.get(key) || { identity: name, owner: f.owner, expected: false, fileIds: [], bytes: 0, submissions: 0, latestAt: '', duplicates: 0 }
    p.owner = f.owner; p.fileIds.push(f.id); p.bytes += f.size; p.latestAt = p.latestAt > f.createdAt ? p.latestAt : f.createdAt
    const seen = hashes.get(key) || new Set<string>(); if (f.sha256 && seen.has(f.sha256)) p.duplicates++; if (f.sha256) seen.add(f.sha256); hashes.set(key, seen)
    const batches = submissions.get(key) || new Set<string>(); batches.add(f.submissionId || f.createdAt); submissions.set(key, batches); p.submissions = batches.size; groups.set(key, p)
  }
  return [...groups.values()]
}
