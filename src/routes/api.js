import { teacherRequired, classOwnerRequired } from '../utils/auth.js'
import { parseDt, nowParts } from '../utils/time.js'
import { resolveClientName } from '../utils/ip.js'
import {
  signIn,
  getClassStatus,
  archiveAndReset,
  clearRoster,
  setSignInWindow,
  getSessions,
  getSessionDetailForTeacher,
  deleteSession,
  getAttendanceStats,
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
import { createClass, deleteClass } from '../services/class.js'
import { changePassword, verifyTeacherByPassword } from '../services/auth.js'
import { getSeatGrid, getSeatGridTeacher } from '../services/seat.js'
import { updateStudent, deleteStudent, transferStudent } from '../services/student.js'

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
    const classId = parseInt(request.query.classId, 10)
    const payload = await getClassStatus(classId)
    return reply.send(payload)
  })

  // POST /api/reset — 归档当前记录并重置，需要 classOwnerRequired
  fastify.post('/api/reset', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.body.classId, 10)
    const result = await archiveAndReset(classId)
    const msg = result.label
      ? `已归档批次「${result.label}」，签到已重置。`
      : '签到记录已重置。'
    return reply.send({ ok: true, message: msg })
  })

  // GET /api/sessions — 获取历史批次列表，需要 classOwnerRequired
  fastify.get('/api/sessions', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.query.classId, 10)
    const sessions = await getSessions(classId)
    return reply.send(sessions.map(s => ({
      id: s.id,
      label: s.label,
      archivedAt: s.archivedAt,
      count: s._count.records,
    })))
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
    const classId = parseInt(request.body.classId, 10)
    await clearRoster(classId)
    return reply.send({ ok: true, message: '当前名单与签到记录已清空。' })
  })

  // POST /api/window — 需要 classOwnerRequired
  fastify.post('/api/window', { preHandler: classOwnerRequired }, async (request, reply) => {
    const { classId: rawClassId, start_time, end_time } = request.body
    const classId = parseInt(rawClassId, 10)
    await setSignInWindow(classId, parseDt(start_time), parseDt(end_time))
    return reply.send({ ok: true, message: '签到时间段已更新。' })
  })

  // GET /api/export — 需要 classOwnerRequired
  fastify.get('/api/export', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.query.classId, 10)
    const buffer = await exportRecordsToExcel(classId)
    const filename = `signin_records_${nowTimestamp()}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  })

  // GET /api/export-seats — 需要 classOwnerRequired
  fastify.get('/api/export-seats', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.query.classId, 10)
    const buffer = await exportSeatTableToExcel(classId)
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
  fastify.post('/api/teacher-login', async (request, reply) => {
    const { password } = request.body ?? {}
    const result = await verifyTeacherByPassword(password)
    if (!result.ok) return reply.send({ ok: false })

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

  // GET /api/students/match — 无需登录
  fastify.get('/api/students/match', async (request, reply) => {
    const q = request.query.q || ''
    const classId = request.query.classId ? parseInt(request.query.classId, 10) : null
    const students = await matchStudents(q, 15, classId)
    return reply.send(students)
  })

  // POST /api/signin — 无需登录
  fastify.post('/api/signin', async (request, reply) => {
    const { classId: rawClassId, student_name } = request.body
    const classId = parseInt(rawClassId, 10)
    const computerName = resolveClientName(request)
    const result = await signIn(classId, student_name, computerName)
    if (!result.ok) {
      return reply.code(400).send(result)
    }
    return reply.send(result)
  })

  // GET /api/stats — 出勤率统计，需要 classOwnerRequired
  fastify.get('/api/stats', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.query.classId, 10)
    const stats = await getAttendanceStats(classId)
    return reply.send(stats)
  })

  // GET /api/stats/export — 导出出勤统计 Excel，需要 classOwnerRequired
  fastify.get('/api/stats/export', { preHandler: classOwnerRequired }, async (request, reply) => {
    const classId = parseInt(request.query.classId, 10)
    const { prisma } = await import('../plugins/db.js')
    const cls = await prisma.class.findUnique({ where: { id: classId } })
    const stats = await getAttendanceStats(classId)
    const buffer = await exportStatsToExcel(stats, cls)
    const filename = `attendance_stats_${nowTimestamp()}.xlsx`
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
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
    const classId = parseInt(request.query.classId, 10)
    const [studentGrid, teacherGrid] = await Promise.all([
      getSeatGrid(classId),
      getSeatGridTeacher(classId),
    ])
    const signedCount = teacherGrid.flat().reduce((acc, cell) => acc + cell.students.length, 0)
    return reply.send({ teacherGrid, studentGrid, signedCount })
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
}
