import type { CollectionTemplate } from '../types.ts'

export const collectionPresets: (CollectionTemplate & { summary: string })[] = [
  { id: 'builtin-club', name: '社团作品征集', summary: '两项必需材料 · 按报名编号核对 · 可分批补交', archived: false, rules: {
    title: '社团作品征集', description: '请提交本次活动报名表和作品说明，补充附件选填。可以分批提交，请保留本人回执。', category: 'document', target: 20, formats: 'PDF, DOCX, TXT, JPG, PNG', maxFileSizeMB: 50, maxFilesPerSubmission: 10, maxTotalSizeMB: 2048,
    fields: [{ id: 'field_registration', label: '报名编号', required: true }], identityField: 'field_registration', submissionMode: 'append', allowReplacement: true,
    materials: [{ id: 'mat_form', name: '报名表', required: true, description: '本次社团活动的报名信息。' }, { id: 'mat_statement', name: '作品说明', required: true, description: '本次活动的作品主题与介绍。' }, { id: 'mat_extra', name: '补充附件', required: false, description: '选填的展示或补充材料。' }],
  } },
  { id: 'builtin-homework', name: '作业收集', summary: '学号识别 · 班级信息 · 自动命名', archived: false, rules: {
    title: '作业收集', description: '请填写姓名、学号并上传作业。补交可继续提交，替换请保留本人私密回执。', category: 'document', target: 30, formats: 'PDF, DOCX, ZIP', maxFileSizeMB: 50, maxFilesPerSubmission: 5, maxTotalSizeMB: 2048,
    fields: [{ id: 'field_student', label: '学号', required: true }, { id: 'field_class', label: '班级', required: false }], identityField: 'field_student', naming: { parts: ['field_student', 'owner', 'original'], separator: '_' }, submissionMode: 'append', allowReplacement: true,
  } },
  { id: 'builtin-registration', name: '报名材料', summary: '报名编号识别 · 多份材料 · 支持替换', archived: false, rules: {
    title: '报名材料收集', description: '请填写报名编号并提交所需材料，具体要求请以活动通知为准。', category: 'document', target: 50, formats: 'PDF, DOCX, JPG, PNG, ZIP', maxFileSizeMB: 20, maxFilesPerSubmission: 10, maxTotalSizeMB: 2048,
    fields: [{ id: 'field_registration', label: '报名编号', required: true }, { id: 'field_group', label: '组别', required: false }], identityField: 'field_registration', naming: { parts: ['field_registration', 'owner', 'original'], separator: '_' }, submissionMode: 'append', allowReplacement: true,
  } },
  { id: 'builtin-delivery', name: '项目交付', summary: '项目与版本号 · 日期命名 · 分批交付', archived: false, rules: {
    title: '项目交付收集', description: '请填写项目编号与交付版本，上传本次交付文件。', category: 'design', target: 20, formats: 'ZIP, PDF, PNG, JPG, FIG, DOCX, XLSX', maxFileSizeMB: 500, maxFilesPerSubmission: 20, maxTotalSizeMB: 4096,
    fields: [{ id: 'field_project', label: '项目编号', required: true }, { id: 'field_version', label: '版本号', required: true }], identityField: 'field_project', naming: { parts: ['field_project', 'field_version', 'date', 'original'], separator: '_' }, submissionMode: 'append', allowReplacement: true,
  } },
]
