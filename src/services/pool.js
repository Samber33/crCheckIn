import { prisma } from '../plugins/db.js'
import ExcelJS from 'exceljs'
import path from 'path'
import fs from 'fs/promises'
import fsSync from 'fs'
import { randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.resolve(__dirname, '../../uploads/photos')

// 照片同步防抖：批量上传时延迟同步，避免 N+1 问题
const _pendingSyncPoolClassIds = new Set()
const _pendingSyncTeacherClassIds = new Set()
let _syncTimer = null

function _schedulePoolSync(classId) {
  _pendingSyncPoolClassIds.add(classId)
  _flushSyncTimer()
}

function _scheduleTeacherSync(classId) {
  _pendingSyncTeacherClassIds.add(classId)
  _flushSyncTimer()
}

function _flushSyncTimer() {
  if (_syncTimer) return
  _syncTimer = setTimeout(async () => {
    _syncTimer = null
    const poolIds = [..._pendingSyncPoolClassIds]
    const teacherIds = [..._pendingSyncTeacherClassIds]
    _pendingSyncPoolClassIds.clear()
    _pendingSyncTeacherClassIds.clear()
    for (const cid of poolIds) {
      try { await syncPoolPhotosToTeacherClasses(cid) } catch {}
    }
    for (const cid of teacherIds) {
      try { await syncTeacherPhotoToPool(cid) } catch {}
    }
  }, 500)
}

// 数据库写入队列：序列化并发写入，避免 SQLite 锁竞争导致超时
const _writeQueue = []
let _writeProcessing = false

async function _enqueueWrite(fn) {
  return new Promise((resolve, reject) => {
    _writeQueue.push({ fn, resolve, reject })
    _processWriteQueue()
  })
}

async function _processWriteQueue() {
  if (_writeProcessing) return
  _writeProcessing = true
  while (_writeQueue.length > 0) {
    const { fn, resolve, reject } = _writeQueue.shift()
    try {
      resolve(await fn())
    } catch (err) {
      reject(err)
    }
  }
  _writeProcessing = false
}

/**
 * 标准化姓名用于匹配：去除空白、全角转半角、去除标点等
 */
function normalizeName(name) {
  return name
    .replace(/[﻿​‌‍ ]/g, '')   // BOM、零宽空格、不间断空格
    .trim()
    .replace(/\s+/g, '')                                   // 去除所有空白
    .replace(/[（）()【】\[\]《》<>「」『』""''、，。：:；;！!？?～~·]/g, '') // 去除中英文标点
    .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角字母→半角
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字→半角
    .replace(/^[.\-_\s]+|[.\-_\s]+$/g, '')                 // 去除首尾标点
    .toLowerCase()
}

/**
 * 获取班级池中的所有班级（teacherId IS NULL，未删除）
 * @param {object} [opts]
 * @param {string} [opts.semester] - 按学期筛选，空字符串=当前未归档
 * @param {number} [opts.teacherId] - 当前教师ID，用于判断认领状态
 */
export async function getPoolClasses(opts = {}) {
  const where = { teacherId: null, deletedAt: null }
  if (opts.semester !== undefined) {
    where.semester = opts.semester
  } else {
    where.isArchived = false
  }
  const classes = await prisma.class.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { students: true } },
      students: {
        select: { homeClass: true },
      },
    },
  })

  // 获取所有教师班级的名称，用于判断认领状态
  const teacherClassNames = await prisma.class.findMany({
    where: { teacherId: { not: null }, deletedAt: null },
    select: { name: true, teacherId: true },
  })
  const nameToTeachers = new Map()
  for (const tc of teacherClassNames) {
    if (!nameToTeachers.has(tc.name)) nameToTeachers.set(tc.name, new Set())
    nameToTeachers.get(tc.name).add(tc.teacherId)
  }

  return classes.map(c => {
    // 计算行政班组成
    const homeClassCount = new Map()
    for (const s of c.students) {
      const hc = s.homeClass || '未分组'
      homeClassCount.set(hc, (homeClassCount.get(hc) || 0) + 1)
    }
    // 按人数降序排列
    const homeClassGroups = [...homeClassCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }))

    const teachers = nameToTeachers.get(c.name)
    return {
      id: c.id,
      name: c.name,
      school: c.school,
      studentCount: c._count.students,
      homeClassGroups,
      semester: c.semester,
      isArchived: c.isArchived,
      createdAt: c.createdAt,
      claimedByAnyTeacher: !!teachers && teachers.size > 0,
      claimedByCurrentTeacher: !!teachers && opts.teacherId != null && teachers.has(opts.teacherId),
    }
  })
}

/**
 * 获取回收站中的班级（已软删除）
 */
