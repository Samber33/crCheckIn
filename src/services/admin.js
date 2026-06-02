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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
export async function getAllClassesDetail({ includePool = false } = {}) {
  const classes = await prisma.class.findMany({
    where: includePool ? undefined : { teacherId: { not: null } },
    orderBy: [{ teacher: { username: 'asc' } }, { name: 'asc' }],
    include: {
      teacher: { select: { username: true } },
      _count: { select: { students: true } },
    },
  })

  // 池班级需要去重学生数（同一学生在不同教学班只计一次）
  const poolClassIds = classes.filter(c => c.teacherId === null).map(c => c.id)
  const poolStudents = poolClassIds.length > 0
    ? await prisma.student.findMany({
        where: { classId: { in: poolClassIds } },
        select: { classId: true, name: true, homeClass: true },
      })
    : []

  // 按 classId → name+homeClass 去重
  const poolUniqueCounts = new Map()
  for (const s of poolStudents) {
    const key = `${s.classId}|||${s.name}|||${s.homeClass}`
    if (!poolUniqueCounts.has(key)) {
      poolUniqueCounts.set(key, s.classId)
    }
  }
  const poolCountMap = new Map()
  for (const [, classId] of poolUniqueCounts) {
    poolCountMap.set(classId, (poolCountMap.get(classId) || 0) + 1)
  }

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
      teacherUsername: cls.teacher?.username ?? '班级池',
      teacherId: cls.teacherId,
      studentCount: cls.teacherId === null ? (poolCountMap.get(cls.id) || 0) : cls._count.students,
      signedCount: recordCountMap.get(cls.id) || 0,
      totalSessions: sessionCountMap.get(cls.id) || 0,
      signInStatus,
      isArchived: cls.isArchived,
      isSigning: signInStatus === '签到中',
      isPoolClass: cls.teacherId === null,
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
  const oldTeacherName = cls.teacher?.username ?? '班级池'

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
              studentIp: r.studentIp ?? '',
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
    detail: JSON.stringify({ teacherId: cls.teacherId, teacher: cls.teacher?.username ?? '班级池' }),
    ip,
  })

  return { ok: true, message: `已删除班级「${cls.name}」` }
}

/**
 * 复制班级及学生到班级池（原班级保留不动）
 */
export async function copyClassToPool(classId, adminId, ip = '') {
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    include: { teacher: { select: { username: true } } },
  })
  if (!cls) return { ok: false, message: '班级不存在', status: 404 }

  const teacherName = cls.teacher?.username ?? '未知'

  // 复用池中已有的同名班级，避免重复卡片。
  let poolClass = await prisma.class.findFirst({
    where: {
      name: cls.name,
      teacherId: null,
      deletedAt: null,
      isArchived: false,
    },
    select: { id: true },
  })
  const reusedExistingPoolClass = !!poolClass
  if (!poolClass) {
    poolClass = await prisma.class.create({
      data: {
        name: cls.name,
        teacherId: null,
        signInConfig: { create: {} },
      },
    })
  }

  // 将缺少的学生补充到池班级。
  const students = await prisma.student.findMany({
    where: { classId },
    select: { name: true, homeClass: true, remark: true, photoUrl: true },
  })
  const existingStudents = await prisma.student.findMany({
    where: { classId: poolClass.id },
    select: { name: true },
  })
  const existingNames = new Set(existingStudents.map(student => student.name))
  const studentsToCopy = students.filter(student => !existingNames.has(student.name))
  if (studentsToCopy.length > 0) {
    await prisma.student.createMany({
      data: studentsToCopy.map(s => ({
        name: s.name,
        homeClass: s.homeClass,
        remark: s.remark,
        photoUrl: s.photoUrl,
        classId: poolClass.id,
      })),
    })
  }

  await createAuditLog({
    adminId,
    action: 'COPY_TO_POOL',
    target: `班级「${cls.name}」→ 班级池 (${poolClass.id})`,
    detail: JSON.stringify({ from: teacherName, fromId: cls.teacherId, originalClassId: classId, newClassId: poolClass.id, studentCount: studentsToCopy.length, reusedExistingPoolClass }),
    ip,
  })

  return { ok: true, message: `已将「${cls.name}」及 ${studentsToCopy.length} 名学生同步到班级池` }
}
