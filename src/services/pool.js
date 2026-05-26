import { prisma } from '../plugins/db.js'
import ExcelJS from 'exceljs'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.resolve(__dirname, '../../uploads/photos')

/**
 * 获取班级池中的所有班级（teacherId IS NULL）
 */
export async function getPoolClasses() {
  const classes = await prisma.class.findMany({
    where: { teacherId: null, isArchived: false },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { students: true } },
    },
  })
  return classes.map(c => ({
    id: c.id,
    name: c.name,
    studentCount: c._count.students,
    createdAt: c.createdAt,
  }))
}

/**
 * 在班级池中创建班级（teacherId = null）
 */
export async function createPoolClass(name) {
  return prisma.class.create({
    data: {
      name,
      teacherId: null,
      signInConfig: { create: {} },
    },
  })
}

/**
 * 教师认领班级池中的班级
 */
export async function claimPoolClass(classId, teacherId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls) return { ok: false, message: '班级不存在', status: 404 }
  if (cls.teacherId !== null) return { ok: false, message: '该班级已被其他教师认领', status: 409 }

  // 检查教师是否已有同名班级
  const existing = await prisma.class.findFirst({
    where: { teacherId, name: cls.name, isArchived: false },
  })
  if (existing) return { ok: false, message: `你已有同名班级「${cls.name}」，请先删除或归档后再认领`, status: 409 }

  await prisma.class.update({
    where: { id: classId },
    data: { teacherId },
  })

  return { ok: true, message: `已认领班级「${cls.name}」` }
}

/**
 * 从 Excel 导入学生到班级池指定班级
 * 支持有表头和无表头两种格式
 * 列：A=行政班(可选), B=学生姓名(必需), C=备注(可选)
 */
export async function importPoolStudentsFromExcel(classId, buffer) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls || cls.teacherId !== null) return { ok: false, message: '班级不存在或不属于班级池', status: 404 }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const worksheet = workbook.worksheets[0]

  const HEADER_KEYWORDS = new Set(['行政班', '行政班级', '姓名', '学生姓名', '备注', '教学班'])
  const rows = []
  worksheet.eachRow((row) => {
    const c1 = row.getCell(1).value
    const c2 = row.getCell(2).value
    const c3 = row.getCell(3).value
    if (c1 == null || String(c1).trim() === '') return
    if (HEADER_KEYWORDS.has(String(c1).trim())) return

    rows.push({
      homeClass: String(c1).trim(),
      name: String(c2).trim(),
      remark: c3 != null ? String(c3).trim() : '',
    })
  })

  // 过滤掉姓名为空的行
  const validRows = rows.filter(r => r.name && r.name !== '')

  if (validRows.length === 0) return { ok: false, message: '未找到有效学生数据' }

  // 获取已有学生
  const existing = await prisma.student.findMany({
    where: { classId },
    select: { name: true },
  })
  const existingSet = new Set(existing.map(s => s.name))

  const toInsert = []
  const seen = new Set()
  for (const r of validRows) {
    if (existingSet.has(r.name) || seen.has(r.name)) continue
    seen.add(r.name)
    toInsert.push({
      name: r.name,
      homeClass: r.homeClass,
      remark: r.remark,
      classId,
    })
  }

  if (toInsert.length === 0) return { ok: true, count: 0, message: '所有学生已存在' }

  const res = await prisma.student.createMany({ data: toInsert })
  return { ok: true, count: res.count, message: `导入 ${res.count} 名学生` }
}

/**
 * 上传学生照片
 * @param {number} classId - 班级 ID
 * @param {number} studentId - 学生 ID
 * @param {Buffer} fileBuffer - 图片数据
 * @param {string} filename - 原始文件名
 * @returns {{ ok: boolean, url: string, message?: string }}
 */
