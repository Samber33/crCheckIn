import { prisma } from '../plugins/db.js'
import { makeSessionLabel } from './attendance.js'

/**
 * 创建审计日志
 */
export async function createAuditLog({ adminId, action, target, detail = '', ip = '' }) {
  return prisma.auditLog.create({
    data: { adminId, action, target, detail, ip },
  })
}

/**
 * 获取审计日志
 */
export async function getAuditLogs({ limit = 50, offset = 0 } = {}) {
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.auditLog.count(),
  ])
  return { logs, total }
}

/**
 * 获取所有班级详细状态（含学生名单摘要）
 */
export async function getAllClassesDetail() {
  const classes = await prisma.class.findMany({
    orderBy: [{ teacher: { username: 'asc' } }, { name: 'asc' }],
    include: {
      teacher: { select: { username: true } },
      _count: { select: { students: true } },
    },
  })

  const classIds = classes.map(c => c.id)
  const [configs, recordCounts, sessions] = await Promise.all([
    prisma.signInConfig.findMany({ where: { classId: { in: classIds } } }),
    prisma.signInRecord.groupBy({
      by: ['classId'],
      _count: true,
      where: { classId: { in: classIds } },
    }),
    prisma.signInSession.groupBy({
      by: ['classId'],
      _count: true,
      where: { classId: { in: classIds } },
    }),
  ])

  const configMap = new Map(configs.map(c => [c.classId, c]))
  const recordCountMap = new Map(recordCounts.map(r => [r.classId, r._count]))
  const sessionCountMap = new Map(sessions.map(s => [s.classId, s._count]))

  return classes.map(cls => {
    const config = configMap.get(cls.id)
    const now = new Date()
    let signInStatus = '未开启'

    if (config?.activeStartedAt) {
      const endTime = new Date(new Date(config.activeStartedAt).getTime() + (config.countdownDurationMin || 40) * 60 * 1000)
      if (now < endTime) {
        signInStatus = '签到中'
      }
    }

    return {
      id: cls.id,
      name: cls.name,
      teacherUsername: cls.teacher.username,
      teacherId: cls.teacherId,
      studentCount: cls._count.students,
      signedCount: recordCountMap.get(cls.id) || 0,
      totalSessions: sessionCountMap.get(cls.id) || 0,
      signInStatus,
      isArchived: cls.isArchived,
      isSigning: signInStatus === '签到中',
    }
  })
}

/**
 * 班级转交（从一个教师转给另一个教师）
 */
export async function transferClass(classId, newTeacherId, adminId, ip = '') {
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    include: { teacher: { select: { username: true } } },
  })
  if (!cls) {
    return { ok: false, message: '班级不存在', status: 404 }
  }

  const newTeacher = await prisma.teacher.findUnique({ where: { id: newTeacherId } })
  if (!newTeacher) {
    return { ok: false, message: '目标教师不存在', status: 404 }
  }

  const oldTeacherId = cls.teacherId
  const oldTeacherName = cls.teacher.username

  await prisma.class.update({
    where: { id: classId },
    data: { teacherId: newTeacherId },
  })

  const { invalidateClassTeacherCache } = await import('./sse.js')
  invalidateClassTeacherCache(classId)

  await createAuditLog({
    adminId,
    action: 'TRANSFER_CLASS',
    target: `班级「${cls.name}」(${classId})`,
    detail: JSON.stringify({ from: oldTeacherName, fromId: oldTeacherId, to: newTeacher.username, toId: newTeacherId }),
    ip,
  })

  return { ok: true, message: `已将「${cls.name}」转交给 ${newTeacher.username}` }
}

/**
 * 归档所有班级的当前签到记录（期末一键归档）
 * 优化：每个班级独立事务，避免大事务锁表
 */
