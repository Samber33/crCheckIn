import { prisma } from '../plugins/db.js'
import { formatMinute, formatSecond, nowParts } from '../utils/time.js'
import { getClassTags } from './tag.js'

/**
 * 学生签到
 * @param {number} classId
 * @param {string} studentName
 * @param {string} computerName
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function signIn(classId, studentName, computerName) {
  // 1. 姓名为空
  if (!studentName || studentName.trim() === '') {
    return { ok: false, message: '请输入姓名。' }
  }

  // 2. 姓名不在该班级名单中
  const student = await prisma.student.findFirst({
    where: { classId, name: studentName },
  })
  if (!student) {
    return { ok: false, message: '该姓名不在名单中，请联系老师。' }
  }

  // 3 & 4. 检查签到时间窗口
  const config = await prisma.signInConfig.findUnique({ where: { classId } })
  const now = new Date()
  if (config) {
    if (config.startTime && now < config.startTime) {
      return { ok: false, message: '签到未开始，请在规定时间内签到。' }
    }
    if (config.endTime && now > config.endTime) {
      return { ok: false, message: '签到时间已结束。' }
    }
  }

  // 5. 已签到
  const existing = await prisma.signInRecord.findUnique({
    where: { classId_studentName: { classId, studentName: student.name } },
  })
  if (existing) {
    return { ok: false, message: '你已签到，无需重复提交。' }
  }

  // 6. 创建签到记录 + 清除标签（事务）
  try {
    await prisma.$transaction(async (tx) => {
      await tx.signInRecord.create({
        data: {
          classId,
          studentName: student.name,
          studentId: student.id,
          computerName: computerName || '',
        },
      })
      await tx.studentTag.deleteMany({
        where: { classId, studentId: student.id },
      })
    })
  } catch (err) {
    if (err.code === 'P2002') {
      return { ok: false, message: '你已签到，无需重复提交。' }
    }
    throw err
  }

  // 8. 成功
  return { ok: true, message: `${student.name} 签到成功！` }
}

/**
 * 获取班级签到状态数据（用于教师端展示）
 * @param {number} classId
 * @returns {Promise<object>}
 */
export async function getClassStatus(classId) {
  const [students, records, config, tagMap] = await Promise.all([
    prisma.student.findMany({ where: { classId }, orderBy: { name: 'asc' } }),
    prisma.signInRecord.findMany({ where: { classId }, orderBy: { signedAt: 'desc' } }),
    prisma.signInConfig.findUnique({ where: { classId } }),
    getClassTags(classId),
  ])

  // 建立签到记录索引
  const recordMap = new Map(records.map((r) => [r.studentName, r]))

  // 构建 roster
  const signed = []
  const unsigned = []
  for (const s of students) {
    const tags = tagMap.get(s.id) || []
    const rec = recordMap.get(s.name)
    if (rec) {
      signed.push({
        recordId: rec.id,
        studentName: s.name,
        studentId: s.id,
        homeClass: s.homeClass || '',
        status: '已签到',
        computerName: rec.computerName,
        signedAt: formatSecond(new Date(rec.signedAt)),
        tags,
      })
    } else {
      unsigned.push({
        recordId: null,
        studentName: s.name,
        studentId: s.id,
        homeClass: s.homeClass || '',
        status: '未签到',
        computerName: '-',
        signedAt: '-',
        tags,
      })
    }
  }

  // 已签到按 signedAt 升序
  signed.sort((a, b) => (a.signedAt > b.signedAt ? 1 : -1))
  // 未签到排在前，已签到排在后
  const roster = [...unsigned, ...signed]

  const signedCount = signed.length
  const totalCount = students.length
  const absentCount = totalCount - signedCount

  return {
    roster,
    signedCount,
    totalCount,
    absentCount,
    window: {
      start: config ? formatMinute(config.startTime ? new Date(config.startTime) : null) : null,
      end: config ? formatMinute(config.endTime ? new Date(config.endTime) : null) : null,
    },
  }
}

/**
 * 生成批次标签，格式：2025-03-18 周二 上午 · 班级名
 */