export async function uploadStudentPhoto(classId, studentId, fileBuffer, filename) {
  const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
  const ext = path.extname(filename).toLowerCase()
  const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

  if (!ALLOWED_EXTS.has(ext)) {
    return { ok: false, message: '仅支持 JPG、PNG、WebP 格式图片' }
  }

  const MAX_SIZE = 5 * 1024 * 1024 // 5MB
  if (fileBuffer.length > MAX_SIZE) {
    return { ok: false, message: '图片大小不能超过 5MB' }
  }

  // 验证学生归属
  const student = await prisma.student.findUnique({ where: { id: studentId } })
  if (!student || student.classId !== classId) {
    return { ok: false, message: '学生不存在或不属于该班级' }
  }

  // 保存到 uploads/photos/{YYYY}/{MM}/{original_filename}
  // 文件名冲突时添加时间戳后缀
  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const yearDir = path.join(UPLOAD_DIR, year)
  const monthDir = path.join(yearDir, month)
  await fs.mkdir(monthDir, { recursive: true })

  // 处理文件名冲突：检查文件是否存在，存在则添加 _1, _2... 后缀
  const baseName = path.basename(filename, ext)
  let safeFilename = `${baseName}${ext}`
  let counter = 1
  while (await fs.access(path.join(monthDir, safeFilename)).then(() => true).catch(() => false)) {
    safeFilename = `${baseName}_${counter}${ext}`
    counter++
  }

  const filePath = path.join(monthDir, safeFilename)
  await fs.writeFile(filePath, fileBuffer)

  const url = `/uploads/photos/${year}/${month}/${safeFilename}`

  // 删除旧照片（如果有）
  if (student.photoUrl) {
    try {
      const oldPath = path.resolve(__dirname, '../../', student.photoUrl.replace(/^\//, ''))
      await fs.unlink(oldPath)
    } catch {
      // 旧文件不存在，忽略
    }
  }

  await prisma.student.update({
    where: { id: studentId },
    data: { photoUrl: url },
  })

  return { ok: true, url, message: '照片已上传' }
}

/**
 * 批量上传照片 — 按文件名匹配学生姓名
 * @param {number} classId - 班级 ID
 * @param {{ filename: string, buffer: Buffer }[]} files - 照片文件列表
 * @returns {{ ok: boolean, matched: number, unmatched: string[] }}
 */
export async function bulkUploadPhotos(classId, files) {
  const students = await prisma.student.findMany({
    where: { classId },
    select: { id: true, name: true, photoUrl: true },
  })
  const studentMap = new Map()
  for (const s of students) {
    studentMap.set(s.name, s)
  }

  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const yearDir = path.join(UPLOAD_DIR, year)
  const monthDir = path.join(yearDir, month)
  await fs.mkdir(monthDir, { recursive: true })

  const existingFiles = new Set()
  try {
    const entries = await fs.readdir(monthDir)
    for (const entry of entries) existingFiles.add(entry)
  } catch { /* 空 */ }

  const matched = []
  const unmatched = []
  const writeTasks = []
  const dbUpdates = []

  for (const file of files) {
    const nameKey = path.basename(file.filename, path.extname(file.filename)).trim()
    const student = studentMap.get(nameKey)
    if (!student) {
      unmatched.push(file.filename)
      continue
    }

    // 确定不冲突的文件名
    const ext = path.extname(file.filename).toLowerCase()
    const baseName = path.basename(file.filename, ext)
    let safeFilename = `${baseName}${ext}`
    let counter = 1
    while (existingFiles.has(safeFilename)) {
      safeFilename = `${baseName}_${counter}${ext}`
      counter++
    }
    existingFiles.add(safeFilename)

    const url = `/uploads/photos/${year}/${month}/${safeFilename}`
    const filePath = path.join(monthDir, safeFilename)

    matched.push({ name: nameKey, url })
    writeTasks.push({ buffer: file.buffer, filePath, student })
    dbUpdates.push({ studentId: student.id, photoUrl: url })
  }

  // 分批写文件
  const BATCH_SIZE = 20
  if (writeTasks.length > 0) {
    for (let i = 0; i < writeTasks.length; i += BATCH_SIZE) {
      const batch = writeTasks.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(t => fs.writeFile(t.filePath, t.buffer)))
    }
  }

  // 批量更新数据库（每批 20 个）
  const BATCH_SIZE = 20
  for (let i = 0; i < dbUpdates.length; i += BATCH_SIZE) {
    const batch = dbUpdates.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(u =>
        prisma.student.update({
          where: { id: u.studentId },
          data: { photoUrl: u.photoUrl },
        })
      )
    )
  }

  return { ok: true, matched: matched.length, unmatched }
}

/**
 * 删除学生照片
 */
