import { createTeacher, resetTeacherPasswordByAdmin } from '../services/auth.js'
import { deleteClassesCascadeWithTx } from '../services/class.js'
import {
  getAllClassesDetail,
  transferClass,
  archiveAllClasses,
  getCrossClassAnalytics,
  getTeacherLoginStats,
  editClass,
  deleteClassByAdmin,
  getAuditLogs,
  createAuditLog,
} from '../services/admin.js'
import { adminRequired } from '../utils/auth.js'
import { prisma } from '../plugins/db.js'
import { randomBytes } from 'node:crypto'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.resolve(__dirname, '../../prisma/attendance.db')

function getClientIp(request) {
  return request.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || request.headers['x-real-ip']
    || request.ip
    || ''
}

export default async function adminRoutes(app) {
  // === Pages ===

  app.get('/admin', { preHandler: adminRequired }, async (request, reply) => {
    const teachers = await prisma.teacher.findMany({
      include: { _count: { select: { classes: true } } },
    })
    return reply.view('admin/index.html', {
      teachers: teachers.map(t => ({
        id: t.id,
        username: t.username,
        isAdmin: t.isAdmin,
        classCount: t._count.classes,
      })),
    })
  })

  app.get('/admin/dashboard', { preHandler: adminRequired }, async (request, reply) => {
    return reply.view('admin/dashboard.html', {})
  })

  app.get('/admin/analytics', { preHandler: adminRequired }, async (request, reply) => {
    return reply.view('admin/analytics.html', {})
  })

  app.get('/admin/audit', { preHandler: adminRequired }, async (request, reply) => {
    return reply.view('admin/audit.html', {})
  })

  // === API: Class Management ===

  app.get('/admin/api/classes', { preHandler: adminRequired }, async (request, reply) => {
    const data = await getAllClassesDetail()
    return reply.send({ ok: true, classes: data })
  })

  app.patch('/admin/api/classes/:id', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const { name } = request.body ?? {}
    if (!name || !name.trim()) {
      return reply.send({ ok: false, message: '班级名不能为空' })
    }
    const cls = await prisma.class.findUnique({ where: { id: classId } })
    if (!cls) {
      return reply.code(404).send({ ok: false, message: '班级不存在' })
    }
    const ip = getClientIp(request)
    const result = await editClass(classId, cls.teacherId, name.trim(), request.session.teacherId, ip)
    if (!result.ok) return reply.code(result.status || 400).send(result)
    return reply.send(result)
  })

  app.delete('/admin/api/classes/:id', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const ip = getClientIp(request)
    const result = await deleteClassByAdmin(classId, request.session.teacherId, ip)
    if (!result.ok) return reply.code(result.status || 400).send(result)
    return reply.send(result)
  })

  app.post('/admin/api/classes/:id/transfer', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const { teacherId } = request.body ?? {}
    if (!teacherId) {
      return reply.send({ ok: false, message: '请选择目标教师' })
    }
    const ip = getClientIp(request)
    const result = await transferClass(classId, parseInt(teacherId, 10), request.session.teacherId, ip)
    if (!result.ok) return reply.code(result.status || 400).send(result)
    return reply.send(result)
  })

  // === API: Archive All ===

  app.post('/admin/api/archive-all', { preHandler: adminRequired }, async (request, reply) => {
    const ip = getClientIp(request)
    const result = await archiveAllClasses(request.session.teacherId, ip)
    return reply.send(result)
  })

  // === API: Cross-Class Analytics ===

  app.get('/admin/api/analytics', { preHandler: adminRequired }, async (request, reply) => {
    const data = await getCrossClassAnalytics()
    return reply.send(data)
  })

  // === API: Teacher Stats ===

  app.get('/admin/api/teacher-stats', { preHandler: adminRequired }, async (request, reply) => {
    const data = await getTeacherLoginStats()
    return reply.send({ ok: true, teachers: data })
  })

  // === API: Batch Password Reset ===

  app.post('/admin/api/batch-reset-password', { preHandler: adminRequired }, async (request, reply) => {
    const { password: basePassword } = request.body ?? {}
    if (!basePassword || !basePassword.trim()) {
      return reply.send({ ok: false, message: '密码不能为空' })
    }

    const teachers = await prisma.teacher.findMany({ where: { isAdmin: false } })
    if (teachers.length === 0) {
      return reply.send({ ok: true, count: 0, message: '没有非管理员教师需要重置' })
    }

    const bcrypt = await import('bcrypt')

    // Check password doesn't match any existing
    for (const t of teachers) {
      if (await bcrypt.compare(basePassword, t.passwordHash)) {
        return reply.send({ ok: false, message: `新密码与教师「${t.username}」的当前密码相同` })
      }
    }

    // Check no conflict with admin passwords
    const adminTeachers = await prisma.teacher.findMany({ where: { isAdmin: true }, select: { passwordHash: true, username: true } })
    for (const t of adminTeachers) {
      if (await bcrypt.compare(basePassword, t.passwordHash)) {
        return reply.send({ ok: false, message: `该密码与管理员「${t.username}」的密码相同` })
      }
    }

    // Generate unique passwords and update in a transaction
    const hashMap = []
    for (const t of teachers) {
      const uniquePassword = `${basePassword}_${t.username}_${randomBytes(4).toString('hex')}`
      const hash = await bcrypt.hash(uniquePassword, 10)
      hashMap.push({ id: t.id, username: t.username, hash, password: uniquePassword })
    }

    await prisma.$transaction(
      hashMap.map(item =>
        prisma.teacher.update({ where: { id: item.id }, data: { passwordHash: item.hash } })
      )
    )

    await createAuditLog({
      adminId: request.session.teacherId,
      action: 'BATCH_RESET_PASSWORD',
      target: `批量重置 ${hashMap.length} 个教师密码（唯一密码）`,
      detail: JSON.stringify({ teachers: hashMap.map(h => h.username) }),
      ip: getClientIp(request),
    })

    return reply.send({
      ok: true,
      count: hashMap.length,
      message: `已重置 ${hashMap.length} 个教师的密码（每个唯一）`,
      passwords: hashMap.map(h => ({ username: h.username, password: h.password })),
    })
  })

  // === API: Audit Logs ===

  app.get('/admin/api/audit-logs', { preHandler: adminRequired }, async (request, reply) => {
    const page = parseInt(request.query.page || '1', 10)
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200)
    const offset = (page - 1) * limit
    const data = await getAuditLogs({ limit, offset })
    return reply.send({ ok: true, ...data, page, limit })
  })

  // === API: Database Backup ===

  app.get('/admin/api/backup', { preHandler: adminRequired }, async (request, reply) => {
    try {
      const data = await fs.readFile(DB_PATH)
      await createAuditLog({
        adminId: request.session.teacherId,
        action: 'BACKUP',
        target: '数据库备份',
        detail: JSON.stringify({ size: data.length }),
        ip: getClientIp(request),
      })
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition', `attachment; filename="crcheckin_backup_${Date.now()}.db"`)
      return reply.send(data)
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '备份失败：' + err.message })
    }
  })

  // === API: Database Restore ===

  app.post('/admin/api/restore', { preHandler: adminRequired }, async (request, reply) => {
    const data = await request.file()
    if (!data) {
      return reply.send({ ok: false, message: '请上传备份文件' })
    }

    if (!data.mimetype.includes('sqlite') && !data.mimetype.includes('octet-stream') && data.mimetype !== '') {
      return reply.send({ ok: false, message: '不支持的文件类型' })
    }

    const buffer = await data.toBuffer()
    const MAX_DB_SIZE = 100 * 1024 * 1024 // 100 MB
    if (buffer.length < 100) {
      return reply.send({ ok: false, message: '备份文件无效（文件太小）' })
    }
    if (buffer.length > MAX_DB_SIZE) {
      return reply.send({ ok: false, message: '备份文件过大（最大 100MB）' })
    }

    // Validate SQLite header
    const header = buffer.slice(0, 16).toString()
    if (!header.startsWith('SQLite format 3')) {
      return reply.send({ ok: false, message: '不是有效的 SQLite 数据库文件' })
    }

    // Write to temp file first, validate, then swap
    const tempPath = DB_PATH + `.restore_${Date.now()}`
    await fs.writeFile(tempPath, buffer)

    // Validate integrity before replacing
    await prisma.$disconnect()

    // Temporarily replace file for integrity check
    const backupPath = DB_PATH + `.backup_${Date.now()}`
    await fs.copyFile(DB_PATH, backupPath)
    await fs.rename(tempPath, DB_PATH)

    await prisma.$connect()
    try {
      const integrity = await prisma.$queryRaw`PRAGMA integrity_check`
      if (integrity[0]['integrity_check'] !== 'ok') {
        // Rollback to backup
        await fs.copyFile(backupPath, DB_PATH)
        return reply.send({ ok: false, message: '数据库完整性校验失败，已回滚到恢复前的状态' })
      }
    } catch (err) {
      // Rollback to backup
      await fs.copyFile(backupPath, DB_PATH)
      return reply.send({ ok: false, message: '数据库无法加载，已回滚到恢复前的状态：' + err.message })
    }

    // Clean up old backups (keep last 5)
    const dbDir = path.dirname(DB_PATH)
    const dbBase = path.basename(DB_PATH)
    const files = (await fs.readdir(dbDir))
      .filter(f => f.startsWith(dbBase + '.backup_'))
      .sort()
    for (let i = 0; i < files.length - 5; i++) {
      await fs.unlink(path.join(dbDir, files[i]))
    }

    await createAuditLog({
      adminId: request.session.teacherId,
      action: 'RESTORE',
      target: '数据库恢复',
      detail: JSON.stringify({ filename: data.filename, size: buffer.length, backupPath }),
      ip: getClientIp(request),
    })

    return reply.send({ ok: true, message: '数据库已恢复，完整性校验通过' })
  })

  // === API: System Health ===

  app.get('/admin/api/health', { preHandler: adminRequired }, async (request, reply) => {
    const uptime = process.uptime()
    const memUsage = process.memoryUsage()
    const nodeVersion = process.version
    const platform = process.platform
    const arch = process.arch

    let dbSize = 0
    let dbOk = false
    let dbError = ''
    try {
      const stat = await fs.stat(DB_PATH)
      dbSize = stat.size
      // Test query
      await prisma.$queryRaw`SELECT 1`
      dbOk = true
    } catch (err) {
      dbError = err.message
    }

    const [teacherCount, classCount, studentCount, sessionCount, recordCount, archivedCount] = await Promise.all([
      prisma.teacher.count().catch(() => 0),
      prisma.class.count().catch(() => 0),
      prisma.student.count().catch(() => 0),
      prisma.signInSession.count().catch(() => 0),
      prisma.signInRecord.count().catch(() => 0),
      prisma.archivedRecord.count().catch(() => 0),
    ])

    return reply.send({
      ok: true,
      server: {
        uptime: Math.floor(uptime),
        nodeVersion,
        platform,
        arch,
        memory: {
          rss: (memUsage.rss / 1024 / 1024).toFixed(1) + ' MB',
          heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(1) + ' MB',
          heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(1) + ' MB',
        },
      },
      database: {
        ok: dbOk,
        error: dbError,
        size: dbSize,
        sizeLabel: (dbSize / 1024 / 1024).toFixed(2) + ' MB',
      },
      data: {
        teachers: teacherCount,
        classes: classCount,
        students: studentCount,
        sessions: sessionCount,
        currentRecords: recordCount,
        archivedRecords: archivedCount,
      },
    })
  })

  // === Original Teacher Management ===

  app.post('/admin/teachers', { preHandler: adminRequired }, async (request, reply) => {
    const { username, password, isAdmin } = request.body ?? {}
    try {
      const teacher = await createTeacher(username, password, isAdmin === true || isAdmin === 'true')
      await createAuditLog({
        adminId: request.session.teacherId,
        action: 'CREATE_TEACHER',
        target: `教师「${username}」`,
        detail: JSON.stringify({ isAdmin: teacher.isAdmin, teacherId: teacher.id }),
        ip: getClientIp(request),
      })
      return reply.send({ ok: true })
    } catch (err) {
      if (err.code === 'USERNAME_TAKEN') {
        return reply.send({ ok: false, message: '用户名已存在' })
      }
      if (err.code === 'PASSWORD_TOO_WEAK') {
        return reply.send({ ok: false, message: err.message })
      }
      throw err
    }
  })

  app.patch('/admin/teachers/:id/password', { preHandler: adminRequired }, async (request, reply) => {
    const id = parseInt(request.params.id, 10)
    const { password } = request.body ?? {}
    const teacher = await prisma.teacher.findUnique({ where: { id } })
    try {
      const result = await resetTeacherPasswordByAdmin(id, password)
      if (!result.ok) {
        return reply.code(400).send(result)
      }
      await createAuditLog({
        adminId: request.session.teacherId,
        action: 'RESET_PASSWORD',
        target: `教师「${teacher?.username}」(${id})`,
        ip: getClientIp(request),
      })
      return reply.send(result)
    } catch (err) {
      if (err.code === 'PASSWORD_TOO_WEAK') {
        return reply.send({ ok: false, message: err.message })
      }
      throw err
    }
  })

  app.delete('/admin/teachers/:id', { preHandler: adminRequired }, async (request, reply) => {
    const id = parseInt(request.params.id, 10)
    const teacher = await prisma.teacher.findUnique({ where: { id } })
    if (!teacher) {
      return reply.code(404).send({ ok: false, message: '教师不存在' })
    }
    if (teacher.isAdmin) {
      return reply.code(403).send({ ok: false, message: '不允许删除管理员账号' })
    }

    // 级联删除班级下的归档/当前签到/学生数据，再删 Teacher
    const classes = await prisma.class.findMany({ where: { teacherId: id }, select: { id: true } })
    const classIds = classes.map(c => c.id)

    await prisma.$transaction(async (tx) => {
      await deleteClassesCascadeWithTx(tx, classIds)
      await tx.teacher.delete({ where: { id } })
    })

    await createAuditLog({
      adminId: request.session.teacherId,
      action: 'DELETE_TEACHER',
      target: `教师「${teacher.username}」(${id})`,
      detail: JSON.stringify({ classCount: classIds.length }),
      ip: getClientIp(request),
    })

    return reply.send({ ok: true })
  })
}
