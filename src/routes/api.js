import { teacherRequired, classOwnerRequired } from '../utils/auth.js'
import { parseDt, nowParts } from '../utils/time.js'
import { resolveClientName } from '../utils/ip.js'
import {
  signIn,
  getClassStatus,
  archiveAndReset,
  clearRoster,
  startSignIn,
  getSessions,
  getSessionDetailForTeacher,
  deleteSession,
  getAttendanceStats,
  getAttendanceAnalytics,
  deleteSignInRecord,
  getSessionRosterForTeacher,
} from '../services/attendance.js'
import {
  importStudentsFromExcel,
  exportRecordsToExcel,
  exportSeatTableToExcel,
  matchStudents,
  exportSessionToExcel,
  exportStatsToExcel,
  exportSessionSeatTableToExcel,
} from '../services/roster.js'
import { createClass, deleteClass, archiveClass, unarchiveClass } from '../services/class.js'
import { changePassword, verifyTeacherByPassword } from '../services/auth.js'
import { getSeatGrid, getSeatGridTeacher } from '../services/seat.js'
import { createStudent, updateStudent, deleteStudent, transferStudent } from '../services/student.js'
import {
  getInfoCollection,
  updateInfoCollection,
  createInfoField,
  updateInfoField,
  deleteInfoField,
  updateFieldSortOrder,
  submitInfo,
  getSubmissions,
  getSubmissionDetail,
  deleteSubmission,
  getSubmissionsStats,
  uploadAttachment,
} from '../services/infoCollection.js'
import {
  getStudentTags,
  getClassTags,
  addStudentTag,
  deleteStudentTag,
  getPresetTags,
} from '../services/tag.js'
import { registerSSE, broadcastToClass } from '../services/sse.js'

/**
 * 格式化当前时间为 YYYYMMDD_HHmmss
 * @returns {string}
 */