export async function deleteStudentPhoto(studentId, classId) {
  const student = await prisma.student.findUnique({ where: { id: studentId } })
  if (!student || student.classId !== classId) {
    return { ok: false, message: '学生不存在或不属于该班级' }
  }

  if (student.photoUrl) {
    try {
      const oldPath = path.resolve(__dirname, '../../', student.photoUrl.replace(/^\//, ''))
      await fs.unlink(oldPath)
    } catch {
      // 忽略
    }
  }

  await prisma.student.update({
    where: { id: studentId },
    data: { photoUrl: '' },
  })

  return { ok: true, message: '照片已删除' }
}

/**
 * 批量从 Excel 导入学生到班级池（按 A 列班级名自动匹配）
 * Excel 格式：A=班级名称，B=行政班，C=学生姓名
 */
export async function batchImportPoolStudentsFromExcel(buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const worksheet = workbook.worksheets[0]

  const HEADER_KEYWORDS = new Set(['班级', '名称', '行政班', '行政班级', '姓名', '学生姓名', '备注', '教学班', '教学班名'])
  const rows = []
  worksheet.eachRow((row) => {
    const c1 = row.getCell(1).value
    const c2 = row.getCell(2).value
    const c3 = row.getCell(3).value
    if (c1 == null || String(c1).trim() === '') return
    if (HEADER_KEYWORDS.has(String(c1).trim())) return

    rows.push({
      className: String(c1).trim(),
      homeClass: c2 != null ? String(c2).trim() : '',
      name: c3 != null ? String(c3).trim() : '',
    })
  })

  // 过滤掉姓名为空的行
  const validRows = rows.filter(r => r.name && r.name !== '')
  if (validRows.length === 0) return { ok: false, message: '未找到有效学生数据' }

  // 获取所有班级池班级
  const poolClasses = await prisma.class.findMany({
    where: { teacherId: null },
    select: { id: true, name: true },
  })
  const classMap = new Map()
  for (const cls of poolClasses) {
    classMap.set(cls.name, cls)
  }

  let totalCount = 0
  const newClasses = []

  // 按班级名分组
  const grouped = new Map()
  for (const r of validRows) {
    if (!grouped.has(r.className)) grouped.set(r.className, [])
    grouped.get(r.className).push(r)
  }

  for (const [className, students] of grouped) {
    let cls = classMap.get(className)
    if (!cls) {
      // 自动创建班级池班级
      cls = await prisma.class.create({
        data: { name: className, teacherId: null, signInConfig: { create: {} } },
      })
      classMap.set(className, cls)
      newClasses.push(className)
    }

    const existing = await prisma.student.findMany({
      where: { classId: cls.id },
      select: { name: true },
    })
    const existingSet = new Set(existing.map(s => s.name))
    const toInsert = []
    const seen = new Set()
    for (const r of students) {
      if (existingSet.has(r.name) || seen.has(r.name)) continue
      seen.add(r.name)
      toInsert.push({ name: r.name, homeClass: r.homeClass, classId: cls.id })
    }

    if (toInsert.length > 0) {
      const res = await prisma.student.createMany({ data: toInsert })
      totalCount += res.count
    }
  }

  let msg = `导入 ${totalCount} 名学生`
  if (newClasses.length) msg += `，新建 ${newClasses.length} 个班级（${newClasses.join('、')}）`
  return { ok: true, count: totalCount, newClasses, message: msg }
}

/**
 * 批量上传照片到班级池 — 文件名直接匹配学生姓名（跨所有班级池班级）
 * 优化：批量 DB 操作，避免 800+ 张照片产生 1600+ 次查询
 */
export async function batchUploadPoolPhotos(files) {
  // 加载所有班级池班级和学生
  const poolClasses = await prisma.class.findMany({
    where: { teacherId: null },
    include: { students: true },
  })

  // 构建 studentName -> { classId, student } 映射
  const studentMap = new Map()
  for (const cls of poolClasses) {
    for (const s of cls.students) {
      if (!studentMap.has(s.name)) {
        studentMap.set(s.name, { classId: cls.id, student: s })
      }
    }
  }

  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const yearDir = path.join(UPLOAD_DIR, year)
  const monthDir = path.join(yearDir, month)
  await fs.mkdir(monthDir, { recursive: true })

  // 扫描已有文件，用于冲突检测
  const existingFiles = new Set()
  try {
    const entries = await fs.readdir(monthDir)
    for (const entry of entries) existingFiles.add(entry)
  } catch { /* 目录不存在或为空 */ }

  // 第 1 步：匹配 + 确定文件名
  const matched = []
  const unmatched = []
  const writeTasks = [] // { buffer, filePath }
  const dbUpdates = []  // { studentId, photoUrl }

  for (const file of files) {
    const nameKey = path.basename(file.filename, path.extname(file.filename)).trim()
    const match = studentMap.get(nameKey)
    if (!match) {
      unmatched.push(file.filename)
      continue
    }

    // 确定不冲突的文件名
    const ext = path.extname(file.filename).toLowerCase()
    const baseName = path.basename(file.filename, ext)
    let safeFilename = `${baseName}${ext}`
    let counter = 1
    while (existingFiles.has(safeFilename)) {
      safeFilename = `${baseName}_${counter}${ext}`
      counter++
    }
    existingFiles.add(safeFilename)

    const url = `/uploads/photos/${year}/${month}/${safeFilename}`
    const filePath = path.join(monthDir, safeFilename)

    matched.push({ name: nameKey, url })
    writeTasks.push({ buffer: file.buffer, filePath })
    dbUpdates.push({ studentId: match.student.id, photoUrl: url })
  }

  // 第 2 步：分批并行写文件（避免 EMFILE）
  const BATCH_SIZE = 20
  if (writeTasks.length > 0) {
    for (let i = 0; i < writeTasks.length; i += BATCH_SIZE) {
      const batch = writeTasks.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(t => fs.writeFile(t.filePath, t.buffer)))
    }
  }

  // 第 3 步：分批更新数据库
  if (dbUpdates.length > 0) {
    for (let i = 0; i < dbUpdates.length; i += BATCH_SIZE) {
      const batch = dbUpdates.slice(i, i + BATCH_SIZE)
      await Promise.all(
        batch.map(u =>
          prisma.student.update({
            where: { id: u.studentId },
            data: { photoUrl: u.photoUrl },
          })
        )
      )
    }
  }

  return { ok: true, matched: matched.length, unmatched }
}
