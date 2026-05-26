import { describe, before, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, uid, cleanDatabase, factories } from '../test-helpers.js'

describe('class service', () => {
  before(async () => {
    await prisma.$connect()
  })

  beforeEach(cleanDatabase)

  describe('getClasses', async () => {
    const { getClasses } = await import('./class.js')

    it('returns empty array for teacher with no classes', async () => {
      const teacher = await factories.createTeacher()
      const classes = await getClasses(teacher.id)
      assert.deepEqual(classes, [])
    })

    it('returns classes with student counts', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls.id })
      await factories.createStudent({ name: '李四', classId: cls.id })

      const classes = await getClasses(teacher.id)
      assert.equal(classes.length, 1)
      assert.equal(classes[0].name, cls.name)
      assert.equal(classes[0].studentCount, 2)
      assert.equal(classes[0].signedCount, 0)
    })

    it('marks class as signing when sign-in is active', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      // factory creates class with signInConfig via Prisma schema cascade
      await prisma.signInConfig.upsert({
        where: { classId: cls.id },
        update: { activeStartedAt: new Date(), countdownDurationMin: 30 },
        create: { classId: cls.id, activeStartedAt: new Date(), countdownDurationMin: 30 },
      })

      const classes = await getClasses(teacher.id)
      assert.equal(classes[0].isSigning, true)
    })

    it('excludes archived classes by default', async () => {
      const teacher = await factories.createTeacher()
      await factories.createClass({ teacherId: teacher.id, isArchived: false })
      await factories.createClass({ teacherId: teacher.id, isArchived: true })

      const classes = await getClasses(teacher.id)
      assert.equal(classes.length, 1)
      assert.equal(classes[0].isArchived, false)
    })

    it('includes archived classes when option is set', async () => {
      const teacher = await factories.createTeacher()
      await factories.createClass({ teacherId: teacher.id, isArchived: false })
      await factories.createClass({ teacherId: teacher.id, isArchived: true })

      const classes = await getClasses(teacher.id, { includeArchived: true })
      assert.equal(classes.length, 2)
    })
  })

  describe('createClass', async () => {
    const { createClass } = await import('./class.js')

    it('creates class with SignInConfig', async () => {
      const teacher = await factories.createTeacher()
      const cls = await createClass(teacher.id, '测试班级')

      assert.equal(cls.name, '测试班级')
      assert.equal(cls.teacherId, teacher.id)
      assert.ok(cls.signInConfig)
    })
  })

  describe('assertClassOwner', async () => {
    const { assertClassOwner } = await import('./class.js')

    it('throws error for non-existent class', async () => {
      try {
        await assertClassOwner(9999, 1)
        assert.fail('should have thrown')
      } catch (err) {
        assert.equal(err.message, '班级不存在')
        assert.equal(err.statusCode, 404)
      }
    })

    it('throws error for unauthorized teacher', async () => {
      const teacher1 = await factories.createTeacher()
      const teacher2 = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher1.id })

      try {
        await assertClassOwner(cls.id, teacher2.id)
        assert.fail('should have thrown')
      } catch (err) {
        assert.equal(err.message, '无权访问该班级')
        assert.equal(err.statusCode, 403)
      }
    })

    it('admin can access any class', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })

      const result = await assertClassOwner(cls.id, 999, true)
      assert.ok(result)
      assert.equal(result.id, cls.id)
    })

    it('throws error for pool class (teacherId=null) when not admin', async () => {
      const cls = await factories.createClass({ teacherId: null })

      try {
        await assertClassOwner(cls.id, 1)
        assert.fail('should have thrown')
      } catch (err) {
        assert.equal(err.message, '无权操作班级池班级')
        assert.equal(err.statusCode, 403)
      }
    })

    it('admin can access pool class', async () => {
      const cls = await factories.createClass({ teacherId: null })

      const result = await assertClassOwner(cls.id, 999, true)
      assert.ok(result)
      assert.equal(result.id, cls.id)
    })
  })

  describe('deleteClass', async () => {
    const { deleteClass } = await import('./class.js')

    it('throws error for non-existent class', async () => {
      const teacher = await factories.createTeacher()
      try {
        await deleteClass(9999, teacher.id)
        assert.fail('should have thrown')
      } catch (err) {
        assert.equal(err.message, '班级不存在')
      }
    })

    it('throws error for unauthorized teacher', async () => {
      const teacher1 = await factories.createTeacher()
      const teacher2 = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher1.id })

      try {
        await deleteClass(cls.id, teacher2.id)
        assert.fail('should have thrown')
      } catch (err) {
        assert.equal(err.message, '无权访问该班级')
      }
    })

    it('cascades delete: students, tags, records, config, sessions', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })
      await factories.createStudentTag({ classId: cls.id, studentId: student.id, tag: '标签' })
      await factories.createSignInRecord({ classId: cls.id, studentName: '张三' })
      const session = await factories.createSignInSession({ classId: cls.id })
      await factories.createArchivedRecord({ sessionId: session.id, studentName: '张三' })

      await deleteClass(cls.id, teacher.id)

      // 验证所有关联数据已删除
      assert.equal(await prisma.class.count({ where: { id: cls.id } }), 0)
      assert.equal(await prisma.student.count({ where: { classId: cls.id } }), 0)
      assert.equal(await prisma.studentTag.count({ where: { classId: cls.id } }), 0)
      assert.equal(await prisma.signInRecord.count({ where: { classId: cls.id } }), 0)
      assert.equal(await prisma.signInConfig.count({ where: { classId: cls.id } }), 0)
      assert.equal(await prisma.signInSession.count({ where: { classId: cls.id } }), 0)
      assert.equal(await prisma.archivedRecord.count({ where: { sessionId: session.id } }), 0)
    })

    it('admin can delete any class', async () => {
      const teacher = await factories.createTeacher()
      const admin = await factories.createTeacher({ isAdmin: true })
      const cls = await factories.createClass({ teacherId: teacher.id })

      await deleteClass(cls.id, admin.id, true)
      assert.equal(await prisma.class.count({ where: { id: cls.id } }), 0)
    })
  })

  describe('archiveClass and unarchiveClass', async () => {
    const { archiveClass, unarchiveClass } = await import('./class.js')

    it('archives a class', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })

      const result = await archiveClass(cls.id, teacher.id)
      assert.equal(result.ok, true)

      const updated = await prisma.class.findUnique({ where: { id: cls.id } })
      assert.equal(updated.isArchived, true)
    })

    it('unarchives a class', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id, isArchived: true })

      const result = await unarchiveClass(cls.id, teacher.id)
      assert.equal(result.ok, true)

      const updated = await prisma.class.findUnique({ where: { id: cls.id } })
      assert.equal(updated.isArchived, false)
    })

    it('throws error for unauthorized teacher', async () => {
      const teacher1 = await factories.createTeacher()
      const teacher2 = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher1.id })

      try {
        await archiveClass(cls.id, teacher2.id)
        assert.fail('should have thrown')
      } catch (err) {
        assert.equal(err.message, '无权访问该班级')
        assert.equal(err.statusCode, 403)
      }
    })
  })
})