export async function archiveAllClasses(adminId, ip = '') {
  const classes = await prisma.class.findMany({
    where: { signInRecords: { some: {} } },
    select: { id: true, name: true },
  })

  if (classes.length === 0) {
    return { ok: true, archived: 0, message: '没有需要归档的签到记录' }
  }

  let totalArchived = 0
  const results = []

  for (const cls of classes) {
    const records = await prisma.signInRecord.findMany({
      where: { classId: cls.id },
      include: { student: { select: { homeClass: true } } },
    })

    if (records.length === 0) continue

    const label = makeSessionLabel(cls.name)

    await prisma.$transaction(async (tx) => {
      await tx.signInSession.create({
        data: {
          classId: cls.id,
          label,
          records: {
            create: records.map(r => ({
              studentName: r.studentName,
              homeClass: r.student?.homeClass ?? '',
              computerName: r.computerName,
              signedAt: r.signedAt,
            })),
          },
        },
      })

      await tx.signInRecord.deleteMany({ where: { classId: cls.id } })
      await tx.signInConfig.updateMany({
        where: { classId: cls.id },
        data: { activeStartedAt: null },
      })
    })

    totalArchived += records.length
    results.push({ classId: cls.id, className: cls.name, archived: records.length })
  }

  await createAuditLog({
    adminId,
    action: 'ARCHIVE_ALL',
    target: '一键归档所有班级',
    detail: JSON.stringify({ totalArchived, classes: results }),
    ip,
  })

  return { ok: true, archived: totalArchived, classes: results }
}

/**
 * 跨班级数据分析（管理员视角）
 * 优化：批量查询替代 N+1，所有统计通过一次聚合查询完成
 */
export async function getCrossClassAnalytics() {
  const [teachers, classCount, totalStudents, totalSessions, signInRecordCount, archivedRecordCount] = await Promise.all([
    prisma.teacher.findMany({
      include: {
        _count: { select: { classes: true } },
      },
    }),
    prisma.class.count(),
    prisma.student.count(),
    prisma.signInSession.count(),
    prisma.signInRecord.count(),
    prisma.archivedRecord.count(),
  ])

  const totalSignIns = signInRecordCount + archivedRecordCount

  // 批量查询：所有班级及其聚合计数（一次查询）
  const classes = await prisma.class.findMany({
    where: { teacherId: { in: teachers.map(t => t.id) } },
    include: {
      _count: { select: { students: true, signInRecords: true, sessions: true } },
    },
    orderBy: [{ teacherId: 'asc' }, { name: 'asc' }],
  })

  // 批量查询：每个教师的历史批次总数（一次查询）
  const sessionsByTeacher = await prisma.signInSession.groupBy({
    by: ['classId'],
    _count: true,
  })
  const classIdToTeacherId = new Map(classes.map(c => [c.id, c.teacherId]))
  const sessionCountByTeacher = new Map()
  for (const item of sessionsByTeacher) {
    const tid = classIdToTeacherId.get(item.classId)
    if (tid) {
      sessionCountByTeacher.set(tid, (sessionCountByTeacher.get(tid) || 0) + item._count)
    }
  }

  // 批量查询：每个教师的签到记录总数（一次查询）
  const signInByTeacher = await prisma.signInRecord.groupBy({
    by: ['classId'],
    _count: true,
  })
  const signInCountByTeacher = new Map()
  for (const item of signInByTeacher) {
    const tid = classIdToTeacherId.get(item.classId)
    if (tid) {
      signInCountByTeacher.set(tid, (signInCountByTeacher.get(tid) || 0) + item._count)
    }
  }

  // 批量查询：每个教师的归档记录总数（一次查询）
  const archivedByTeacher = await prisma.archivedRecord.groupBy({
    by: ['sessionId'],
    _count: true,
  })
  // Need to map sessionId -> classId -> teacherId
  const sessionIdToClassId = new Map()
  for (const c of classes) {
    // We need sessions for each class to map sessionId -> teacherId
  }
  // Simpler: just query the session->class relationship once
  const sessionClassMap = await prisma.signInSession.findMany({
    select: { id: true, classId: true },
  })
  for (const s of sessionClassMap) {
    const tid = classIdToTeacherId.get(s.classId)
    if (tid) sessionIdToClassId.set(s.id, tid)
  }
  const archivedCountByTeacher = new Map()
  for (const item of archivedByTeacher) {
    const tid = sessionIdToClassId.get(item.sessionId)
    if (tid) {
      archivedCountByTeacher.set(tid, (archivedCountByTeacher.get(tid) || 0) + item._count)
    }
  }

  // 批量查询：每个教师的学生总数（一次查询）
  const studentsByTeacher = await prisma.student.groupBy({
    by: ['classId'],
    _count: true,
  })
  const studentCountByTeacher = new Map()
  for (const item of studentsByTeacher) {
    const tid = classIdToTeacherId.get(item.classId)
    if (tid) {
      studentCountByTeacher.set(tid, (studentCountByTeacher.get(tid) || 0) + item._count)
    }
  }

  // 按教师分组班级
  const classesByTeacher = new Map()
  for (const c of classes) {
    if (!classesByTeacher.has(c.teacherId)) classesByTeacher.set(c.teacherId, [])
    classesByTeacher.get(c.teacherId).push({
      id: c.id,
      name: c.name,
      studentCount: c._count.students,
      signedCount: c._count.signInRecords,
      sessionCount: c._count.sessions,
    })
  }

  // 组装教师统计
  const teacherStats = teachers.map(t => ({
    id: t.id,
    username: t.username,
    isAdmin: t.isAdmin,
    classCount: t._count.classes,
    sessionsCount: sessionCountByTeacher.get(t.id) || 0,
    recordsCount: (signInCountByTeacher.get(t.id) || 0) + (archivedCountByTeacher.get(t.id) || 0),
    studentsCount: studentCountByTeacher.get(t.id) || 0,
    classes: classesByTeacher.get(t.id) || [],
  }))

  // 最近签到的班级（Top 10）
  const recentRecords = await prisma.signInRecord.findMany({
    take: 10,
    orderBy: { signedAt: 'desc' },
    include: { class: { include: { teacher: { select: { username: true } } } } },
  })

  return {
    summary: {
      teacherCount: teachers.length,
      classCount,
      totalSignIns,
      totalStudents,
      totalSessions,
    },
    teacherStats,
    recentActivity: recentRecords.map(r => ({
      classId: r.classId,
      className: r.class.name,
      teacherUsername: r.class.teacher.username,
      studentName: r.studentName,
      signedAt: r.signedAt,
    })),
  }
}