export async function getRecycleBinClasses() {
  const classes = await prisma.class.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
    include: {
      _count: { select: { students: true } },
    },
  })
  return classes.map(c => ({
    id: c.id,
    name: c.name,
    studentCount: c._count.students,
    deletedAt: c.deletedAt ? new Date(c.deletedAt).toLocaleDateString('zh-CN') : '',
  }))
}

/**
 * 软删除班级池班级（移入回收站）
 */
export async function softDeletePoolClass(classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls || cls.teacherId !== null) return { ok: false, message: '班级不存在或不属于班级池' }
  await prisma.class.update({
    where: { id: classId },
    data: { deletedAt: new Date() },
  })
  return { ok: true, message: `「${cls.name}」已移入回收站` }
}

/**
 * 恢复回收站中的班级
 */
export async function restorePoolClass(classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls || cls.deletedAt === null) return { ok: false, message: '班级不在回收站中' }
  await prisma.class.update({
    where: { id: classId },
    data: { deletedAt: null },
  })
  return { ok: true, message: `「${cls.name}」已恢复` }
}

/**
 * 彻底删除回收站中的班级（连同学生数据）
 */
export async function hardDeletePoolClass(classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls || cls.deletedAt === null) return { ok: false, message: '班级不在回收站中' }
  const { deleteClassesCascadeWithTx } = await import('./class.js')
  await prisma.$transaction(async (tx) => {
    await deleteClassesCascadeWithTx(tx, [classId])
  })
  return { ok: true, message: `「${cls.name}」已彻底删除` }
}

/**
 * 将班级池中的照片同步到同名教师班级
 * @param {number} poolClassId - 班级池班级 ID
 * @returns {{ ok: boolean, synced: number }}
 */
export async function syncPoolPhotosToTeacherClasses(poolClassId) {
  const poolClass = await prisma.class.findUnique({ where: { id: poolClassId } })
  if (!poolClass || poolClass.teacherId !== null) return { ok: false, synced: 0 }

  // 查找所有同名的教师班级
  const teacherClasses = await prisma.class.findMany({
    where: { name: poolClass.name, teacherId: { not: null }, deletedAt: null },
    select: { id: true },
  })
  if (teacherClasses.length === 0) return { ok: true, synced: 0 }

  // 获取班级池中所有学生（含照片和无照片）
  const poolStudents = await prisma.student.findMany({
    where: { classId: poolClassId },
    select: { name: true, photoUrl: true, homeClass: true },
  })
  // 班级池中有照片的学生
  const poolPhotoMap = new Map(
    poolStudents
      .filter(s => s.photoUrl)
      .map(s => [normalizeName(s.name), s])
  )
  // 班级池中无照片的学生姓名集合
  const poolNoPhotoSet = new Set(
    poolStudents
      .filter(s => !s.photoUrl)
      .map(s => normalizeName(s.name))
  )

  let totalSynced = 0

  for (const tc of teacherClasses) {
    const teacherStudents = await prisma.student.findMany({
      where: { classId: tc.id },
      select: { id: true, name: true, photoUrl: true },
    })

    const updatePhotoIds = []
    const clearPhotoIds = []
    const insertData = []

    for (const ts of teacherStudents) {
      const normName = normalizeName(ts.name)
      const poolPhoto = poolPhotoMap.get(normName)
      if (poolPhoto) {
        // 班级池有照片，教师没有 → 更新
        if (!ts.photoUrl) {
          updatePhotoIds.push({ id: ts.id, photoUrl: poolPhoto.photoUrl })
          totalSynced++
        }
      } else if (ts.photoUrl && poolNoPhotoSet.has(normName)) {
        // 班级池无照片，教师有 → 清除
        clearPhotoIds.push(ts.id)
        totalSynced++
      } else if (ts.photoUrl && !poolPhotoMap.has(normName) && !poolNoPhotoSet.has(normName)) {
        // 班级池中不存在该学生，但教师有照片 → 保留（不做处理）
      }
    }

    // 班级池有但教师没有的学生：复制过去
    const teacherNameSet = new Set(teacherStudents.map(s => normalizeName(s.name)))
    for (const [normName, ps] of poolPhotoMap) {
      if (!teacherNameSet.has(normName)) {
        insertData.push({
          name: ps.name,
          homeClass: ps.homeClass,
          photoUrl: ps.photoUrl,
          classId: tc.id,
        })
        totalSynced++
      }
    }

    // 批量更新照片（使用 Prisma transaction 批量执行）
    if (updatePhotoIds.length > 0) {
      await prisma.$transaction(
        updatePhotoIds.map(u =>
          prisma.student.update({ where: { id: u.id }, data: { photoUrl: u.photoUrl } })
        )
      )
    }

    // 批量清除照片
    if (clearPhotoIds.length > 0) {
      await prisma.$transaction(
        clearPhotoIds.map(id =>
          prisma.student.update({ where: { id }, data: { photoUrl: '' } })
        )
      )
    }

    // 批量插入
    if (insertData.length > 0) {
      await prisma.student.createMany({ data: insertData })
    }
  }

  return { ok: true, synced: totalSynced }
}

