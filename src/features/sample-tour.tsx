import { useState } from 'react'
import { ArrowRight, Download, Sparkles } from 'lucide-react'
import type { Collection, Workspace } from '../types'
import { uploadFiles } from '../lib/api'
import { safeRandomUUID } from '../lib/browser-crypto'
import { collectionPresets } from '../lib/collection-presets'
import { nextWeek } from '../lib/collections'
import { materialParticipants } from '../lib/materials'
import { downloadText } from '../lib/workspace'

// Public synthetic texts, the same as examples/submission; nothing here describes a real person.
const sample = {
  form: '【公开合成样例，不含真实个人信息】\n报名编号：{id}\n展示名称：合成提交者\n活动：集屿材料收集演示\n报名意向：参加本次作品展示。\n',
  statement:
    '【公开合成样例】\n报名编号：DEMO-01\n作品主题：让零散文件有序归屿。\n当前介绍：演示如何按清单收集两份材料。\n',
  revisedForm:
    '【公开合成样例，不含真实个人信息】\n报名编号：DEMO-01\n展示名称：合成提交者\n活动：集屿材料收集演示\n报名意向：参加本次作品展示，已核对本次报名信息。\n',
  revisedStatement:
    '【公开合成样例】\n报名编号：DEMO-01\n作品主题：让零散文件有序归屿。\n当前介绍：演示如何按清单收集两份材料。\n使用过程：发起人列出报名表与作品说明，提交者按材料卡上传，发起人指出待补充处，本人凭私密回执替换本批。\n',
}
const storageKey = 'jiyu:sample-tour'
const textFile = (name: string, body: string) => new File([body], name, { type: 'text/plain' })

export function readSampleTour() {
  try {
    return localStorage.getItem(storageKey) || ''
  } catch {
    return ''
  }
}
function saveSampleTour(id: string) {
  try {
    if (id) localStorage.setItem(storageKey, id)
    else localStorage.removeItem(storageKey)
  } catch {
    /* The tour simply ends on reload. */
  }
}

/** Creates the sample task through the same create and public upload paths a real one uses. */
async function createSample(create: (body: unknown) => Promise<Workspace | undefined>) {
  const rules = collectionPresets.find((p) => p.id === 'builtin-club')!.rules
  const title = '【示例】社团作品征集'
  const workspace = await create({
    ...rules,
    title,
    description: '示例任务：内容全部是公开合成样例，用来体验缺件、核对和补交。可随时结束收集。',
    deadline: nextWeek(),
    storage: 'local',
    expectedSubmitters: ['DEMO-01', 'DEMO-02'],
  })
  // The server assigns the ID; collections come newest first.
  const c = workspace?.collections.find((x) => x.title === title)
  if (!c?.uploadToken) throw new Error('示例任务没有创建成功，请重试')
  const send = (owner: string, files: File[], materialIds: string[]) =>
    uploadFiles(
      c.uploadToken!,
      files,
      owner,
      safeRandomUUID(),
      () => {},
      new AbortController().signal,
      { fields: { field_registration: owner }, materialIds },
    )
  // DEMO-01 goes last: the browser keeps one receipt per link, and step 2 replaces DEMO-01's batch with it.
  await send(
    'DEMO-02',
    [textFile('报名表.txt', sample.form.replace('{id}', 'DEMO-02'))],
    ['mat_form'],
  )
  await send(
    'DEMO-01',
    [
      textFile('报名表.txt', sample.form.replace('{id}', 'DEMO-01')),
      textFile('作品说明.txt', sample.statement),
    ],
    ['mat_form', 'mat_statement'],
  )
  return c
}

function tourStep(c: Collection, workspace: Workspace) {
  const person = materialParticipants(c, workspace.files).find((p) => p.identity === 'DEMO-01')
  const replaced = (workspace.trash || []).some(
    (f) => f.collectionId === c.id && (f.participant || f.owner) === 'DEMO-01',
  )
  if (person?.reviewComplete)
    return {
      n: 4,
      title: '体验完成',
      why: 'DEMO-01 已人工通过。DEMO-02 还缺作品说明：材料矩阵里能导出缺件清单，也可以问右下角的 AI 助手“谁还没交齐”。',
    }
  if (person?.status === 'needs_changes')
    return {
      n: 2,
      title: '换成提交人，凭回执补交',
      why: '提交人不用登录。先下载两份补充后的文件，再打开提交页：它会用这台浏览器保存的回执查到 DEMO-01，按说明替换本批。',
    }
  if (replaced)
    return {
      n: 3,
      title: '核对补交的文件，人工通过',
      why: '替换后的新文件重新待核对，不会继承旧结论。打开 DEMO-01，逐份标“通过”。',
    }
  return {
    n: 1,
    title: '看谁缺什么，核对 DEMO-01',
    why: '材料矩阵里 DEMO-02 缺作品说明，DEMO-01 交齐了、待核对。打开 DEMO-01 的作品说明：可先让 AI 预核对（本站配置了模型时可用），再标“需补充”，写上缺使用过程。',
  }
}

