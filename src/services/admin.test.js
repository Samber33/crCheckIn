import { describe, before, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, uid, cleanDatabase, factories } from '../test-helpers.js'

describe('admin service', () => {
  before(async () => {
    await prisma.$connect()
  })

  beforeEach(cleanDatabase)

  describe('createAuditLog', async () => {
    const { createAuditLog } = await import('./admin.js')

    it('creates an audit log entry', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const log = await createAuditLog({
        adminId: admin.id,
        action: 'CREATE_TEACHER',
        target: '测试教师',
        detail: '{"username": "test"}',
        ip: '127.0.0.1',
      })

      assert.equal(log.adminId, admin.id)
      assert.equal(log.action, 'CREATE_TEACHER')
      assert.equal(log.target, '测试教师')
      assert.equal(log.detail, '{"username": "test"}')
      assert.equal(log.ip, '127.0.0.1')
    })
  })

  describe('getAuditLogs', async () => {
    const { getAuditLogs, createAuditLog } = await import('./admin.js')

    it('returns logs in descending order', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      await createAuditLog({ adminId: admin.id, action: 'A', target: 'first' })
      await createAuditLog({ adminId: admin.id, action: 'B', target: 'second' })
      await createAuditLog({ adminId: admin.id, action: 'C', target: 'third' })

      const { logs, total } = await getAuditLogs()
      assert.equal(total, 3)
      assert.equal(logs.length, 3)
      // 最新的在前
      assert.equal(logs[0].action, 'C')
      assert.equal(logs[2].action, 'A')
    })

    it('supports pagination', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      for (let i = 0; i < 5; i++) {
        await createAuditLog({ adminId: admin.id, action: `action_${i}`, target: `target_${i}` })
      }

      const { logs, total } = await getAuditLogs({ limit: 2, offset: 0 })
      assert.equal(logs.length, 2)
      assert.equal(total, 5)
    })
  })

  describe('getAllClassesDetail', async () => {
    const { getAllClassesDetail } = await import('./admin.js')

    it('returns all classes with detail', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls.id })

      const classes = await getAllClassesDetail()
      const found = classes.find(c => c.id === cls.id)
      assert.ok(found)
      assert.equal(found.name, cls.name)
      assert.equal(found.studentCount, 1)
      assert.equal(found.signedCount, 0)
      assert.equal(found.totalSessions, 0)
      assert.equal(found.signInStatus, '未开启')
    })

    it('shows 签到中 status for active sign-in', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await prisma.signInConfig.upsert({
        where: { classId: cls.id },
        update: { activeStartedAt: new Date(), countdownDurationMin: 30 },
        create: { classId: cls.id, activeStartedAt: new Date(), countdownDurationMin: 30 },
      })

      const classes = await getAllClassesDetail()
      const found = classes.find(c => c.id === cls.id)
      assert.equal(found.signInStatus, '签到中')
      assert.equal(found.isSigning, true)
    })

    it('identifies pool classes', async () => {
      const cls = await factories.createClass({ teacherId: null })

      const classes = await getAllClassesDetail({ includePool: true })
      const found = classes.find(c => c.id === cls.id)
      assert.ok(found)
      assert.equal(found.isPoolClass, true)
      assert.equal(found.teacherUsername, '班级池')
    })
  })

  describe('transferClass', async () => {
    const { transferClass } = await import('./admin.js')

    it('returns error for non-existent class', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const newTeacher = await factories.createTeacher()

      const result = await transferClass(9999, newTeacher.id, admin.id)
      assert.equal(result.ok, false)
      assert.equal(result.message, '班级不存在')
    })

    it('returns error for non-existent target teacher', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const cls = await factories.createClass({ teacherId: admin.id })

      const result = await transferClass(cls.id, 9999, admin.id)
      assert.equal(result.ok, false)
      assert.equal(result.message, '目标教师不存在')
    })

    it('transfers class to another teacher', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const oldTeacher = await factories.createTeacher()
      const newTeacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: oldTeacher.id })

      const result = await transferClass(cls.id, newTeacher.id, admin.id)
      assert.equal(result.ok, true)

      // 验证班级已转移
      const updated = await prisma.class.findUnique({ where: { id: cls.id } })
      assert.equal(updated.teacherId, newTeacher.id)

      // 验证审计日志已创建
      const logs = await prisma.auditLog.findMany({ where: { adminId: admin.id } })
      assert.equal(logs.length, 1)
      assert.equal(logs[0].action, 'TRANSFER_CLASS')
    })
  })

  describe('archiveAllClasses', async () => {
    const { archiveAllClasses } = await import('./admin.js')

    it('returns ok with 0 archived when no records exist', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const result = await archiveAllClasses(admin.id)
      assert.equal(result.ok, true)
      assert.equal(result.archived, 0)
    })

    it('archives all sign-in records across classes', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const teacher1 = await factories.createTeacher()
      const teacher2 = await factories.createTeacher()

      const cls1 = await factories.createClass({ teacherId: teacher1.id })
      const cls2 = await factories.createClass({ teacherId: teacher2.id })

      await factories.createSignInRecord({ classId: cls1.id, studentName: '张三' })
      await factories.createSignInRecord({ classId: cls2.id, studentName: '李四' })

      const result = await archiveAllClasses(admin.id)
      assert.equal(result.ok, true)
      assert.equal(result.archived, 2)

      // 验证签到记录已清空
      assert.equal(await prisma.signInRecord.count(), 0)

      // 验证已归档
      assert.equal(await prisma.signInSession.count(), 2)
    })
  })

  describe('editClass', async () => {
    const { editClass } = await import('./admin.js')

    it('edits class name', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })

      const result = await editClass(cls.id, teacher.id, '新班级名', admin.id)
      assert.equal(result.ok, true)
      assert.equal(result.message, '班级已更新')

      const updated = await prisma.class.findUnique({ where: { id: cls.id } })
      assert.equal(updated.name, '新班级名')
    })

    it('creates audit log', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })

      await editClass(cls.id, teacher.id, '新名称', admin.id)

      const logs = await prisma.auditLog.findMany({ where: { adminId: admin.id } })
      assert.equal(logs.length, 1)
      assert.equal(logs[0].action, 'EDIT_CLASS')
    })
  })

  describe('deleteClassByAdmin', async () => {
    const { deleteClassByAdmin } = await import('./admin.js')

    it('returns error for non-existent class', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const result = await deleteClassByAdmin(9999, admin.id)
      assert.equal(result.ok, false)
      assert.equal(result.message, '班级不存在')
    })

    it('deletes class with cascade', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await deleteClassByAdmin(cls.id, admin.id)
      assert.equal(result.ok, true)

      assert.equal(await prisma.class.count({ where: { id: cls.id } }), 0)
    })
  })

  describe('copyClassToPool', async () => {
    const { copyClassToPool } = await import('./admin.js')

    it('returns error for non-existent class', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const result = await copyClassToPool(9999, admin.id)
      assert.equal(result.ok, false)
      assert.equal(result.message, '班级不存在')
    })

    it('copies class and students to pool', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls.id, homeClass: '高一1班' })
      await factories.createStudent({ name: '李四', classId: cls.id, homeClass: '高一2班' })

      const result = await copyClassToPool(cls.id, admin.id)
      assert.equal(result.ok, true)
      assert.ok(result.message.includes('2 名学生'))

      // 验证原班级不受影响
      assert.equal(await prisma.class.count({ where: { id: cls.id } }), 1)

      // 验证池中新班级已创建
      const poolClass = await prisma.class.findFirst({
        where: { name: cls.name, teacherId: null },
      })
      assert.ok(poolClass)

      // 验证学生已复制
      const studentCount = await prisma.student.count({ where: { classId: poolClass.id } })
      assert.equal(studentCount, 2)

      // 验证审计日志
      const logs = await prisma.auditLog.findMany({ where: { adminId: admin.id } })
      assert.equal(logs.length, 1)
      assert.equal(logs[0].action, 'COPY_TO_POOL')
    })
  })

  describe('getCrossClassAnalytics', async () => {
    const { getCrossClassAnalytics } = await import('./admin.js')

    it('returns aggregated statistics', async () => {
      const admin = await factories.createTeacher({ isAdmin: true })
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls.id })

      const stats = await getCrossClassAnalytics()

      assert.equal(stats.summary.teacherCount, 2) // admin + teacher
      assert.equal(stats.summary.classCount, 1)
    })
  })

  describe('getTeacherLoginStats', async () => {
    const { getTeacherLoginStats } = await import('./admin.js')

    it('returns all teachers with class counts', async () => {
      const teacher = await factories.createTeacher()
      await factories.createClass({ teacherId: teacher.id })
      await factories.createClass({ teacherId: teacher.id })

      const stats = await getTeacherLoginStats()
      const found = stats.find(t => t.id === teacher.id)
      assert.ok(found)
      assert.equal(found.classCount, 2)
    })
  })
})