/**
 * 教师端上传照片后，同步到同名班级池班级
 * @param {number} teacherClassId - 教师班级 ID
 */
export async function syncTeacherPhotoToPool(teacherClassId) {
  const teacherClass = await prisma.class.findUnique({ where: { id: teacherClassId } })
  if (!teacherClass || teacherClass.teacherId === null) return { ok: false, synced: 0 }

  // 查找同名的班级池班级
  const poolClass = await prisma.class.findFirst({
    where: { name: teacherClass.name, teacherId: null, deletedAt: null },
    select: { id: true },
  })
  if (!poolClass) return { ok: true, synced: 0 }

  // 获取教师班级中有照片的学生
  const teacherStudents = await prisma.student.findMany({
    where: { classId: teacherClassId, photoUrl: { not: '' } },
    select: { name: true, photoUrl: true },
  })
  if (teacherStudents.length === 0) return { ok: true, synced: 0 }

  const teacherPhotoMap = new Map(teacherStudents.map(s => [normalizeName(s.name), s]))

  // 获取班级池中没有照片的学生
  const poolStudents = await prisma.student.findMany({
    where: { classId: poolClass.id },
    select: { id: true, name: true, photoUrl: true },
  })

  const updates = []
  for (const ps of poolStudents) {
    if (ps.photoUrl) continue
    const tp = teacherPhotoMap.get(normalizeName(ps.name))
    if (tp) {
      updates.push({ id: ps.id, photoUrl: tp.photoUrl })
    }
  }

  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map(u =>
        prisma.student.update({ where: { id: u.id }, data: { photoUrl: u.photoUrl } })
      )
    )
  }

  return { ok: true, synced: updates.length }
}

/**
 * 获取班级池中所有学期列表
 */
export async function getPoolSemesters() {
  const result = await prisma.class.findMany({
    where: { teacherId: null, isArchived: true, semester: { not: '' } },
    select: { semester: true },
    distinct: ['semester'],
    orderBy: { semester: 'desc' },
  })
  return result.map(r => r.semester)
}

/**
 * 归档班级池中的当前学期班级
 * @param {string} semester - 学期名称，如 "2025秋"
 */
export async function archivePoolSemester(semester) {
  if (!semester || !semester.trim()) return { ok: false, message: '学期名不能为空' }
  const result = await prisma.class.updateMany({
    where: { teacherId: null, isArchived: false, semester: '' },
    data: { isArchived: true, semester: semester.trim() },
  })
  return { ok: true, count: result.count, message: `已归档 ${result.count} 个班级` }
}

/**
 * 撤销班级池学期归档
 * @param {string} semester - 学期名称
 */