export function SampleTourCard({
  canEdit,
  create,
  onStarted,
}: {
  canEdit: boolean
  create: (body: unknown) => Promise<Workspace | undefined>
  onStarted: (c: Collection) => void
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  if (!canEdit) return null
  async function start() {
    setBusy(true)
    setError('')
    try {
      const c = await createSample(create)
      saveSampleTour(c.id)
      onStarted(c)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="sample-tour-card" aria-label="3 分钟体验">
      <div>
        <h2>
          <Sparkles size={18} />3 分钟体验
        </h2>
        <p>生成一项标明“示例”的社团作品征集，已有两位合成提交人：一人交齐、一人缺件。</p>
      </div>
      <ol>
        <li>
          <b>看谁缺什么</b>
          <span>核对交齐的那份，标“需补充”</span>
        </li>
        <li>
          <b>换成提交人补交</b>
          <span>凭本人回执替换本批，不用登录</span>
        </li>
        <li>
          <b>人工通过</b>
          <span>新文件重新待核对，不继承旧结论</span>
        </li>
      </ol>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy} onClick={() => void start()}>
        {busy ? '正在生成示例…' : '生成示例任务'}
        <ArrowRight size={16} />
      </button>
    </section>
  )
}

export function SampleTourBar({
  workspace,
  onOpen,
}: {
  workspace: Workspace
  onOpen: (id: string) => void
}) {
  const [, setEnded] = useState(0)
  const c = workspace.collections.find((x) => x.id === readSampleTour())
  if (!c) return null
  const s = tourStep(c, workspace)
  const submitUrl = `${location.origin}/#/submit/${c.uploadToken}`
  return (
    <section className="sample-tour-bar" aria-label="示例体验进度">
      <div className="sample-tour-steps">
        {['核对材料', '提交人补交', '人工通过'].map((t, i) => (
          <span key={t} className={i + 1 < s.n ? 'done' : i + 1 === s.n ? 'on' : ''}>
            {i + 1 < s.n ? '✓' : i + 1} {t}
          </span>
        ))}
      </div>
      <div className="sample-tour-now">
        <b>
          {s.n < 4 ? `第 ${s.n} 步：` : ''}
          {s.title}
        </b>
        <span>{s.why}</span>
      </div>
      <div className="sample-tour-actions">
        {s.n === 2 ? (
          <>
            <button
              className="button"
              onClick={() => downloadText('补充后的报名表.txt', sample.revisedForm)}
            >
              <Download size={15} />
              补充后的报名表
            </button>
            <button
              className="button"
              onClick={() => downloadText('补充后的作品说明.txt', sample.revisedStatement)}
            >
              <Download size={15} />
              补充后的作品说明
            </button>
            <a className="button primary" href={submitUrl} target="_blank" rel="noreferrer">
              打开提交页
              <ArrowRight size={15} />
            </a>
          </>
        ) : (
          <button
            className="button primary"
            onClick={() => {
              onOpen(c.id)
              setTimeout(
                () =>
                  document
                    .querySelector('.material-workbench')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                300,
              )
            }}
          >
            去材料矩阵
            <ArrowRight size={15} />
          </button>
        )}
        <button
          className="text-button"
          onClick={() => {
            saveSampleTour('')
            setEnded((n) => n + 1)
          }}
        >
          结束体验
        </button>
      </div>
    </section>
  )
}

/** Shown on the public page of the sample task only, so the visitor knows what to do in the new tab. */
export function SampleSubmitHint({ collectionId, done }: { collectionId: string; done: boolean }) {
  if (readSampleTour() !== collectionId) return null
  if (done)
    return (
      <p className="sample-submit-hint" role="note">
        示例体验：这一步完成了。回到原来的标签页，以发起人身份核对补交的文件。
      </p>
    )
  return (
    <p className="sample-submit-hint" role="note">
      示例体验：点下方“已经交过？查询回执 / 替换文件”，会用这台浏览器保存的回执查到 DEMO-01
      这一批；再点“按说明替换本批文件”，在报名表和作品说明下分别上传刚下载的两份补充文件并提交。完成后回到原标签页。
    </p>
  )
}