function makeSessionLabel(className) {
  const now = nowParts()
  const pad = (n) => String(n).padStart(2, '0')
  const date = `${now.year}-${pad(now.month)}-${pad(now.day)}`
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const day = days[now.weekDay]
  const hour = now.hour
  const period = hour < 12 ? '上午' : '下午'
  return `${date} ${day} ${period} · ${className}`
}

/**
 * 归档当前签到记录为一个批次，然后清空当前记录
 * @param {number} classId
 * @returns {Promise<{ ok: boolean, label: string }>}
 */
export async function archiveAndReset(classId) {
  const [cls, records] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId } }),
    prisma.signInRecord.findMany({
      where: { classId },
      include: { student: true },
    }),
  ])

  if (records.length === 0) {
    // 没有记录，直接重置（清空时间窗口）
    await prisma.signInConfig.updateMany({
      where: { classId },
      data: { startTime: null, endTime: null },
    })
    return { ok: true, label: null }
  }

  const label = makeSessionLabel(cls.name)

  await prisma.$transaction(async (tx) => {
    const session = await tx.signInSession.create({
      data: {
        classId,
        label,
        records: {
          create: records.map((r) => ({
            studentName: r.studentName,
            homeClass: r.student?.homeClass ?? '',
            computerName: r.computerName,
            signedAt: r.signedAt,
          })),
        },
      },
    })
    await tx.signInRecord.deleteMany({ where: { classId } })
    await tx.signInConfig.updateMany({
      where: { classId },
      data: { startTime: null, endTime: null },
    })
    return session
  })

  return { ok: true, label }
}

/**
 * 获取班级所有历史批次（不含当前）
 * @param {number} classId
 */
export async function getSessions(classId) {
  return prisma.signInSession.findMany({
    where: { classId },
    orderBy: { archivedAt: 'desc' },
    include: { _count: { select: { records: true } } },
  })
}

/**
 * 获取某个历史批次的详细记录
 * @param {number} sessionId
 */
export async function getSessionDetail(sessionId) {
  return prisma.signInSession.findUnique({
    where: { id: sessionId },
    include: {
      records: { orderBy: { signedAt: 'asc' } },
      class: true,
    },
  })
}

export async function getSessionDetailForTeacher(sessionId, teacherId, isAdmin = false) {
  const session = await getSessionDetail(sessionId)
  if (!session) {
    return { ok: false, message: '批次不存在', status: 404 }
  }

  if (!isAdmin && session.class?.teacherId !== teacherId) {
    return { ok: false, message: '无权限', status: 403 }
  }

  return { ok: true, session }
}

/**
 * 获取历史批次点名名单（含已签到/未签到）
 * 说明：未签到基于“当前班级学生名单 - 历史已签到名单”计算。
 * @param {number} sessionId
 * @param {number} teacherId
 * @param {boolean} isAdmin
 */
export async function getSessionRosterForTeacher(sessionId, teacherId, isAdmin = false) {
  const result = await getSessionDetailForTeacher(sessionId, teacherId, isAdmin)
  if (!result.ok) return result

  const session = result.session
  const students = await prisma.student.findMany({
    where: { classId: session.classId },
    orderBy: [{ homeClass: 'asc' }, { name: 'asc' }],
  })
  const tagMap = await getClassTags(session.classId)

  const signedMap = new Map()
  for (const rec of (session.records ?? [])) {
    signedMap.set(rec.studentName, rec)
  }
  const studentNameSet = new Set(students.map(stu => stu.name))

  const roster = students.map((stu) => {
    const tags = tagMap.get(stu.id) || []
    const rec = signedMap.get(stu.name)
    if (rec) {
      return {
        studentName: stu.name,
        studentId: stu.id,
        homeClass: stu.homeClass || '',
        status: '已签到',
        signedAt: rec.signedAt ? formatSecond(new Date(rec.signedAt)) : '-',
        computerName: rec.computerName || '-',
        tags,
      }
    }
    return {
      studentName: stu.name,
      studentId: stu.id,
      homeClass: stu.homeClass || '',
      status: '未签到',
      signedAt: '-',
      computerName: '-',
      tags,
    }
  })

  const snapshotOnlySigned = (session.records ?? [])
    .filter(rec => !studentNameSet.has(rec.studentName))
    .map(rec => ({
      studentName: rec.studentName,
      studentId: null,
      homeClass: rec.homeClass || '',
      status: '已签到',
      signedAt: rec.signedAt ? formatSecond(new Date(rec.signedAt)) : '-',
      computerName: rec.computerName || '-',
      tags: [],
    }))

  roster.push(...snapshotOnlySigned)

  // Sort: unsigned first, then signed
  roster.sort((a, b) => {
    if (a.status === '未签到' && b.status === '已签到') return -1
    if (a.status === '已签到' && b.status === '未签到') return 1
    return 0
  })

  return {
    ok: true,
    session,
    roster,
    signedCount: (session.records ?? []).length,
    totalCount: roster.length,
    absentCount: roster.filter(r => r.status === '未签到').length,
  }
}