export async function unarchivePoolSemester(semester) {
  if (!semester || !semester.trim()) return { ok: false, message: '学期名不能为空' }
  const result = await prisma.class.updateMany({
    where: { teacherId: null, isArchived: true, semester: semester.trim() },
    data: { isArchived: false, semester: '' },
  })
  return { ok: true, count: result.count, message: `已撤销归档 ${result.count} 个班级` }
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
 * 班级池中的班级始终保留（teacherId 保持 null），认领后仅同步照片到教师的同名班级
 */
export async function claimPoolClass(classId, teacherId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls) return { ok: false, message: '班级不存在', status: 404 }
  if (cls.teacherId !== null) return { ok: false, message: '该班级不属于班级池', status: 409 }

  // 检查教师是否已有同名班级
  const existing = await prisma.class.findFirst({
    where: { teacherId, name: cls.name, isArchived: false },
  })

  if (existing) {
    // 合并：将班级池中有照片的学生同步到教师已有班级
    const poolStudents = await prisma.student.findMany({
      where: { classId },
      select: { id: true, name: true, homeClass: true, photoUrl: true },
    })
    const existingStudents = await prisma.student.findMany({
      where: { classId: existing.id },
      select: { id: true, name: true, photoUrl: true },
    })
    const existingMap = new Map(existingStudents.map(s => [normalizeName(s.name), s]))

    let mergedCount = 0
    const claimUpdates = []
    const claimInserts = []
    for (const ps of poolStudents) {
      if (!ps.photoUrl) continue
      const es = existingMap.get(normalizeName(ps.name))
      if (es) {
        if (!es.photoUrl) {
          claimUpdates.push(prisma.student.update({ where: { id: es.id }, data: { photoUrl: ps.photoUrl } }))
          mergedCount++
        }
      } else {
        claimInserts.push({ name: ps.name, homeClass: ps.homeClass, photoUrl: ps.photoUrl, classId: existing.id })
        mergedCount++
      }
    }
    // 批量执行更新和插入
    if (claimUpdates.length > 0) {
      const BATCH = 100
      for (let i = 0; i < claimUpdates.length; i += BATCH) {
        await prisma.$transaction(claimUpdates.slice(i, i + BATCH))
      }
    }
    if (claimInserts.length > 0) {
      await prisma.student.createMany({ data: claimInserts })
    }

    return { ok: true, message: `已将 ${mergedCount} 名学生的照片同步到「${cls.name}」` }
  }

  // 教师没有同名班级：创建新班级并复制所有学生
  const { createClass } = await import('./class.js')
  const newClass = await createClass(teacherId, cls.name)

  const poolStudents = await prisma.student.findMany({
    where: { classId },
    select: { name: true, homeClass: true, remark: true, photoUrl: true },
  })

  if (poolStudents.length > 0) {
    await prisma.student.createMany({
      data: poolStudents.map(s => ({
        name: s.name,
        homeClass: s.homeClass,
        remark: s.remark,
        photoUrl: s.photoUrl,
        classId: newClass.id,
      })),
    })
  }

  return { ok: true, message: `已认领班级「${cls.name}」，${poolStudents.length} 名学生已同步` }
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

  // 使用写入队列序列化数据库更新，避免并发写入导致锁竞争
  await _enqueueWrite(() =>
    prisma.student.update({
      where: { id: studentId },
      data: { photoUrl: url },
    })
  )

  // 同步照片：班级池 → 教师班级，或教师班级 → 班级池（防抖）
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (cls && cls.teacherId === null) {
    _schedulePoolSync(classId)
  } else if (cls && cls.teacherId !== null) {
    _scheduleTeacherSync(classId)
  }

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
    studentMap.set(normalizeName(s.name), s)
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
    const nameKey = path.basename(file.filename, path.extname(file.filename))
    const student = studentMap.get(normalizeName(nameKey))
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

  // 分批写文件（增大批次提升并行度，ext4/NTFS 可承受 50 并发写入）
  const BATCH_SIZE = 50
  if (writeTasks.length > 0) {
    for (let i = 0; i < writeTasks.length; i += BATCH_SIZE) {
      const batch = writeTasks.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(t => fs.writeFile(t.filePath, t.buffer)))
    }
  }

  // 批量更新数据库（分批事务，每批 100 条，绕过写入队列避免串行瓶颈）
  if (dbUpdates.length > 0) {
    const DB_BATCH = 100
    for (let i = 0; i < dbUpdates.length; i += DB_BATCH) {
      const batch = dbUpdates.slice(i, i + DB_BATCH)
      await prisma.$transaction(
        batch.map(u =>
          prisma.student.update({
            where: { id: u.studentId },
            data: { photoUrl: u.photoUrl },
          })
        )
      )
    }
  }

  // 获取班级中没有照片的学生
  const studentsWithoutPhotos = await prisma.student.findMany({
    where: { classId, OR: [{ photoUrl: null }, { photoUrl: '' }] },
    select: { id: true, name: true, classId: true },
  })

  // 同步照片到同名教师班级（防抖）
  if (matched.length > 0) {
    _schedulePoolSync(classId)
  }

  return { ok: true, matched: matched.length, unmatched, unmatchedStudents: studentsWithoutPhotos }
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

  await _enqueueWrite(() =>
    prisma.student.update({
      where: { id: studentId },
      data: { photoUrl: '' },
    })
  )

  // 同步删除
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (cls && cls.teacherId !== null) {
    // 教师班级 → 班级池
    const poolClass = await prisma.class.findFirst({
      where: { name: cls.name, teacherId: null, deletedAt: null },
      select: { id: true },
    })
    if (poolClass) {
      const poolStudent = await prisma.student.findFirst({
        where: { classId: poolClass.id, name: student.name },
        select: { id: true },
      })
      if (poolStudent) {
        await _enqueueWrite(() =>
          prisma.student.update({ where: { id: poolStudent.id }, data: { photoUrl: '' } })
        )
      }
    }
  } else if (cls && cls.teacherId === null) {
    // 班级池 → 所有同名教师班级
    const teacherClasses = await prisma.class.findMany({
      where: { name: cls.name, teacherId: { not: null }, deletedAt: null },
      select: { id: true },
    })
    for (const tc of teacherClasses) {
      const ts = await prisma.student.findFirst({
        where: { classId: tc.id, name: student.name },
        select: { id: true },
      })
      if (ts) {
        await _enqueueWrite(() =>
          prisma.student.update({ where: { id: ts.id }, data: { photoUrl: '' } })
        )
      }
    }
  }

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
 * 获取班级池中所有没有照片的学生
 */
