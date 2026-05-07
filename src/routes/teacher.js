import { getClasses } from '../services/class.js'
import { isTeacherLoggedIn, teacherRequired, classOwnerRequired } from '../utils/auth.js'
import { prisma } from '../plugins/db.js'
import { getSessionDetailForTeacher } from '../services/attendance.js'

// Set cache-control headers on all teacher-rendered pages
function noCache(reply) {
  reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
  reply.header('Pragma', 'no-cache')
  reply.header('Expires', '0')
}

export default async function teacherRoutes(app) {
  app.get('/teacher/login', async (request, reply) => {
    if (isTeacherLoggedIn(request)) {
      return reply.redirect('/teacher/classes')
    }
    return reply.redirect('/student')
  })

  app.post('/teacher/login', async (request, reply) => {
    return reply.redirect('/student')
  })

  app.post('/teacher/logout', async (request, reply) => {
    request.session.teacherId = null
    request.session.isAdmin = null
    return reply.redirect('/student')
  })

  app.get('/teacher', async (request, reply) => {
    return reply.redirect('/teacher/classes')
  })

  app.get('/teacher/classes', { preHandler: teacherRequired }, async (request, reply) => {
    const teacherId = request.session.teacherId
    const classes = await getClasses(teacherId)
    const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } })
    noCache(reply)
    return reply.view('teacher/classes.html', {
      classes,
      teacher: { id: teacher.id, username: teacher.username, isAdmin: teacher.isAdmin },
    })
  })

  app.get('/teacher/classes/:classId', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.params.classId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const cls = await prisma.class.findUnique({ where: { id: classId } })
    noCache(reply)
    return reply.view('teacher/class.html', { cls, teacherId, isAdmin })
  })

  // 座位预览页（默认教师视角，支持前端切换）
  app.get('/teacher/classes/:classId/seats', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.params.classId, 10)
    const cls = await prisma.class.findUnique({ where: { id: classId } })
    const { getSeatGrid, getSeatGridTeacher } = await import('../services/seat.js')
    const [studentGrid, teacherGrid] = await Promise.all([
      getSeatGrid(classId),
      getSeatGridTeacher(classId),
    ])
    const signedCount = teacherGrid.flat().reduce((acc, cell) => acc + cell.students.length, 0)
    noCache(reply)
    return reply.view('teacher/seat_view.html', {
      cls,
      classId,
      pageTitle: `${cls.name} - 座位表`,
      subtitle: null,
      backHref: `/teacher/classes/${classId}`,
      pollUrl: `/api/seat-grid?classId=${classId}`,
      pollUrlJson: JSON.stringify(`/api/seat-grid?classId=${classId}`),
      studentGridJson: JSON.stringify(studentGrid),
      teacherGridJson: JSON.stringify(teacherGrid),
      signedCount,
      showExport: true,
      exportHref: `/api/export-seats?classId=${classId}`,
      showRefreshControls: true,
      showRefreshControlsJson: JSON.stringify(true),
    })
  })

  app.get('/teacher/sessions/:sessionId/seats', { preHandler: teacherRequired }, async (request, reply) => {
    const sessionId = parseInt(request.params.sessionId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await getSessionDetailForTeacher(sessionId, teacherId, isAdmin)
    if (!result.ok) {
      return reply.code(result.status).send({ ok: false, message: result.message })
    }

    const session = result.session
    const { getSeatGridsFromArchivedRecords } = await import('../services/seat.js')
    const { studentGrid, teacherGrid } = getSeatGridsFromArchivedRecords(session.records ?? [])
    const signedCount = teacherGrid.flat().reduce((acc, cell) => acc + cell.students.length, 0)

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
    })
  })

  // 学生管理页
  app.get('/teacher/classes/:classId/students', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.params.classId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const [cls, students, allClasses] = await Promise.all([
      prisma.class.findUnique({ where: { id: classId } }),
      prisma.student.findMany({ where: { classId }, orderBy: [{ homeClass: 'asc' }, { name: 'asc' }] }),
      isAdmin
        ? prisma.class.findMany({ orderBy: { name: 'asc' } })
        : prisma.class.findMany({ where: { teacherId }, orderBy: { name: 'asc' } }),
    ])
    noCache(reply)
    return reply.view('teacher/students.html', { cls, students, classes: allClasses })
  })
}
