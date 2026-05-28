import { prisma } from '../plugins/db.js'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import ExcelJS from 'exceljs'
import { styleHeaderRow, setTitleRow, setStatRow, FONT_MS_YAHEI, COLOR_TEXT_DARK, COLOR_BG_ALT_ROW, COLOR_BORDER } from './roster.js'

const UPLOAD_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../uploads')

/**
 * 确保上传目录存在
 */
async function ensureUploadDir(classId) {
  const dir = path.join(UPLOAD_DIR, String(classId))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * 获取班级的信息收集配置
 * @param {number} classId
 */
export async function getInfoCollection(classId) {
  const collection = await prisma.infoCollection.findUnique({
    where: { classId },
    include: { fields: { orderBy: { sortOrder: 'asc' } } },
  })
  return collection
}

/**
 * 更新信息收集开关状态
 * @param {number} classId
 * @param {boolean} enabled
 */
export async function updateInfoCollection(classId, enabled) {
  const collection = await prisma.infoCollection.upsert({
    where: { classId },
    update: { enabled },
    create: { classId, enabled },
  })
  return collection
}

/**
 * 创建收集字段
 * @param {number} collectionId
 * @param {{ name: string, type: 'text'|'attachment', required: boolean }} data
 */
export async function createInfoField(collectionId, data) {
  const allowedTypes = ['text', 'attachment']
  if (!allowedTypes.includes(data.type)) {
    throw new Error('无效的字段类型')
  }
  const maxOrder = await prisma.infoField.aggregate({
    where: { collectionId },
    _max: { sortOrder: true },
  })
  return prisma.infoField.create({
    data: {
      collectionId,
      name: data.name.trim(),
      type: data.type,
      required: data.required ?? false,
      sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
    },
  })
}

/**
 * 更新字段
 * @param {number} fieldId
 * @param {{ name?: string, required?: boolean }} data
 */
export async function updateInfoField(fieldId, data) {
  const updateData = {}
  if (data.name !== undefined) updateData.name = data.name.trim()
  if (data.required !== undefined) updateData.required = data.required
  return prisma.infoField.update({
    where: { id: fieldId },
    data: updateData,
  })
}

/**
 * 删除字段
 * @param {number} fieldId
 */
export async function deleteInfoField(fieldId) {
  return prisma.$transaction(async (tx) => {
    await tx.infoResponse.deleteMany({ where: { fieldId } })
    await tx.infoField.delete({ where: { id: fieldId } })
  })
}

/**
 * 更新字段排序
 * @param {number} fieldId
 * @param {number} newOrder
 */
export async function updateFieldSortOrder(fieldId, newOrder) {
  return prisma.infoField.update({
    where: { id: fieldId },
    data: { sortOrder: newOrder },
  })
}

/**
 * 提交信息（学生端）
 * @param {number} classId
 * @param {string} studentName
 * @param {number} studentId
 * @param {Array<{ fieldId: number, textValue?: string, fileUrl?: string }>} responses
 */
export async function submitInfo(classId, studentName, studentId, responses) {
  const collection = await prisma.infoCollection.findUnique({
    where: { classId },
    include: { fields: true },
  })
  if (!collection || !collection.enabled) {
    throw new Error('信息收集未启用')
  }

  if (!Array.isArray(responses) || responses.length === 0) {
    throw new Error('提交数据无效')
  }
  // 不能超过配置的字段数量
  if (responses.length > collection.fields.length) {
    throw new Error('提交数据异常（字段数量过多）')
  }

  // Validate all fieldIds belong to this class's collection
  const validFieldIds = new Set(collection.fields.map(f => f.id))
  for (const resp of responses) {
    if (!validFieldIds.has(resp.fieldId)) {
      throw new Error('包含无效的字段ID')
    }
    // 限制文本字段长度
    if (resp.textValue && resp.textValue.length > 5000) {
      throw new Error('文本内容过长（最大 5000 字符）')
    }
  }

  // 检查必填字段
  const fieldMap = new Map(collection.fields.map(f => [f.id, f]))
  for (const resp of responses) {
    const field = fieldMap.get(resp.fieldId)
    if (field?.required && !resp.textValue && !resp.fileUrl) {
      throw new Error(`必填字段 "${field.name}" 不能为空`)
    }
  }

  return prisma.$transaction(async (tx) => {
    const submission = await tx.infoSubmission.create({
      data: {
        classId,
        studentId: studentId ?? null,
        studentName,
        responses: {
          create: responses.map(r => ({
            fieldId: r.fieldId,
            textValue: r.textValue ?? null,
            fileUrl: r.fileUrl ?? null,
          })),
        },
      },
      include: { responses: { include: { field: true } } },
    })
    return submission
  })
}

/**
 * 获取班级所有提交（按提交时间倒序）
 * @param {number} classId
 */
export async function getSubmissions(classId) {
  return prisma.infoSubmission.findMany({
    where: { classId },
    orderBy: { submittedAt: 'desc' },
    include: {
      responses: {
        include: { field: true },
        orderBy: { field: { sortOrder: 'asc' } },
      },
    },
  })
}

/**
 * 获取单个提交详情
 * @param {number} submissionId
 */
export async function getSubmissionDetail(submissionId) {
  return prisma.infoSubmission.findUnique({
    where: { id: submissionId },
    include: {
      responses: {
        include: { field: true },
        orderBy: { field: { sortOrder: 'asc' } },
      },
    },
  })
}

/**
 * 删除提交
 * @param {number} submissionId
 * @param {number} [classId] 可选，用于防御性鉴权——验证提交属于指定班级
 */
export async function deleteSubmission(submissionId, classId = null) {
  if (classId) {
    const submission = await prisma.infoSubmission.findUnique({
      where: { id: submissionId },
      select: { classId: true },
    })
    if (!submission || submission.classId !== classId) {
      throw new Error('提交不存在或无权删除')
    }
  }
  return prisma.infoSubmission.delete({
    where: { id: submissionId },
  })
}

/**
 * 已知文件类型的 magic bytes 签名
 */
const MAGIC_BYTES = {
  '.jpg': [[0xFF, 0xD8, 0xFF]],
  '.jpeg': [[0xFF, 0xD8, 0xFF]],
  '.png': [[0x89, 0x50, 0x4E, 0x47]],
  '.pdf': [[0x25, 0x50, 0x44, 0x46]],
  '.doc': [[0xD0, 0xCF, 0x11, 0xE0]],
  '.docx': [[0x50, 0x4B, 0x03, 0x04]],
  '.xlsx': [[0x50, 0x4B, 0x03, 0x04]],
  '.xls': [[0xD0, 0xCF, 0x11, 0xE0]],
}

/**
 * 检查 buffer 是否匹配任一 magic bytes 签名
 */
function matchesMagicBytes(buffer, ext) {
  const signatures = MAGIC_BYTES[ext]
  if (!signatures) return true // unknown type, skip check
  for (const sig of signatures) {
    if (buffer.length >= sig.length && sig.every((b, i) => buffer[i] === b)) {
      return true
    }
  }
  return false
}

/**
 * 上传附件文件
 * @param {number} classId
 * @param {Buffer} buffer
 * @param {string} originalFilename
 * @returns {{ url: string, path: string }}
 */
export async function uploadAttachment(classId, buffer, originalFilename) {
  const ext = path.extname(originalFilename).toLowerCase()
  const allowedExts = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.xlsx', '.xls']
  if (!allowedExts.includes(ext)) {
    throw new Error('不支持的文件类型')
  }
  if (buffer.length < 2) {
    throw new Error('文件无效（文件太小）')
  }
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error('文件大小不能超过 10MB')
  }
  if (!matchesMagicBytes(buffer, ext)) {
    throw new Error('文件内容与类型不匹配')
  }

  const dir = await ensureUploadDir(classId)
  const randomName = randomBytes(8).toString('hex')
  const filename = `${Date.now()}_${randomName}${ext}`
  const filePath = path.join(dir, filename)
  const url = `/uploads/${classId}/${filename}`

  await fs.writeFile(filePath, buffer)
  return { url, path: filePath }
}