export async function getStudentsWithoutPhotos() {
  const students = await prisma.$queryRawUnsafe(`
    SELECT s.id, s.name, s.classId, c.name AS className
    FROM student s
    JOIN class c ON s.classId = c.id
    WHERE c.teacherId IS NULL AND (s.photoUrl IS NULL OR s.photoUrl = '')
    ORDER BY c.name, s.name
  `)
  return students.map(s => ({ id: Number(s.id), name: s.name, classId: Number(s.classId), className: s.className }))
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

  // 构建 studentName -> [{ classId, student, className }] 多值映射（检测同名冲突）
  const studentMultiMap = new Map()
  for (const cls of poolClasses) {
    for (const s of cls.students) {
      const key = normalizeName(s.name)
      if (!studentMultiMap.has(key)) {
        studentMultiMap.set(key, [])
      }
      studentMultiMap.get(key).push({ classId: cls.id, student: s, className: cls.name })
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

  // 第 1 步：匹配 + 分类（自动匹配 / 冲突 / 未匹配）
  const matched = []
  const unmatched = []
  const conflicts = []
  const writeTasks = [] // { buffer, filePath }
  const dbUpdates = []  // { studentId, photoUrl }

  for (const file of files) {
    const nameKey = path.basename(file.filename, path.extname(file.filename))
    const candidates = studentMultiMap.get(normalizeName(nameKey))
    if (!candidates || candidates.length === 0) {
      unmatched.push(file.filename)
      continue
    }

    if (candidates.length > 1) {
      // 同名多学生，需要管理员手动匹配
      conflicts.push({
        filename: file.filename,
        buffer: file.buffer,
        candidates: candidates.map(c => ({
          studentId: c.student.id,
          studentName: c.student.name,
          className: c.className,
          classId: c.classId,
        })),
      })
      continue
    }

    // 唯一匹配，正常流程
    const match = candidates[0]

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
  const BATCH_SIZE = 50
  if (writeTasks.length > 0) {
    for (let i = 0; i < writeTasks.length; i += BATCH_SIZE) {
      const batch = writeTasks.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(t => fs.writeFile(t.filePath, t.buffer)))
    }
  }

  // 第 3 步：批量更新数据库（分批事务，每批 100 条，避免超长 SQL）
  if (dbUpdates.length > 0) {
    const DB_BATCH = 100
    for (let i = 0; i < dbUpdates.length; i += DB_BATCH) {
      const batch = dbUpdates.slice(i, i + DB_BATCH)
      await prisma.$transaction(
        batch.map(u =>
          prisma.student.update({
            where: { id: u.studentId },
            data: { photoUrl: u.photoUrl },
          })
        )
      )
    }
  }

  // 获取班级池中所有没有照片的学生
  const unmatchedStudents = await getStudentsWithoutPhotos()

  // 同步照片到同名教师班级（按受影响的班级去重）
  if (matched.length > 0) {
    const affectedClassIds = [...new Set(dbUpdates.map(u => {
      // 从 studentMultiMap 反查 classId
      for (const [key, vals] of studentMultiMap) {
        for (const v of vals) {
          if (v.student.id === u.studentId) return v.classId
        }
      }
      return null
    }).filter(Boolean))]
    for (const cid of affectedClassIds) {
      _schedulePoolSync(cid)
    }
  }

  return { ok: true, matched: matched.length, unmatched, conflicts, unmatchedStudents }
}

/**
 * 解决照片冲突：将照片匹配到指定的学生
 * @param {object} params
 * @param {number} params.studentId - 目标学生ID
 * @param {number} params.classId - 学生所在班级ID
 * @param {Buffer} params.buffer - 照片文件缓冲
 * @param {string} params.filename - 原始文件名
 */
export async function resolvePhotoConflict({ studentId, classId, buffer, filename }) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, classId },
    include: { class: true },
  })
  if (!student) {
    return { ok: false, message: '学生不存在或不属于该班级' }
  }

  // 验证学生属于班级池
  if (student.class.teacherId !== null) {
    return { ok: false, message: '只能匹配班级池中的学生' }
  }

  // 验证文件
  const ext = path.extname(filename).toLowerCase()
  const allowed = ['.jpg', '.jpeg', '.png', '.webp']
  if (!allowed.includes(ext)) {
    return { ok: false, message: '不支持的图片格式' }
  }

  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const monthDir = path.join(UPLOAD_DIR, year, month)
  await fs.mkdir(monthDir, { recursive: true })

  // 处理文件名冲突
  const baseName = path.basename(filename, ext)
  let safeFilename = `${baseName}${ext}`
  let counter = 1
  const existingFiles = new Set()
  try {
    const entries = await fs.readdir(monthDir)
    for (const entry of entries) existingFiles.add(entry)
  } catch { /* 目录不存在 */ }
  while (existingFiles.has(safeFilename)) {
    safeFilename = `${baseName}_${counter}${ext}`
    counter++
  }

  const filePath = path.join(monthDir, safeFilename)
  const url = `/uploads/photos/${year}/${month}/${safeFilename}`

  // 删除旧照片文件
  if (student.photoUrl) {
    const oldPath = path.resolve(__dirname, '../../' + student.photoUrl.replace(/^\//, ''))
    try { await fs.unlink(oldPath) } catch { /* 旧文件可能已被删除 */ }
  }

  // 写文件
  await fs.writeFile(filePath, buffer)

  // 更新数据库
  await _enqueueWrite(async () => {
    return prisma.student.update({
      where: { id: studentId },
      data: { photoUrl: url },
    })
  })

  // 同步照片到教师班级
  _schedulePoolSync(classId)

  return { ok: true, studentName: student.name, className: student.class.name, url }
}

// ==========================================
// ZIP 照片匹配服务
// ==========================================

const ZIP_UPLOAD_DIR = path.resolve(__dirname, '../../uploads/zip-uploads')
const ZIP_JOBS = new Map()
const ZIP_CLEANUP_INTERVAL_MS = 60_000 // 每 60 秒清理过期任务

// 定期清理过期任务（完成后 5 分钟 或 创建后 30 分钟）
setInterval(() => {
  const now = Date.now()
  for (const [jobId, job] of ZIP_JOBS) {
    const shouldClean =
      (job.status === 'completed' && now - job.completedAt > 300_000) ||
      (job.status === 'failed' && now - job.createdAt > 300_000) ||
      (now - job.createdAt > 1_800_000) // 30 分钟无论如何都清理
    if (shouldClean) {
      ZIP_JOBS.delete(jobId)
      if (job.tempDir) {
        fs.rm(job.tempDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}, ZIP_CLEANUP_INTERVAL_MS).unref()

/**
 * 上传 ZIP 文件并解压到临时目录，创建匹配任务
 * @param {Buffer} zipBuffer - ZIP 文件缓冲
 * @returns {Promise<{ok: boolean, jobId?: string, message?: string, folderStructure?: object[]}>}
 */
export async function uploadZipForMatching(zipBuffer) {
  const jobId = randomUUID()
  const tempDir = path.join(ZIP_UPLOAD_DIR, jobId)
  const zipPath = path.join(tempDir, 'upload.zip')
  await fs.mkdir(tempDir, { recursive: true })

  try {
    // 写入 ZIP 到临时文件
    await fs.writeFile(zipPath, zipBuffer)

    // 使用系统 unzip 命令解压（正确处理 GBK 编码文件名）
    await new Promise((resolve, reject) => {
      exec(`unzip -o '${zipPath}' -d '${tempDir}'`, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // 删除 ZIP 文件
    await fs.unlink(zipPath).catch(() => {})

    // 解析文件夹结构
    const folderStructure = await parseZipFolderStructure(tempDir)

    // 创建任务
    const totalPhotos = folderStructure.schools.reduce((sum, school) =>
      sum + school.classes.reduce((s, c) => s + c.photoCount, 0), 0
    )

    ZIP_JOBS.set(jobId, {
      id: jobId,
      status: 'extracted',
      tempDir,
      folderStructure,
      totalPhotos,
      progress: 0,
      matched: 0,
      unmatched: [],
      missingClasses: [],
      createdAt: Date.now(),
      completedAt: null,
    })

    return {
      ok: true,
      jobId,
      folderStructure,
      totalPhotos,
    }
  } catch (err) {
    // 清理失败的任务
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, message: 'ZIP 解压失败：' + err.message }
  }
}

/**
 * 解析 ZIP 解压后的文件夹结构
 * 识别 grade/school/class/*.jpg 层级
 */
async function parseZipFolderStructure(tempDir) {
  // 找到最外层文件夹（可能是年级名或直接是学校名）
  const topEntries = await fs.readdir(tempDir)
  let gradeDir = null
  let schoolDirs = []

  // 判断第一层是年级还是学校
  // 如果只有一个子目录且它包含子目录（学校），则它是年级
  if (topEntries.length === 1) {
    const firstStat = await fs.stat(path.join(tempDir, topEntries[0]))
    if (firstStat.isDirectory()) {
      gradeDir = topEntries[0]
      const subEntries = await fs.readdir(path.join(tempDir, gradeDir))
      for (const entry of subEntries) {
        const entryPath = path.join(tempDir, gradeDir, entry)
        const entryStat = await fs.stat(entryPath)
        if (entryStat.isDirectory()) schoolDirs.push(entry)
      }
    } else {
      // 第一层是文件，跳过
    }
  } else {
    // 多条目，直接当学校
    for (const entry of topEntries) {
      const entryPath = path.join(tempDir, entry)
      const entryStat = await fs.stat(entryPath)
      if (entryStat.isDirectory()) schoolDirs.push(entry)
    }
  }

  const grade = gradeDir || ''
  const schools = []

  for (const school of schoolDirs) {
    const schoolPath = gradeDir
      ? path.join(tempDir, gradeDir, school)
      : path.join(tempDir, school)

    const classEntries = await fs.readdir(schoolPath)
    const classes = []

    for (const classEntry of classEntries) {
      const classPath = path.join(schoolPath, classEntry)
      const classStat = await fs.stat(classPath)
      if (!classStat.isDirectory()) continue

      const photoFiles = []
      const entries = await fs.readdir(classPath)
      for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase()
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
          photoFiles.push({
            filename: entry,
            nameKey: normalizeName(path.basename(entry, ext)),
            filePath: path.join(classPath, entry),
          })
        }
      }

      classes.push({
        className: classEntry,
        photoCount: photoFiles.length,
        photos: photoFiles,
      })
    }

    if (classes.length > 0) {
      schools.push({ schoolName: school, classes })
    }
  }

  return { grade, schools }
}

/**
 * 获取匹配任务进度
 */
export function getZipMatchProgress(jobId) {
  const job = ZIP_JOBS.get(jobId)
  if (!job) return null

  return {
    ok: true,
    jobId: job.id,
    status: job.status,
    totalPhotos: job.totalPhotos,
    progress: job.progress,
    matched: job.matched,
    unmatched: job.unmatched,
    missingClasses: job.missingClasses,
    conflicts: job.conflicts || [],
    percent: job.totalPhotos ? Math.round((job.progress / job.totalPhotos) * 100) : 0,
  }
}

/**
 * 从班级名提取年级标识
 * "一职B4" → "一", "二劳A3" → "二"
 */
function extractGradeFromClass(className) {
  const match = className.match(/^([一二三四五六七八九十])/)
  return match ? match[1] : null
}

/**
 * 年级中文数字 → 文件夹名
 */
function gradeCharToFolder(gradeChar) {
  const map = { '一': '高一', '二': '高二', '三': '高三', '四': '高四' }
  return map[gradeChar] || null
}

/**
 * 从行政班提取学校名和班级号
 * "蛟4" → { school: "蛟川书院", classNum: "4" }
 * "3" → { school: "镇海中学", classNum: "3" }
 * "强基" → { school: "镇海中学", classNum: "强基班" }
 * "科中" → { school: "镇海中学", classNum: "科中" }
 */
function parseHomeClass(homeClass) {
  if (!homeClass) return null
  const trimmed = homeClass.trim()
  // 蛟川书院：行政班含"蛟"
  if (trimmed.includes('蛟')) {
    const numMatch = trimmed.match(/(\d+)/)
    return { school: '蛟川书院', classNum: numMatch ? numMatch[1] : trimmed.replace(/[蛟]/g, '').trim() }
  }
  // 特殊班级名归一化
  if (trimmed === '强基') return { school: '镇海中学', classNum: '强基班' }
  // 镇海中学：纯数字或"科中"等
  return { school: '镇海中学', classNum: trimmed }
}

/**
 * 启动 ZIP 照片匹配
 * @param {string} jobId - 匹配任务 ID
 */
export async function startZipMatching(jobId) {
  const job = ZIP_JOBS.get(jobId)
  if (!job) return { ok: false, message: '任务不存在' }
  if (job.status !== 'extracted') return { ok: false, message: '任务状态不正确' }

  job.status = 'matching'
  job.matched = 0
  job.unmatched = []
  job.missingClasses = []
  job.conflicts = []

  // 加载所有池班级
  const poolClasses = await prisma.class.findMany({
    where: { teacherId: null, deletedAt: null },
    include: { students: true },
  })

  // 构建索引：grade → school → classNum → { classId, className, students: Map<nameKey, student> }
  const gradeMap = new Map()

  for (const cls of poolClasses) {
    const gradeChar = extractGradeFromClass(cls.name)
    if (!gradeChar) continue
    const gradeFolder = gradeCharToFolder(gradeChar)
    if (!gradeFolder) continue

    if (!gradeMap.has(gradeFolder)) gradeMap.set(gradeFolder, new Map())
    const schoolMap = gradeMap.get(gradeFolder)

    for (const s of cls.students) {
      const hc = parseHomeClass(s.homeClass)
      if (!hc || !hc.classNum) continue

      if (!schoolMap.has(hc.school)) schoolMap.set(hc.school, new Map())
      const classMap = schoolMap.get(hc.school)

      if (!classMap.has(hc.classNum)) classMap.set(hc.classNum, [])
      classMap.get(hc.classNum).push({ classId: cls.id, className: cls.name, student: s })
    }
  }

  // 同步学生索引中每班的姓名映射
  const studentIndex = new Map() // grade/school/classNum/nameKey → student record
  for (const [grade, schoolMap] of gradeMap) {
    for (const [school, classMap] of schoolMap) {
      for (const [classNum, entries] of classMap) {
        for (const entry of entries) {
          const key = `${grade}|||${school}|||${classNum}|||${normalizeName(entry.student.name)}`
          studentIndex.set(key, entry)
        }
      }
    }
  }

  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const yearDir = path.join(UPLOAD_DIR, year)
  const monthDir = path.join(yearDir, month)
  await fs.mkdir(monthDir, { recursive: true })

  // 扫描已有文件
  const existingFiles = new Set()
  try {
    const entries = await fs.readdir(monthDir)
    for (const entry of entries) existingFiles.add(entry)
  } catch { /* ignore */ }

  const writeTasks = []
  const dbUpdates = []
  const affectedClassIds = new Set()
  const matchedStudentIds = new Set()

  // ZIP 中的年级文件夹名 → 中文年级
  const gradeMapFromZip = { '高一': '高一', '高二': '高二', '高三': '高三' }

  // 遍历 ZIP 文件夹结构：grade → school → class → photos
  const zipGrade = gradeMapFromZip[job.folderStructure.grade] || null

  for (const school of job.folderStructure.schools) {
    for (const cls of school.classes) {
      let foundAny = false

      for (const photo of cls.photos) {
        // 跳过 Thumbs.db 等
        if (photo.filename.toLowerCase().startsWith('thumbs')) {
          job.progress++
          continue
        }

        // 查找匹配：grade/school/classNum/name
        const key = `${zipGrade}|||${school.schoolName}|||${cls.className}|||${photo.nameKey}`
        const entry = studentIndex.get(key)

        if (!entry) {
          job.unmatched.push({
            filename: photo.filename,
            grade: zipGrade || job.folderStructure.grade,
            school: school.schoolName,
            className: cls.className,
            studentName: photo.nameKey,
          })
          job.progress++
          continue
        }

        // 避免重复匹配同一学生
        if (matchedStudentIds.has(entry.student.id)) {
          job.progress++
          continue
        }

        foundAny = true

        // 确定文件名
        const ext = path.extname(photo.filename).toLowerCase()
        const baseName = path.basename(photo.filename, ext)
        let safeFilename = `${baseName}${ext}`
        let counter = 1
        while (existingFiles.has(safeFilename)) {
          safeFilename = `${baseName}_${counter}${ext}`
          counter++
        }
        existingFiles.add(safeFilename)

        const url = `/uploads/photos/${year}/${month}/${safeFilename}`
        const filePath = path.join(monthDir, safeFilename)

        writeTasks.push({ bufferPath: photo.filePath, filePath })
        dbUpdates.push({ studentId: entry.student.id, photoUrl: url, classId: entry.classId })
        matchedStudentIds.add(entry.student.id)
        job.matched++
        job.progress++
        affectedClassIds.add(entry.classId)
      }

      if (!foundAny) {
        job.missingClasses.push({
          grade: zipGrade || job.folderStructure.grade,
          school: school.schoolName,
          className: cls.className,
          photoCount: cls.photoCount,
        })
      }
    }
  }

  // 分批写文件
  const BATCH_SIZE = 50
  for (let i = 0; i < writeTasks.length; i += BATCH_SIZE) {
    const batch = writeTasks.slice(i, i + BATCH_SIZE)
    await Promise.all(batch.map(async (t) => {
      const buf = await fs.readFile(t.bufferPath)
      return fs.writeFile(t.filePath, buf)
    }))
  }

  // 分批更新数据库
  if (dbUpdates.length > 0) {
    const DB_BATCH = 100
    for (let i = 0; i < dbUpdates.length; i += DB_BATCH) {
      const batch = dbUpdates.slice(i, i + DB_BATCH)
      await prisma.$transaction(
        batch.map(u =>
          prisma.student.update({
            where: { id: u.studentId },
            data: { photoUrl: u.photoUrl },
          })
        )
      )
    }
  }

  // 同步到教师班级
  for (const cid of affectedClassIds) {
    _schedulePoolSync(cid)
  }

  // 清理临时文件
  await fs.rm(job.tempDir, { recursive: true, force: true }).catch(() => {})

  job.status = 'completed'
  job.completedAt = Date.now()

  return {
    ok: true,
    matched: job.matched,
    unmatched: job.unmatched,
    missingClasses: job.missingClasses,
  }
}

/**
 * 删除 ZIP 匹配任务（用户取消时）
 */
export async function cancelZipMatch(jobId) {
  const job = ZIP_JOBS.get(jobId)
  if (!job) return { ok: false }
  if (job.tempDir) {
    await fs.rm(job.tempDir, { recursive: true, force: true }).catch(() => {})
  }
  ZIP_JOBS.delete(jobId)
  return { ok: true }
}