/**
 * 删除历史批次及其归档记录
 * @param {number} sessionId
 * @param {number} teacherId
 * @param {boolean} isAdmin
 * @returns {Promise<{ ok: boolean, message?: string, status?: number }>}
 */
export async function deleteSession(sessionId, teacherId, isAdmin = false) {
  const result = await getSessionDetailForTeacher(sessionId, teacherId, isAdmin)
  if (!result.ok) return result

  await prisma.$transaction(async (tx) => {
    await tx.archivedRecord.deleteMany({ where: { sessionId } })
    await tx.signInSession.delete({ where: { id: sessionId } })
  })

  return { ok: true, message: '历史批次已删除。' }
}

/**
 * 删除该班级的所有签到记录和所有学生
 * @param {number} classId
 */
export async function clearRoster(classId) {
  await prisma.signInRecord.deleteMany({ where: { classId } })
  await prisma.student.deleteMany({ where: { classId } })
}

/**
 * 撤销签到记录
 * @param {number} recordId
 * @param {number} teacherId
 * @param {boolean} isAdmin
 * @returns {Promise<{ ok: boolean, message?: string, status?: number }>}
 */
export async function deleteSignInRecord(recordId, teacherId, isAdmin = false) {
  const record = await prisma.signInRecord.findUnique({
    where: { id: recordId },
    include: { class: true },
  })
  if (!record) {
    return { ok: false, message: '记录不存在', status: 404 }
  }
  if (!isAdmin && record.class.teacherId !== teacherId) {
    return { ok: false, message: '无权限', status: 403 }
  }
  await prisma.signInRecord.delete({ where: { id: recordId } })
  return { ok: true }
}

/**
 * 跨批次出勤率统计
 * @param {number} classId
 * @returns {Promise<{ totalSessions: number, students: Array }>}
 */
export async function getAttendanceStats(classId) {
  const [students, sessions, tagMap] = await Promise.all([
    prisma.student.findMany({ where: { classId }, orderBy: { name: 'asc' } }),
    prisma.signInSession.findMany({
      where: { classId },
      include: { records: { select: { studentName: true } } },
    }),
    getClassTags(classId),
  ])

  const totalSessions = sessions.length

  // 每位学生在各批次中的签到次数
  const countMap = new Map()
  for (const session of sessions) {
    for (const rec of session.records) {
      countMap.set(rec.studentName, (countMap.get(rec.studentName) || 0) + 1)
    }
  }

  const result = students.map((s) => {
    const signedCount = countMap.get(s.name) || 0
    const absentCount = totalSessions - signedCount
    const rate = totalSessions === 0 ? '0.00' : (signedCount / totalSessions * 100).toFixed(2)
    return { studentId: s.id, name: s.name, homeClass: s.homeClass || '', tags: tagMap.get(s.id) || [], signedCount, absentCount, rate }
  })

  result.sort((a, b) => {
    const rd = parseFloat(a.rate) - parseFloat(b.rate)
    return rd !== 0 ? rd : a.name.localeCompare(b.name)
  })

  return { totalSessions, students: result }
}

/**
 * 设置班级签到时间窗口
 * @param {number} classId
 * @param {Date|null} startTime
 * @param {Date|null} endTime
 */
export async function setSignInWindow(classId, startTime, endTime) {
  await prisma.signInConfig.upsert({
    where: { classId },
    update: { startTime, endTime },
    create: { classId, startTime, endTime },
  })
}

