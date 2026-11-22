import type { Workspace } from '../types.ts'

export interface MetadataExportPayload extends Workspace {
  exportMeta: {
    mode: 'sanitized' | 'full'
    exportedAt: string
    redactedFields: string[]
  }
}

export function buildMetadataExport(
  workspace: Workspace,
  options: { includeSensitive?: boolean; exportedAt?: string } = {},
): MetadataExportPayload {
  const includeSensitive = options.includeSensitive === true
  const exportedAt = options.exportedAt || new Date().toISOString()
  const collections = includeSensitive
    ? workspace.collections.map(({ accessCodeHash: _hash, accessCodeVersion: _ver, ...c }) => ({
        ...c,
        ...(c.expectedSubmitters ? { expectedSubmitters: [...c.expectedSubmitters] } : {}),
      }))
    : workspace.collections.map(
        ({
          uploadToken: _token,
          expectedSubmitters: _roster,
          accessCodeHash: _hash,
          accessCodeVersion: _ver,
          ...safeCollection
        }) => ({
          ...safeCollection,
        }),
      )
  return {
    ...workspace,
    collections,
    exportMeta: {
      mode: includeSensitive ? 'full' : 'sanitized',
      exportedAt,
      redactedFields: includeSensitive
        ? []
        : ['collections[].uploadToken', 'collections[].expectedSubmitters'],
    },
  }
}
