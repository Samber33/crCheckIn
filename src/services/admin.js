import { prisma } from '../plugins/db.js'
import { formatMinute } from '../utils/time.js'

/**
 * 生成批次标签，格式：2025-03-18 周二 上午 · 班级名
 */
function makeSessionLabel(className) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const day = days[now.getDay()]
  const hour = now.getHours()
  const period = hour < 12 ? '上午' : '下午'
  return `${date} ${day} ${period} · ${className}`
}

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
 * 获取所有班级的实时状态（管理员全局看板）
 */
export async function getAllClassesStatus() {
  const classes = await prisma.class.findMany({
    orderBy: [{ teacher: { username: 'asc' } }, { name: 'asc' }],
    include: { teacher: { select: { username: true } } },
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
    if (config?.startTime && config?.endTime) {
      if (now >= config.startTime && now <= config.endTime) {
        signInStatus = '进行中'
      } else if (now < config.startTime) {
        signInStatus = '未开始'
      } else {
        signInStatus = '已结束'
      }
    }

    const signedCount = recordCountMap.get(cls.id) || 0

    return {
      id: cls.id,
      name: cls.name,
      teacherUsername: cls.teacher.username,
      teacherId: cls.teacherId,
      studentCount: 0, // will be enriched if needed
      signedCount,
      totalSessions: sessionCountMap.get(cls.id) || 0,
      signInStatus,
      isArchived: cls.isArchived,
      window: {
        start: config ? formatMinute(config.startTime ? new Date(config.startTime) : null) : null,
        end: config ? formatMinute(config.endTime ? new Date(config.endTime) : null) : null,
      },
    }
  })
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
    if (config?.startTime && config?.endTime) {
      if (now >= config.startTime && now <= config.endTime) {
        signInStatus = '进行中'
      } else if (now < config.startTime) {
        signInStatus = '未开始'
      } else {
        signInStatus = '已结束'
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
      window: {
        start: config ? formatMinute(config.startTime ? new Date(config.startTime) : null) : null,
        end: config ? formatMinute(config.endTime ? new Date(config.endTime) : null) : null,
      },
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
 */
export async function archiveAllClasses(adminId, ip = '') {
  const classes = await prisma.class.findMany({
    where: { signInRecords: { some: {} } },
    include: { signInRecords: { include: { student: true } } },
  })

  if (classes.length === 0) {
    return { ok: true, archived: 0, message: '没有需要归档的签到记录' }
  }

  let totalArchived = 0
  const results = []

  await prisma.$transaction(async (tx) => {
    for (const cls of classes) {
      if (cls.signInRecords.length === 0) continue

      const label = makeSessionLabel(cls.name)

      await tx.signInSession.create({
        data: {
          classId: cls.id,
          label,
          records: {
            create: cls.signInRecords.map(r => ({
              studentName: r.studentName,
              homeClass: r.student?.homeClass ?? '',
              computerName: r.computerName,
              signedAt: r.signedAt,
            })),
          },
        },
      })

      const count = cls.signInRecords.length
      await tx.signInRecord.deleteMany({ where: { classId: cls.id } })
      await tx.signInConfig.updateMany({
        where: { classId: cls.id },
        data: { startTime: null, endTime: null },
      })

      totalArchived += count
      results.push({ classId: cls.id, className: cls.name, archived: count })
    }
  })

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

  // 每个教师的班级统计数据
  const teacherStats = await Promise.all(
    teachers.map(async (t) => {
      const [classes, sessionsCount, signInRecCount, archivedRecCount, studentsCount] = await Promise.all([
        prisma.class.findMany({
          where: { teacherId: t.id },
          include: {
            _count: { select: { students: true, signInRecords: true, sessions: true } },
          },
          orderBy: { name: 'asc' },
        }),
        prisma.signInSession.count({ where: { class: { teacherId: t.id } } }),
        prisma.signInRecord.count({ where: { class: { teacherId: t.id } } }),
        prisma.archivedRecord.count({ where: { session: { class: { teacherId: t.id } } } }),
        prisma.student.count({ where: { class: { teacherId: t.id } } }),
      ])

      const recordsCount = signInRecCount + archivedRecCount

      return {
        id: t.id,
        username: t.username,
        isAdmin: t.isAdmin,
        classCount: t._count.classes,
        sessionsCount,
        recordsCount,
        studentsCount,
        classes: classes.map(c => ({
          id: c.id,
          name: c.name,
          studentCount: c._count.students,
          signedCount: c._count.signInRecords,
          sessionCount: c._count.sessions,
        })),
      }
    })
  )

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
