import type {
  Collection,
  CollectedFile,
  MaterialParticipant,
  MaterialStateReport,
} from '../types.ts'
import { materialSnapshotKey, materialStateVersion } from './materials.ts'
import { sha256Hex } from './browser-crypto.ts'

export class MaterialSnapshotChanged extends Error {
  constructor() {
    super('文件、名单或规则刚有变化，请同步最新记录后继续。')
  }
}

// Join only a report bound to these exact workspace records. The server decides every displayed state.
export async function readMaterialRows(
  report: MaterialStateReport,
  collection: Collection,
  files: CollectedFile[],
): Promise<MaterialParticipant[]> {
  const active = files.filter((f) => f.collectionId === collection.id && !f.deletedAt)
  if (
    report.collectionId !== collection.id ||
    typeof report.rulesRevision !== 'string' ||
    report.rulesRevision !== collection.materialRevision ||
    typeof report.stateVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(report.stateVersion) ||
    JSON.stringify(report.requirements) !== JSON.stringify(collection.materials) ||
    !Array.isArray(report.files) ||
    report.files.length !== active.length ||
    !Array.isArray(report.participants)
  )
    throw new MaterialSnapshotChanged()
  const byId = new Map(active.map((f) => [f.id, f]))
  if (
    new Set(report.files.map((f) => f.id)).size !== active.length ||
    report.files.some(
      (f) => !byId.has(f.id) || f.expectedVersion !== materialStateVersion(byId.get(f.id)!),
    )
  )
    throw new MaterialSnapshotChanged()
  const expected = await sha256Hex(materialSnapshotKey(collection, active))
  if (report.stateVersion !== expected) throw new MaterialSnapshotChanged()
  const file = (id: string) => {
    const value = byId.get(id)
    if (!value) throw new MaterialSnapshotChanged()
    return value
  }
  return report.participants.map((p) => {
    const slots = p.slots.map((s) => {
      const requirement = report.requirements.find((m) => m.id === s.materialId)
      if (!requirement) throw new MaterialSnapshotChanged()
      return { requirement, state: s.state, duplicate: s.duplicate, files: s.fileIds.map(file) }
    })
    const unclassified = p.unclassifiedFileIds.map(file)
    return {
      identity: p.identity,
      owner: p.owner,
      expected: p.expected,
      status: p.status,
      receivedComplete: p.receivedComplete,
      reviewComplete: p.reviewComplete,
      duplicateCount: p.duplicateCount,
      slots,
      unclassified,
      files: [...slots.flatMap((s) => s.files), ...unclassified],
    }
  })
}
