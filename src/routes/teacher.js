import { getClasses } from '../services/class.js'
import { isTeacherLoggedIn, teacherRequired, classOwnerRequired } from '../utils/auth.js'
import { prisma } from '../plugins/db.js'
import { getSessionDetailForTeacher, getSessionRosterForTeacher } from '../services/attendance.js'

// Set cache-control headers on all teacher-rendered pages
function noCache(reply) {
  reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
  reply.header('Pragma', 'no-cache')
  reply.header('Expires', '0')
}

export default async function teacherRoutes(app) {
  app.post('/teacher/logout', async (request, reply) => {
    request.session = null
    return reply.redirect('/student')
  })

  app.get('/teacher', async (request, reply) => {
    return reply.redirect('/teacher/classes')
  })

  app.get('/teacher/classes', { preHandler: teacherRequired }, async (request, reply) => {
    const teacherId = request.session.teacherId
    const showArchived = request.query.archived === '1'
    const classes = await getClasses(teacherId, { includeArchived: showArchived })
    const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } })
    if (!teacher) {
      request.session = null
      return reply.redirect('/student')
    }
    // Count archived classes for the badge
    const archivedClasses = await getClasses(teacherId, { includeArchived: true })
    const archivedCount = archivedClasses.filter(c => c.isArchived).length
    const maxStudentCount = Math.max(...classes.map(c => c.studentCount), 1)
    noCache(reply)
    return reply.view('teacher/classes.html', {
      classes,
      teacher: { id: teacher.id, username: teacher.username, isAdmin: teacher.isAdmin },
      maxStudentCount,
      showArchived,
      archivedCount,
    })
  })

  app.get('/teacher/classes/:classId', { preHandler: classOwnerRequired }, async (request, reply) => {
    const cls = await prisma.class.findUnique({ where: { id: request.classId } })
    noCache(reply)
    return reply.view('teacher/class.html', { cls, teacherId: request.session.teacherId, isAdmin: request.session.isAdmin === true, sseUrl: `/api/sse` })
  })

  // 信息收集管理页
  app.get('/teacher/info', { preHandler: classOwnerRequired }, async (request, reply) => {
    const cls = await prisma.class.findUnique({ where: { id: request.classId } })
    return reply.view('teacher/info.html', { cls })
  })

  // 座位预览页（默认教师视角，支持前端切换）
  app.get('/teacher/classes/:classId/seats', { preHandler: classOwnerRequired }, async (request, reply) => {
    const cls = await prisma.class.findUnique({ where: { id: request.classId } })
    const { getSeatGrid, getSeatGridTeacher, getSeatGridsFromArchivedRecords } = await import('../services/seat.js')
    const [studentGrid, teacherGrid] = await Promise.all([
      getSeatGrid(request.classId),
      getSeatGridTeacher(request.classId),
    ])
    const signedCount = teacherGrid.flat().reduce((acc, cell) => acc + cell.students.length, 0)

    // 加载上一批次数据（用于对比变动 + 切换查看）
    const lastSession = await prisma.signInSession.findFirst({
      where: { classId: request.classId },
      orderBy: { archivedAt: 'desc' },
      include: { records: { orderBy: { signedAt: 'asc' } } },
    })

    let prevStudentGrid = null
    let prevTeacherGrid = null
    let prevLabel = null
    if (lastSession) {
      const records = lastSession.records.map(r => ({
        studentName: r.studentName,
        homeClass: r.homeClass,
        computerName: r.computerName,
      }))
      const { studentGrid: sg, teacherGrid: tg } = getSeatGridsFromArchivedRecords(records)
      prevStudentGrid = sg
      prevTeacherGrid = tg
      prevLabel = lastSession.label
    }

    noCache(reply)
    return reply.view('teacher/seat_view.html', {
      cls,
      classId: request.classId,
      pageTitle: `${cls.name} - 座位表`,
      subtitle: null,
      backHref: `/teacher/classes/${request.classId}`,
      pollUrl: `/api/seat-grid?classId=${request.classId}`,
      pollUrlJson: JSON.stringify(`/api/seat-grid?classId=${request.classId}`),
      studentGridJson: JSON.stringify(studentGrid),
      teacherGridJson: JSON.stringify(teacherGrid),
      signedCount,
      showExport: true,
      exportHref: `/api/export-seats?classId=${request.classId}`,
      showRefreshControls: true,
      showRefreshControlsJson: JSON.stringify(true),
      hasPreviousSession: !!lastSession,
      prevTeacherGridJson: prevTeacherGrid ? JSON.stringify(prevTeacherGrid) : 'null',
      prevStudentGridJson: prevStudentGrid ? JSON.stringify(prevStudentGrid) : 'null',
      prevLabelJson: prevLabel ? JSON.stringify(prevLabel) : 'null',
    })
  })

  app.get('/teacher/sessions/:sessionId/seats', { preHandler: teacherRequired }, async (request, reply) => {
    const sessionId = parseInt(request.params.sessionId, 10)
    if (isNaN(sessionId)) return reply.code(400).send({ ok: false, message: '批次ID无效' })
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await getSessionDetailForTeacher(sessionId, teacherId, isAdmin)
    if (!result.ok) {
      return reply.code(result.status).send({ ok: false, message: result.message })
    }

    const session = result.session
    const { getSeatGridsWithTags } = await import('../services/seat.js')
    const { studentGrid, teacherGrid } = await getSeatGridsWithTags(session.records ?? [], session.classId)
    const signedCount = teacherGrid.flat().reduce((acc, cell) => acc + cell.students.length, 0)

    // Get archived roster with sign-in status
    const rosterResult = await getSessionRosterForTeacher(sessionId, teacherId, isAdmin)
    const archivedRoster = rosterResult.ok ? rosterResult.roster : []

    // Load the session before this one (for position change comparison)
    const prevSession = await prisma.signInSession.findFirst({
      where: { classId: session.classId, archivedAt: { lt: session.archivedAt } },
      orderBy: { archivedAt: 'desc' },
      include: { records: { orderBy: { signedAt: 'asc' } } },
    })

    let hasPrevSession = false
    let prevStudentGridJson = 'null'
    let prevTeacherGridJson = 'null'
    let prevLabelJson = 'null'
    if (prevSession) {
      hasPrevSession = true
      const prevRecords = prevSession.records.map(r => ({
        studentName: r.studentName,
        homeClass: r.homeClass,
        computerName: r.computerName,
      }))
      const { studentGrid: psg, teacherGrid: ptg } = await getSeatGridsWithTags(prevRecords, session.classId)
      prevStudentGridJson = JSON.stringify(psg)
      prevTeacherGridJson = JSON.stringify(ptg)
      prevLabelJson = JSON.stringify(prevSession.label)
    }

    noCache(reply)
    return reply.view('teacher/seat_view.html', {
      cls: session.class,
      classId: session.classId,
      pageTitle: `${session.class.name} - 历史批次座位表`,
      subtitle: session.label,
      backHref: `/teacher/classes/${session.classId}`,
      pollUrl: null,
      pollUrlJson: 'null',
      studentGridJson: JSON.stringify(studentGrid),
      teacherGridJson: JSON.stringify(teacherGrid),
      signedCount,
      showExport: true,
      exportHref: `/api/sessions/${sessionId}/export-seats`,
      showRefreshControls: false,
      showRefreshControlsJson: JSON.stringify(false),
      archivedRosterJson: JSON.stringify(archivedRoster),
      hasPreviousSession: hasPrevSession,
      prevTeacherGridJson,
      prevStudentGridJson,
      prevLabelJson,
    })
  })

  // 学生管理页
  app.get('/teacher/classes/:classId/students', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = request.classId
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const { getClassTags } = await import('../services/tag.js')
    const [cls, students, allClasses, tagMap] = await Promise.all([
      prisma.class.findUnique({ where: { id: classId } }),
      prisma.student.findMany({ where: { classId }, orderBy: [{ homeClass: 'asc' }, { name: 'asc' }] }),
      isAdmin
        ? prisma.class.findMany({ orderBy: { name: 'asc' } })
        : prisma.class.findMany({ where: { teacherId }, orderBy: { name: 'asc' } }),
      getClassTags(classId),
    ])
    // Attach tags to each student
    const studentsWithTags = students.map(s => ({
      ...s,
      tags: tagMap.get(s.id) || [],
    }))
    noCache(reply)
    return reply.view('teacher/students.html', { cls, students: studentsWithTags, classes: allClasses })
  })

  // 数据分析页
  app.get('/teacher/classes/:classId/analytics', { preHandler: classOwnerRequired }, async (request, reply) => {
    const cls = await prisma.class.findUnique({ where: { id: request.classId } })
    noCache(reply)
    return reply.view('teacher/analytics.html', { cls, classId: request.classId })
  })
}