function nowTimestamp() {
  const d = nowParts()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.year}${pad(d.month)}${pad(d.day)}_` +
    `${pad(d.hour)}${pad(d.minute)}${pad(d.second)}`
  )
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function apiRoutes(fastify) {
  // GET /api/status — 需要 classOwnerRequired
  fastify.get('/api/status', { preHandler: classOwnerRequired }, async (request, reply) => {
    const payload = await getClassStatus(request.classId)
    return reply.send(payload)
  })

  // POST /api/reset — 归档当前记录并重置，需要 classOwnerRequired
  fastify.post('/api/reset', { preHandler: classOwnerRequired }, async (request, reply) => {
    const result = await archiveAndReset(request.classId)
    broadcastToClass(request.classId, 'countdown-stopped')
    const msg = result.label
      ? `已归档批次「${result.label}」，签到已重置。`
      : '签到记录已重置。'
    return reply.send({ ok: true, message: msg })
  })

  // POST /api/signin/start — 开始签到倒计时，需要 classOwnerRequired
  fastify.post('/api/signin/start', { preHandler: classOwnerRequired }, async (request, reply) => {
    const durationMin = parseInt(request.body?.durationMin, 10) || 40
    const result = await startSignIn(request.classId, durationMin)
    if (!result.ok) return reply.code(result.status).send(result)
    broadcastToClass(request.classId, 'countdown-started')
    return reply.send({ ok: true, message: '签到已开始', countdownEnd: result.countdownEnd.toISOString() })
  })

  // GET /api/sessions — 获取历史批次列表，需要 classOwnerRequired
  fastify.get('/api/sessions', { preHandler: classOwnerRequired }, async (request, reply) => {
    const page = parseInt(request.query.page || 1, 10)
    const pageSize = parseInt(request.query.pageSize || 10, 10)
    const result = await getSessions(request.classId, { page, pageSize })
    return reply.send({
      sessions: result.sessions.map(s => ({
        id: s.id,
        label: s.label,
        archivedAt: s.archivedAt,
        count: s._count.records,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    })
  })

  // GET /api/sessions/:sessionId — 获取批次详情，需要 teacherRequired
  fastify.get('/api/sessions/:sessionId', { preHandler: teacherRequired }, async (request, reply) => {
    const sessionId = parseInt(request.params.sessionId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await getSessionDetailForTeacher(sessionId, teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status).send(result)
    const rosterResult = await getSessionRosterForTeacher(sessionId, teacherId, isAdmin)
    if (!rosterResult.ok) return reply.code(rosterResult.status).send(rosterResult)
    return reply.send({
      ...result.session,
      roster: rosterResult.roster,
      signedCount: rosterResult.signedCount,
      totalCount: rosterResult.totalCount,
      absentCount: rosterResult.absentCount,
    })
  })

  // GET /api/sessions/:sessionId/export — 导出历史批次 Excel，需要 teacherRequired
  fastify.get('/api/sessions/:sessionId/export', { preHandler: teacherRequired }, async (request, reply) => {
    const sessionId = parseInt(request.params.sessionId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await getSessionDetailForTeacher(sessionId, teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status).send(result)

    const rosterResult = await getSessionRosterForTeacher(sessionId, teacherId, isAdmin)
    if (!rosterResult.ok) return reply.code(rosterResult.status).send(rosterResult)
    const buffer = await exportSessionToExcel(result.session, rosterResult.roster)
    const filename = `session_${sessionId}_${nowTimestamp()}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  })

  // GET /api/sessions/:sessionId/export-seats — 导出历史批次座位表 Excel，需要 teacherRequired
  fastify.get('/api/sessions/:sessionId/export-seats', { preHandler: teacherRequired }, async (request, reply) => {
    const sessionId = parseInt(request.params.sessionId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await getSessionDetailForTeacher(sessionId, teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status).send(result)

    const buffer = await exportSessionSeatTableToExcel(result.session)
    const filename = `session_seats_${sessionId}_${nowTimestamp()}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  })

  // DELETE /api/sessions/:sessionId — 删除历史批次，需要 teacherRequired
  fastify.delete('/api/sessions/:sessionId', { preHandler: teacherRequired }, async (request, reply) => {
    const sessionId = parseInt(request.params.sessionId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await deleteSession(sessionId, teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status).send(result)
    return reply.send(result)
  })

  // POST /api/clear-roster — 需要 classOwnerRequired
  fastify.post('/api/clear-roster', { preHandler: classOwnerRequired }, async (request, reply) => {
    await clearRoster(request.classId)
    return reply.send({ ok: true, message: '当前名单与签到记录已清空。' })
  })

  // GET /api/export — 需要 classOwnerRequired
  fastify.get('/api/export', { preHandler: classOwnerRequired }, async (request, reply) => {
    const buffer = await exportRecordsToExcel(request.classId)
    const filename = `signin_records_${nowTimestamp()}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  })

  // GET /api/export-seats — 需要 classOwnerRequired
  fastify.get('/api/export-seats', { preHandler: classOwnerRequired }, async (request, reply) => {
    const buffer = await exportSeatTableToExcel(request.classId)
    const filename = `seat_table_${nowTimestamp()}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  })

  // POST /api/import — 需要 teacherRequired
  fastify.post('/api/import', { preHandler: teacherRequired }, async (request, reply) => {
    try {
      let fileBuffer = null
      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          const chunks = []
          for await (const chunk of part.file) {
            chunks.push(chunk)
          }
          fileBuffer = Buffer.concat(chunks)
        }
      }
      if (!fileBuffer) {
        return reply.code(400).send({ ok: false, message: '请上传 Excel 文件。' })
      }
      const teacherId = request.session.teacherId
      const count = await importStudentsFromExcel(teacherId, fileBuffer)
      return reply.send({ ok: true, message: `导入完成，新增 ${count} 名学生。` })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ ok: false, message: `导入失败：${err.message}` })
    }
  })

  // POST /api/change-password — 需要 teacherRequired
  fastify.post('/api/change-password', { preHandler: teacherRequired }, async (request, reply) => {
    const { old_password, new_password } = request.body
    const teacherId = request.session.teacherId
    const result = await changePassword(teacherId, old_password, new_password)
    if (!result.ok) {
      return reply.code(400).send(result)
    }
    return reply.send(result)
  })

  // POST /api/teacher-login — 通过口令登录教师/管理员端（供学生端入口使用）
  fastify.post('/api/teacher-login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { password } = request.body ?? {}
    const result = await verifyTeacherByPassword(password)
    if (!result.ok) return reply.send({ ok: false, message: result.message })

    request.session.teacherId = result.teacher.id
    request.session.isAdmin = result.teacher.isAdmin
    return reply.send({
      ok: true,
      redirect: '/teacher/classes',
    })
  })

  // POST /api/classes — 需要 teacherRequired
  fastify.post('/api/classes', { preHandler: teacherRequired }, async (request, reply) => {
    const { name } = request.body
    const teacherId = request.session.teacherId
    const cls = await createClass(teacherId, name)
    return reply.code(201).send({ ok: true, class: cls })
  })

  // DELETE /api/classes/:classId — 需要 classOwnerRequired
  fastify.delete('/api/classes/:classId', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.params.classId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    await deleteClass(classId, teacherId, isAdmin)
    return reply.send({ ok: true, message: '班级已删除。' })
  })

  // POST /api/classes/:classId/archive — 归档班级，需要 classOwnerRequired
  fastify.post('/api/classes/:classId/archive', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.params.classId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await archiveClass(classId, teacherId, isAdmin)
    return reply.send(result)
  })

  // POST /api/classes/:classId/unarchive — 恢复班级，需要 classOwnerRequired
  fastify.post('/api/classes/:classId/unarchive', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.params.classId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await unarchiveClass(classId, teacherId, isAdmin)
    return reply.send(result)
  })

  // GET /api/students/match — 无需登录，限速防枚举
  fastify.get('/api/students/match', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const q = request.query.q || ''
    const classId = request.query.classId ? parseInt(request.query.classId, 10) : null
    const students = await matchStudents(q, 15, classId)
    return reply.send(students)
  })

  // POST /api/signin — 无需登录
  fastify.post('/api/signin', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { classId: rawClassId, student_name } = request.body
    const classId = parseInt(rawClassId, 10)
    const computerName = resolveClientName(request)
    const studentIp = resolveClientName(request)
    const result = await signIn(classId, student_name, computerName, studentIp)
    if (!result.ok) {
      return reply.code(400).send(result)
    }
    // 广播 SSE 事件给该班级教师
    broadcastToClass(classId, 'signin')
    return reply.send(result)
  })

  // GET /api/sse — SSE 实时推送通道，需要 teacherRequired
  fastify.get('/api/sse', { preHandler: teacherRequired }, async (request, reply) => {
    const teacherId = request.session.teacherId
    const socket = request.raw.socket

    reply
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')

    // 发送初始连接确认
    socket.write(`event: connected\ndata: {}\n\n`)

    // 注册 socket 到 SSE 管理器
    registerSSE(teacherId, socket)

    // 心跳保活
    const heartbeat = setInterval(() => {
      try {
        socket.write(`: heartbeat\n\n`)
      } catch {
        clearInterval(heartbeat)
      }
    }, 30000)
    heartbeat.unref()

    socket.on('close', () => {
      clearInterval(heartbeat)
    })

    // 告诉 Fastify 我们接管了响应
    reply.hijack()
  })

  // GET /api/stats — 出勤率统计，需要 classOwnerRequired
  fastify.get('/api/stats', { preHandler: classOwnerRequired }, async (request, reply) => {
    const stats = await getAttendanceStats(request.classId)
    return reply.send(stats)
  })

  // GET /api/stats/export — 导出出勤统计 Excel，需要 classOwnerRequired
  fastify.get('/api/stats/export', { preHandler: classOwnerRequired }, async (request, reply) => {
    const { prisma } = await import('../plugins/db.js')
    const cls = await prisma.class.findUnique({ where: { id: request.classId } })
    const stats = await getAttendanceStats(request.classId)
    const buffer = await exportStatsToExcel(stats, cls)
    const filename = `attendance_stats_${nowTimestamp()}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  })

  // GET /api/analytics — 增强数据分析，需要 classOwnerRequired
  fastify.get('/api/analytics', { preHandler: classOwnerRequired }, async (request, reply) => {
    const data = await getAttendanceAnalytics(request.classId)
    return reply.send(data)
  })

  // DELETE /api/signin/:recordId — 撤销签到记录，需要 teacherRequired
  fastify.delete('/api/signin/:recordId', { preHandler: teacherRequired }, async (request, reply) => {
    const recordId = parseInt(request.params.recordId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await deleteSignInRecord(recordId, teacherId, isAdmin)
    if (!result.ok) {
      return reply.code(result.status || 400).send(result)
    }
    return reply.send(result)
  })

  // GET /api/seat-grid — 座位表数据，需要 classOwnerRequired
  fastify.get('/api/seat-grid', { preHandler: classOwnerRequired }, async (request, reply) => {
    const [studentGrid, teacherGrid] = await Promise.all([
      getSeatGrid(request.classId),
      getSeatGridTeacher(request.classId),
    ])
    const signedCount = teacherGrid.flat().reduce((acc, cell) => acc + cell.students.length, 0)
    return reply.send({ teacherGrid, studentGrid, signedCount })
  })

  // GET /api/seat-grid/previous — 上一批次座位表数据，需要 classOwnerRequired
  fastify.get('/api/seat-grid/previous', { preHandler: classOwnerRequired }, async (request, reply) => {
    const { prisma } = await import('../plugins/db.js')
    const { getSeatGridsFromArchivedRecords } = await import('../services/seat.js')

    // 找最近一次归档的批次
    const lastSession = await prisma.signInSession.findFirst({
      where: { classId: request.classId },
      orderBy: { archivedAt: 'desc' },
      include: { records: { orderBy: { signedAt: 'asc' } } },
    })
    if (!lastSession) {
      return reply.send({ ok: false, message: '暂无历史批次' })
    }

    const records = lastSession.records.map(r => ({
      studentName: r.studentName,
      homeClass: r.homeClass,
      computerName: r.computerName,
    }))
    const { studentGrid, teacherGrid } = getSeatGridsFromArchivedRecords(records)
    const signedCount = teacherGrid.flat().reduce((acc, cell) => acc + cell.students.length, 0)

    return reply.send({
      ok: true,
      teacherGrid,
      studentGrid,
      signedCount,
      sessionLabel: lastSession.label,
    })
  })

  // POST /api/students — 创建学生，需要 teacherRequired
  fastify.post('/api/students', { preHandler: teacherRequired }, async (request, reply) => {
    const { classId: rawClassId, name, homeClass, remark } = request.body
    const classId = parseInt(rawClassId, 10)
    if (isNaN(classId)) return reply.code(400).send({ ok: false, message: '班级ID无效' })
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await createStudent(classId, name, homeClass || '', remark || '', teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status || 400).send(result)
    return reply.code(201).send(result)
  })

  // PATCH /api/students/:studentId — 更新学生信息，需要 teacherRequired
  fastify.patch('/api/students/:studentId', { preHandler: teacherRequired }, async (request, reply) => {
    const studentId = parseInt(request.params.studentId, 10)
    if (isNaN(studentId)) return reply.code(400).send({ ok: false, message: '学生ID无效' })
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await updateStudent(studentId, request.body, teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status || 400).send(result)
    return reply.send(result)
  })

  // DELETE /api/students/:studentId — 删除学生，需要 teacherRequired
  fastify.delete('/api/students/:studentId', { preHandler: teacherRequired }, async (request, reply) => {
    const studentId = parseInt(request.params.studentId, 10)
    if (isNaN(studentId)) return reply.code(400).send({ ok: false, message: '学生ID无效' })
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await deleteStudent(studentId, teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status || 400).send(result)
    return reply.send(result)
  })

  // POST /api/students/:studentId/transfer — 转移学生，需要 teacherRequired
  fastify.post('/api/students/:studentId/transfer', { preHandler: teacherRequired }, async (request, reply) => {
    const studentId = parseInt(request.params.studentId, 10)
    if (isNaN(studentId)) return reply.code(400).send({ ok: false, message: '学生ID无效' })
    const targetClassId = parseInt(request.body.targetClassId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await transferStudent(studentId, targetClassId, teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status || 400).send(result)
    return reply.send(result)
  })

  // ========== 信息收集功能 ==========

  // GET /api/info-collection — 获取信息收集配置，需要 classOwnerRequired
  fastify.get('/api/info-collection', { preHandler: classOwnerRequired }, async (request, reply) => {
    const collection = await getInfoCollection(request.classId)
    return reply.send({
      enabled: collection?.enabled ?? false,
      fields: collection?.fields ?? [],
    })
  })

  // POST /api/info-collection — 更新信息收集开关，需要 classOwnerRequired
  fastify.post('/api/info-collection', { preHandler: classOwnerRequired }, async (request, reply) => {
    const { enabled } = request.body
    const collection = await updateInfoCollection(request.classId, Boolean(enabled))
    return reply.send({ ok: true, enabled: collection.enabled })
  })

  // POST /api/info-collection/fields — 创建字段，需要 classOwnerRequired
  fastify.post('/api/info-collection/fields', { preHandler: classOwnerRequired }, async (request, reply) => {
    const { name, type, required } = request.body
    const classId = request.classId

    const { prisma } = await import('../plugins/db.js')
    // Get or create collection
    let collection = await prisma.infoCollection.findUnique({ where: { classId } })
    if (!collection) {
      collection = await prisma.infoCollection.create({
        data: { classId, enabled: false },
      })
    }

    try {
      const field = await createInfoField(collection.id, {
        name,
        type,
        required: Boolean(required),
      })
      return reply.send({ ok: true, field })
    } catch (err) {
      return reply.code(400).send({ ok: false, message: err.message })
    }
  })

  // PATCH /api/info-collection/fields/:fieldId — 更新字段，需要 classOwnerRequired
  fastify.patch('/api/info-collection/fields/:fieldId', { preHandler: classOwnerRequired }, async (request, reply) => {
    const fieldId = parseInt(request.params.fieldId, 10)
    const { name, required } = request.body
    const classId = request.classId

    const { prisma } = await import('../plugins/db.js')
    // Verify field belongs to this class
    const field = await prisma.infoField.findUnique({
      where: { id: fieldId },
      include: { collection: true },
    })
    if (!field || field.collection.classId !== classId) {
      return reply.code(404).send({ ok: false, message: '字段不存在或不属于当前班级' })
    }

    try {
      const updated = await updateInfoField(fieldId, { name, required })
      return reply.send({ ok: true, field: updated })
    } catch (err) {
      return reply.code(400).send({ ok: false, message: err.message })
    }
  })

  // DELETE /api/info-collection/fields/:fieldId — 删除字段，需要 classOwnerRequired
  fastify.delete('/api/info-collection/fields/:fieldId', { preHandler: classOwnerRequired }, async (request, reply) => {
    const fieldId = parseInt(request.params.fieldId, 10)
    const classId = request.classId

    const { prisma } = await import('../plugins/db.js')
    // Verify field belongs to this class
    const field = await prisma.infoField.findUnique({
      where: { id: fieldId },
      include: { collection: true },
    })
    if (!field || field.collection.classId !== classId) {
      return reply.code(404).send({ ok: false, message: '字段不存在或不属于当前班级' })
    }

    await deleteInfoField(fieldId)
    return reply.send({ ok: true })
  })

  // POST /api/info-submit — 学生提交信息（无需登录），限速防刷
  fastify.post('/api/info-submit', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { classId, studentName, studentId, responses } = request.body
    try {
      const submission = await submitInfo(
        parseInt(classId, 10),
        String(studentName).trim(),
        studentId ? parseInt(studentId, 10) : null,
        responses
      )
      return reply.send({ ok: true, submission })
    } catch (err) {
      return reply.code(400).send({ ok: false, message: err.message })
    }
  })

  // GET /api/info-submissions — 获取提交列表，需要 classOwnerRequired
  fastify.get('/api/info-submissions', { preHandler: classOwnerRequired }, async (request, reply) => {
    const submissions = await getSubmissions(request.classId)
    return reply.send(submissions)
  })

  // GET /api/info-submissions/stats — 获取提交统计，需要 classOwnerRequired
  fastify.get('/api/info-submissions/stats', { preHandler: classOwnerRequired }, async (request, reply) => {
    const stats = await getSubmissionsStats(request.classId)
    return reply.send(stats)
  })

  // GET /api/info-submissions/:submissionId — 获取提交详情，需要 classOwnerRequired
  fastify.get('/api/info-submissions/:submissionId', { preHandler: classOwnerRequired }, async (request, reply) => {
    const submissionId = parseInt(request.params.submissionId, 10)
    const submission = await getSubmissionDetail(submissionId)
    if (!submission) {
      return reply.code(404).send({ ok: false, message: '提交不存在' })
    }
    return reply.send({ ok: true, submission })
  })

  // DELETE /api/info-submissions/:submissionId — 删除提交，需要 classOwnerRequired
  fastify.delete('/api/info-submissions/:submissionId', { preHandler: classOwnerRequired }, async (request, reply) => {
    const submissionId = parseInt(request.params.submissionId, 10)
    try {
      await deleteSubmission(submissionId, request.classId)
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ ok: false, message: err.message })
    }
    return reply.send({ ok: true })
  })

  // POST /api/info-upload — 上传附件，需要 classOwnerRequired（用于教师端测试）
  fastify.post('/api/info-upload', { preHandler: classOwnerRequired }, async (request, reply) => {
    try {
      let fileBuffer = null
      let filename = 'unknown'
      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          const chunks = []
          for await (const chunk of part.file) {
            chunks.push(chunk)
          }
          fileBuffer = Buffer.concat(chunks)
          filename = part.filename
        }
      }
      if (!fileBuffer) {
        return reply.code(400).send({ ok: false, message: '请上传文件' })
      }
      const result = await uploadAttachment(request.classId, fileBuffer, filename)
      return reply.send({ ok: true, url: result.url })
    } catch (err) {
      return reply.code(400).send({ ok: false, message: err.message })
    }
  })

  // GET /api/info-export — 导出信息收集数据，需要 classOwnerRequired
  fastify.get('/api/info-export', { preHandler: classOwnerRequired }, async (request, reply) => {
    const { exportInfoSubmissionsToExcel } = await import('../services/infoCollection.js')
    const buffer = await exportInfoSubmissionsToExcel(request.classId)
    const filename = `info_collection_${nowTimestamp()}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  })

  // ========== 学生标签功能 ==========

  // GET /api/preset-tags — 获取所有预设标签（公开）
  fastify.get('/api/preset-tags', async (request, reply) => {
    const tags = await getPresetTags()
    return reply.send({ tags: tags.map(t => ({ id: t.id, tag: t.tag, color: t.color })) })
  })

  // GET /api/tags — 获取班级所有学生标签（批量）
  fastify.get('/api/tags', { preHandler: classOwnerRequired }, async (request, reply) => {
    const tagMap = await getClassTags(request.classId)
    const result = {}
    for (const [sid, tags] of tagMap) {
      result[sid] = tags
    }
    return reply.send(result)
  })

  // POST /api/tags — 添加学生标签
  fastify.post('/api/tags', { preHandler: classOwnerRequired }, async (request, reply) => {
    const { classId: rawClassId, studentId, tag, color } = request.body
    const classId = parseInt(rawClassId, 10)
    const sid = parseInt(studentId, 10)
    const result = await addStudentTag(classId, sid, tag, color)
    if (!result.ok) return reply.code(400).send(result)
    return reply.send({ ok: true, tag: result.tag })
  })

  // DELETE /api/tags/:tagId — 删除学生标签
  fastify.delete('/api/tags/:tagId', { preHandler: teacherRequired }, async (request, reply) => {
    const tagId = parseInt(request.params.tagId, 10)
    const teacherId = request.session.teacherId
    const isAdmin = request.session.isAdmin === true
    const result = await deleteStudentTag(parseInt(request.query.classId, 10), tagId, teacherId, isAdmin)
    if (!result.ok) return reply.code(result.status || 400).send(result)
    return reply.send(result)
  })
}