/**
 * 增强出勤分析 — 包含趋势、时段分布、批次对比
 * 注意：仅加载最近 50 批次用于图表展示，避免大数据集内存问题。
 * @param {number} classId
 * @returns {Promise<object>}
 */
export async function getAttendanceAnalytics(classId) {
  const [students, sessionCount, currentRecordsCount, totalArchivedRecordsCount] = await Promise.all([
    prisma.student.findMany({ where: { classId }, orderBy: { name: 'asc' } }),
    prisma.signInSession.count({ where: { classId } }),
    prisma.signInRecord.count({ where: { classId } }),
    prisma.archivedRecord.count({
      where: { session: { classId } },
    }),
  ])

  const MAX_SESSIONS = 50
  const sessions = await prisma.signInSession.findMany({
    where: { classId },
    include: { records: { select: { studentName: true, signedAt: true } } },
    orderBy: { archivedAt: 'asc' },
    skip: Math.max(0, sessionCount - MAX_SESSIONS),
  })

  // 当前签到记录（未归档）
  const records = await prisma.signInRecord.findMany({
    where: { classId },
    orderBy: { signedAt: 'asc' },
  })

  const studentNames = new Set(students.map(s => s.name))

  // === 1. 每批次签到趋势 ===
  const sessionTrend = sessions.map(s => ({
    label: s.label,
    archivedAt: s.archivedAt,
    count: s.records.length,
    rate: studentNames.size > 0 ? ((s.records.filter(r => studentNames.has(r.studentName)).length / studentNames.size) * 100).toFixed(1) : '0',
  }))

  // === 2 & 3. 时段/星期分布（单次遍历）===
  const hourDistribution = new Array(24).fill(0)
  const dayDistribution = new Array(7).fill(0)
  const allRecords = [...sessions.flatMap(s => s.records), ...records]
  for (const rec of allRecords) {
    const d = new Date(rec.signedAt)
    hourDistribution[d.getHours()]++
    dayDistribution[d.getDay()]++
  }

  // === 4. 学生个人出勤趋势（最近5个批次）===
  const recentSessions = sessions.slice(-5)
  // 预提取标签，避免在 inner loop 中重复 split
  const recentLabels = recentSessions.map(s => s.label.split(' · ')[0])
  // 建立 sessionIndex -> studentNameSet 的 Map，将 O(n*m) 降为 O(n+m)
  const sessionSets = recentSessions.map(s => new Set(s.records.map(r => r.studentName)))
  const personalTrend = students.map(s => ({
    name: s.name,
    homeClass: s.homeClass || '',
    history: recentSessions.map((_, i) => ({
      label: recentLabels[i],
      signed: sessionSets[i].has(s.name),
    })),
  }))

  // === 5. 整体统计摘要（基于全量数据库查询，不受加载上限影响）===
  const totalSignIns = totalArchivedRecordsCount + currentRecordsCount
  const uniqueStudents = students.length
  const avgPerSession = sessionCount > 0 ? (totalSignIns / sessionCount).toFixed(1) : '0'
  const overallRate = uniqueStudents > 0 && sessionCount > 0
    ? ((totalSignIns / (uniqueStudents * sessionCount)) * 100).toFixed(1)
    : '0'

  // === 6. 签到速度（每批次前10分钟内签到的人数比例）===
  const speedStats = sessions.map(s => {
    if (s.records.length === 0) return 0
    const times = s.records.map(r => new Date(r.signedAt).getTime()).sort((a, b) => a - b)
    const firstTime = times[0]
    const within10min = times.filter(t => t - firstTime <= 10 * 60 * 1000).length
    return (within10min / s.records.length) * 100
  })
  const avgSpeed = speedStats.length > 0 ? (speedStats.reduce((a, b) => a + b, 0) / speedStats.length).toFixed(1) : '0'

  return {
    summary: {
      totalSessions: sessionCount,
      totalSignIns,
      uniqueStudents,
      avgPerSession,
      overallRate,
      avgSpeed,
    },
    sessionTrend,
    hourDistribution,
    dayDistribution,
    personalTrend,
  }
}