/**
 * 教师登录统计
 */
export async function getTeacherLoginStats() {
  const teachers = await prisma.teacher.findMany({
    include: {
      _count: { select: { classes: true } },
    },
    orderBy: { username: 'asc' },
  })

  return teachers.map(t => ({
    id: t.id,
    username: t.username,
    isAdmin: t.isAdmin,
    classCount: t._count.classes,
    createdAt: t.createdAt,
    lastLogin: null, // 如需要可添加登录日志模型
  }))
}

/**
 * 编辑班级信息（名称）
 */
export async function editClass(classId, teacherId, newName, adminId, ip = '') {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls) {
    return { ok: false, message: '班级不存在', status: 404 }
  }

  const oldName = cls.name
  await prisma.class.update({
    where: { id: classId },
    data: { name: newName },
  })

  await createAuditLog({
    adminId,
    action: 'EDIT_CLASS',
    target: `班级「${oldName}」→「${newName}」(${classId})`,
    detail: JSON.stringify({ teacherId, oldName, newName }),
    ip,
  })

  return { ok: true, message: '班级已更新' }
}

/**
 * 删除班级（管理员直接操作）
 */
export async function deleteClassByAdmin(classId, adminId, ip = '') {
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    include: { teacher: { select: { username: true } } },
  })
  if (!cls) {
    return { ok: false, message: '班级不存在', status: 404 }
  }

  const { deleteClassesCascadeWithTx } = await import('./class.js')

  await prisma.$transaction(async (tx) => {
    await deleteClassesCascadeWithTx(tx, [classId])
  })

  await createAuditLog({
    adminId,
    action: 'DELETE_CLASS',
    target: `班级「${cls.name}」(${classId})`,
    detail: JSON.stringify({ teacherId: cls.teacherId, teacher: cls.teacher.username }),
    ip,
  })

  return { ok: true, message: `已删除班级「${cls.name}」` }
}