/**
 * 获取提交统计信息
 * @param {number} classId
 */
export async function getSubmissionsStats(classId) {
  const [collection, submissions] = await Promise.all([
    prisma.infoCollection.findUnique({
      where: { classId },
      include: { fields: { orderBy: { sortOrder: 'asc' } } },
    }),
    prisma.infoSubmission.findMany({
      where: { classId },
      select: { studentName: true, studentId: true },
    }),
  ])

  const submittedStudents = new Set(submissions.map(s => s.studentId ?? s.studentName))
  return {
    enabled: collection?.enabled ?? false,
    fields: collection?.fields ?? [],
    submittedCount: submittedStudents.size,
  }
}

/**
 * 导出信息收集数据为 Excel
 * @param {number} classId
 * @returns {Promise<Buffer>}
 */
export async function exportInfoSubmissionsToExcel(classId) {
  const [collection, submissions] = await Promise.all([
    prisma.infoCollection.findUnique({
      where: { classId },
      include: { fields: { orderBy: { sortOrder: 'asc' } } },
    }),
    prisma.infoSubmission.findMany({
      where: { classId },
      orderBy: { submittedAt: 'desc' },
      include: {
        responses: {
          include: { field: true },
          orderBy: { field: { sortOrder: 'asc' } },
        },
      },
    }),
  ])

  if (!collection || !collection.fields.length) {
    throw new Error('没有可导出的数据')
  }

  const fields = collection.fields
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Lab Attendance'
  const ws = workbook.addWorksheet('信息收集', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
  })

  // 设置列
  const columns = [
    { key: 'studentName', header: '学生姓名', width: 14 },
    { key: 'submittedAt', header: '提交时间', width: 20 },
  ]
  fields.forEach(f => {
    columns.push({
      key: `field_${f.id}`,
      header: f.name,
      width: f.type === 'attachment' ? 16 : 14,
    })
  })
  ws.columns = columns

  const COL_SPAN = columns.length
  setTitleRow(ws, 1, COL_SPAN, '信息收集数据导出', true)
  setStatRow(ws, 2, COL_SPAN, `共 ${submissions.length} 条提交记录    导出时间：${new Date().toLocaleString('zh-CN')}`)

  const headerRow = ws.addRow(['学生姓名', '提交时间', ...fields.map(f => f.name)])
  styleHeaderRow(headerRow)

  submissions.forEach((s, idx) => {
    const isEven = idx % 2 === 0
    const row = ws.addRow([
      s.studentName,
      new Date(s.submittedAt).toLocaleString('zh-CN'),
      ...fields.map(f => {
        const resp = s.responses.find(r => r.fieldId === f.id)
        if (!resp) return '-'
        if (f.type === 'attachment') {
          return resp.fileUrl ? `[附件] ${resp.fileUrl}` : '-'
        }
        return resp.textValue || '-'
      }),
    ])
    row.height = 20
    row.eachCell((cell, colNumber) => {
      cell.font = { ...FONT_MS_YAHEI, size: 10, color: { argb: COLOR_TEXT_DARK } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? 'FFFFFFFF' : COLOR_BG_ALT_ROW } }
      cell.alignment = { horizontal: colNumber <= 2 ? 'left' : 'center', vertical: 'middle' }
      cell.border = { bottom: { style: 'hair', color: { argb: COLOR_BORDER } } }
    })
  })

  return workbook.xlsx.writeBuffer()
}
