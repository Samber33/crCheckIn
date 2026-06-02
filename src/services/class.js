import { prisma } from '../plugins/db.js'

/**
 * 获取教师的所有班级（按 createdAt 升序）。
 * @param {number} teacherId
 * @param {object} [options]
 * @param {boolean} [options.includeArchived=false]
 * @returns {Promise<object[]>}
 */
export async function getClasses(teacherId, { includeArchived = false } = {}) {
  const classes = await prisma.class.findMany({
    where: {
      teacherId,
      ...(includeArchived ? {} : { isArchived: false }),
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      _count: {
        select: {
          students: true,
          signInRecords: true,
        },
      },
      signInConfig: true,
    },
  })

  const now = new Date()
  return classes.map((cls) => {
    const cfg = cls.signInConfig
    const isSigning = cfg && cfg.activeStartedAt &&
      now < new Date(cfg.activeStartedAt.getTime() + cfg.countdownDurationMin * 60 * 1000)
    // 从班级名提取年级
    const gradeChar = cls.name.match(/([一二三四五六七八九十])/)?.[1]
    const grade = gradeChar ? { '一': '高一', '二': '高二', '三': '高三', '四': '高四' }[gradeChar] : '其他'
    return {
      ...cls,
      studentCount: cls._count.students,
      signedCount: cls._count.signInRecords,
      isSigning,
      grade,
    }
  })
}

/**
 * 重新排序教师的班级
 * @param {number} teacherId
 * @param {number[]} classIds - 按新顺序排列的班级 ID 数组
 */
export async function reorderClasses(teacherId, classIds) {
  const updates = classIds.map((id, index) =>
    prisma.class.updateMany({
      where: { id, teacherId },
      data: { sortOrder: index },
    })
  )
  await Promise.all(updates)
}

/**
 * 创建班级，同时创建对应的 SignInConfig（倒计时未激活）。
 * @param {number} teacherId
 * @param {string} name
 * @returns {Promise<object>} 创建的 Class 记录
 */
export async function createClass(teacherId, name) {
  const cls = await prisma.class.create({
    data: {
      name,
      teacherId,
      signInConfig: {
        create: {},
      },
    },
    include: { signInConfig: true },
  })
  // 新增班级，缓存无需失效（新 classId 首次查询会回写缓存）
  return cls
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

  // 班级池班级（teacherId IS NULL）只有管理员可操作
  if (cls.teacherId === null) {
    if (!isAdmin) {
      const err = new Error('无权操作班级池班级')
      err.statusCode = 403
      throw err
    }
    return cls
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
  const { invalidateClassTeacherCache } = await import('./sse.js')
  await prisma.$transaction(async (tx) => {
    await deleteClassesCascadeWithTx(tx, classIds)
  })
  invalidateClassTeacherCache(classIds)
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

/**
 * 归档班级（设置 isArchived = true）。
 */
export async function archiveClass(classId, teacherId, isAdmin = false) {
  await assertClassOwner(classId, teacherId, isAdmin)
  await prisma.class.update({ where: { id: classId }, data: { isArchived: true } })
  const { invalidateClassTeacherCache } = await import('./sse.js')
  invalidateClassTeacherCache(classId)
  return { ok: true, message: '班级已归档' }
}

/**
 * 恢复班级（设置 isArchived = false）。
 */
export async function unarchiveClass(classId, teacherId, isAdmin = false) {
  await assertClassOwner(classId, teacherId, isAdmin)
  await prisma.class.update({ where: { id: classId }, data: { isArchived: false } })
  const { invalidateClassTeacherCache } = await import('./sse.js')
  invalidateClassTeacherCache(classId)
  return { ok: true, message: '班级已恢复' }
}
