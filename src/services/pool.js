import { prisma } from '../plugins/db.js'
import ExcelJS from 'exceljs'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.resolve(__dirname, '../../uploads/photos')

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
    const teachers = nameToTeachers.get(c.name)
    return {
      id: c.id,
      name: c.name,
      studentCount: c._count.students,
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

  // 获取班级池中有照片的学生
  const poolStudents = await prisma.student.findMany({
    where: { classId: poolClassId, photoUrl: { not: '' } },
    select: { name: true, photoUrl: true, homeClass: true },
  })
  if (poolStudents.length === 0) return { ok: true, synced: 0 }

  const poolPhotoMap = new Map(poolStudents.map(s => [normalizeName(s.name), s]))
  let totalSynced = 0

  for (const tc of teacherClasses) {
    const teacherStudents = await prisma.student.findMany({
      where: { classId: tc.id },
      select: { id: true, name: true, photoUrl: true },
    })

    const teacherMap = new Map(teacherStudents.map(s => [normalizeName(s.name), s]))
    const updateIds = []
    const insertData = []

    for (const [normName, ps] of poolPhotoMap) {
      const ts = teacherMap.get(normName)
      if (ts) {
        if (!ts.photoUrl) {
          updateIds.push({ id: ts.id, photoUrl: ps.photoUrl })
          totalSynced++
        }
      } else {
        insertData.push({
          name: ps.name,
          homeClass: ps.homeClass,
          photoUrl: ps.photoUrl,
          classId: tc.id,
        })
        totalSynced++
      }
    }

    // 批量更新（单条 SQL，避免 SQLite 锁超时）
    if (updateIds.length > 0) {
      const sql = `UPDATE student SET photoUrl = CASE id ${updateIds.map(u => `WHEN ${u.id} THEN '${u.photoUrl.replace(/'/g, "''")}'`).join(' ')} END WHERE id IN (${updateIds.map(u => u.id).join(',')})`
      await prisma.$executeRawUnsafe(sql)
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
    const sql = `UPDATE student SET photoUrl = CASE id ${updates.map(u => `WHEN ${u.id} THEN '${u.photoUrl.replace(/'/g, "''")}'`).join(' ')} END WHERE id IN (${updates.map(u => u.id).join(',')})`
    await prisma.$executeRawUnsafe(sql)
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
    for (const ps of poolStudents) {
      if (!ps.photoUrl) continue
      const es = existingMap.get(normalizeName(ps.name))
      if (es) {
        if (!es.photoUrl) {
          await prisma.student.update({
            where: { id: es.id },
            data: { photoUrl: ps.photoUrl },
          })
          mergedCount++
        }
      } else {
        await prisma.student.create({
          data: {
            name: ps.name,
            homeClass: ps.homeClass,
            photoUrl: ps.photoUrl,
            classId: existing.id,
          },
        })
        mergedCount++
      }
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

  await prisma.student.update({
    where: { id: studentId },
    data: { photoUrl: url },
  })

  // 同步照片：班级池 → 教师班级，或教师班级 → 班级池
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (cls && cls.teacherId === null) {
    await syncPoolPhotosToTeacherClasses(classId)
  } else if (cls && cls.teacherId !== null) {
    await syncTeacherPhotoToPool(classId)
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

  // 分批写文件
  const BATCH_SIZE = 20
  if (writeTasks.length > 0) {
    for (let i = 0; i < writeTasks.length; i += BATCH_SIZE) {
      const batch = writeTasks.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(t => fs.writeFile(t.filePath, t.buffer)))
    }
  }

  // 批量更新数据库（单条 SQL，避免 SQLite 写锁竞争）
  if (dbUpdates.length > 0) {
    const sql = `UPDATE student SET photoUrl = CASE id ${
      dbUpdates.map(u => `WHEN ${u.studentId} THEN '${u.photoUrl.replace(/'/g, "''")}'`).join(' ')
    } END WHERE id IN (${dbUpdates.map(u => u.studentId).join(',')})`
    await prisma.$executeRawUnsafe(sql)
  }

  // 获取班级中没有照片的学生
  const studentsWithoutPhotos = await prisma.student.findMany({
    where: { classId, OR: [{ photoUrl: null }, { photoUrl: '' }] },
    select: { id: true, name: true, classId: true },
  })

  // 同步照片到同名教师班级
  if (matched.length > 0) {
    await syncPoolPhotosToTeacherClasses(classId)
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

  await prisma.student.update({
    where: { id: studentId },
    data: { photoUrl: '' },
  })

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
        await prisma.student.update({ where: { id: poolStudent.id }, data: { photoUrl: '' } })
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
        await prisma.student.update({ where: { id: ts.id }, data: { photoUrl: '' } })
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

  // 构建 studentName -> { classId, student } 映射（标准化姓名用于匹配）
  const studentMap = new Map()
  for (const cls of poolClasses) {
    for (const s of cls.students) {
      const key = normalizeName(s.name)
      if (!studentMap.has(key)) {
        studentMap.set(key, { classId: cls.id, student: s })
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
    const nameKey = path.basename(file.filename, path.extname(file.filename))
    const match = studentMap.get(normalizeName(nameKey))
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

  // 第 3 步：批量更新数据库（单条 SQL，避免 SQLite 写锁竞争）
  if (dbUpdates.length > 0) {
    const sql = `UPDATE student SET photoUrl = CASE id ${
      dbUpdates.map(u => `WHEN ${u.studentId} THEN '${u.photoUrl.replace(/'/g, "''")}'`).join(' ')
    } END WHERE id IN (${dbUpdates.map(u => u.studentId).join(',')})`
    await prisma.$executeRawUnsafe(sql)
  }

  // 获取班级池中所有没有照片的学生
  const unmatchedStudents = await getStudentsWithoutPhotos()

  // 同步照片到同名教师班级（按受影响的班级去重）
  if (matched.length > 0) {
    const affectedClassIds = [...new Set(dbUpdates.map(u => {
      // 从 studentMap 反查 classId
      for (const [, v] of studentMap) {
        if (v.student.id === u.studentId) return v.classId
      }
      return null
    }).filter(Boolean))]
    for (const cid of affectedClassIds) {
      await syncPoolPhotosToTeacherClasses(cid)
    }
  }

  return { ok: true, matched: matched.length, unmatched, unmatchedStudents }
}
