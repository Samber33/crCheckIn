import { prisma } from '../plugins/db.js'

/**
 * 获取教师的所有班级（按 createdAt 升序）。
 * @param {number} teacherId
 * @returns {Promise<object[]>}
 */
export async function getClasses(teacherId) {
  const classes = await prisma.class.findMany({
    where: { teacherId },
    orderBy: { createdAt: 'asc' },
    include: {
      _count: {
        select: {
          students: true,
          signInRecords: true,
        },
      },
    },
  })

  return classes.map((cls) => ({
    ...cls,
    studentCount: cls._count.students,
    signedCount: cls._count.signInRecords,
  }))
}

/**
 * 查找第一个缺失的班级 ID（用于复用已删除的 ID）。
 * @param {number} teacherId
 * @returns {Promise<number>} 可用的 ID
 */
async function findNextAvailableId(teacherId) {
  const classes = await prisma.class.findMany({
    where: { teacherId },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  const ids = classes.map(c => c.id)
  for (let i = 1; i <= ids.length; i++) {
    if (ids[i - 1] !== i) return i
  }
  return ids.length + 1
}

/**
 * 创建班级，同时创建对应的 SignInConfig（startTime/endTime 为 null）。
 * 同一教师下班级名唯一（@@unique([teacherId, name])）。
 * 会自动复用已删除的班级 ID。
 * @param {number} teacherId
 * @param {string} name
 * @returns {Promise<object>} 创建的 Class 记录
 */
export async function createClass(teacherId, name) {
  const existing = await prisma.class.findUnique({
    where: { teacherId_name: { teacherId, name } },
  })
  if (existing) {
    const err = new Error('该班级名称已存在')
    err.statusCode = 409
    throw err
  }

  const nextId = await findNextAvailableId(teacherId)

  return prisma.class.create({
    data: {
      id: nextId,
      name,
      teacherId,
      signInConfig: {
        create: { startTime: null, endTime: null },
      },
    },
    include: { signInConfig: true },
  })
}

/**
 * 验证班级归属（防越权）。
 * isAdmin=true 时跳过检查直接返回班级；否则验证 teacherId，不匹配则抛出 403。
 * @param {number} classId
 * @param {number} teacherId
 * @param {boolean} [isAdmin=false]
 * @returns {Promise<object>} Class 记录
 */
export async function assertClassOwner(classId, teacherId, isAdmin = false) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })

  if (!cls) {
    const err = new Error('班级不存在')
    err.statusCode = 404
    throw err
  }

  if (isAdmin) return cls

  if (cls.teacherId !== teacherId) {
    const err = new Error('无权访问该班级')
    err.statusCode = 403
    throw err
  }

  return cls
}

export async function deleteClassesCascadeWithTx(tx, classIds) {
  if (classIds.length === 0) return

  // 1. 归档记录（依赖 SignInSession）
  const sessions = await tx.signInSession.findMany({
    where: { classId: { in: classIds } },
    select: { id: true },
  })
  const sessionIds = sessions.map((session) => session.id)

  if (sessionIds.length > 0) {
    await tx.archivedRecord.deleteMany({ where: { sessionId: { in: sessionIds } } })
  }

  // 2. 信息收集（依赖 Class，无级联约束需手动清理）
  const collections = await tx.infoCollection.findMany({
    where: { classId: { in: classIds } },
    select: { id: true },
  })
  const collectionIds = collections.map(c => c.id)
  if (collectionIds.length > 0) {
    await tx.infoResponse.deleteMany({ where: { field: { collectionId: { in: collectionIds } } } })
    await tx.infoField.deleteMany({ where: { collectionId: { in: collectionIds } } })
    await tx.infoCollection.deleteMany({ where: { classId: { in: classIds } } })
  }

  // 3. 会话/配置/签到记录（依赖 Class）
  await tx.signInSession.deleteMany({ where: { classId: { in: classIds } } })
  await tx.signInConfig.deleteMany({ where: { classId: { in: classIds } } })
  await tx.signInRecord.deleteMany({ where: { classId: { in: classIds } } })

  // 4. 学生标签（依赖 Student）
  await tx.studentTag.deleteMany({ where: { classId: { in: classIds } } })

  // 5. 学生（依赖 Class）
  await tx.student.deleteMany({ where: { classId: { in: classIds } } })

  // 6. 班级
  await tx.class.deleteMany({ where: { id: { in: classIds } } })
}

export async function deleteClassesCascade(classIds) {
  await prisma.$transaction(async (tx) => {
    await deleteClassesCascadeWithTx(tx, classIds)
  })
}

/**
 * 删除班级，级联删除历史归档、当前签到、配置与学生记录。
 * @param {number} classId
 * @param {number} teacherId
 * @param {boolean} [isAdmin=false]
 * @returns {Promise<void>}
 */
export async function deleteClass(classId, teacherId, isAdmin = false) {
  await assertClassOwner(classId, teacherId, isAdmin)
  await deleteClassesCascade([classId])
}
