import { describe, before, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, uid, cleanDatabase, factories } from '../test-helpers.js'

describe('student service', () => {
  before(async () => {
    await prisma.$connect()
  })

  beforeEach(cleanDatabase)

  describe('createStudent', async () => {
    const { createStudent } = await import('./student.js')

    it('returns error for empty name', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })

      const result = await createStudent(cls.id, '', '', '', teacher.id)
      assert.equal(result.ok, false)
      assert.equal(result.message, '学生姓名不能为空')
    })

    it('returns error for duplicate name in class', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await createStudent(cls.id, '张三', '', '', teacher.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 409)
    })

    it('returns error for unauthorized teacher', async () => {
      const teacher1 = await factories.createTeacher()
      const teacher2 = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher1.id })

      const result = await createStudent(cls.id, '张三', '', '', teacher2.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 403)
    })

    it('admin can create student in any class', async () => {
      const teacher = await factories.createTeacher()
      const admin = await factories.createTeacher({ isAdmin: true })
      const cls = await factories.createClass({ teacherId: teacher.id })

      const result = await createStudent(cls.id, '张三', '高一1班', '', admin.id, true)
      assert.equal(result.ok, true)
      assert.equal(result.student.name, '张三')
      assert.equal(result.student.homeClass, '高一1班')
    })

    it('creates student successfully', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })

      const result = await createStudent(cls.id, '张三', '高一1班', '体育生', teacher.id)
      assert.equal(result.ok, true)
      assert.equal(result.student.name, '张三')
      assert.equal(result.student.homeClass, '高一1班')
      assert.equal(result.student.remark, '体育生')
    })
  })

  describe('updateStudent', async () => {
    const { updateStudent } = await import('./student.js')

    it('returns error for non-existent student', async () => {
      const teacher = await factories.createTeacher()
      const result = await updateStudent(9999, { name: '张三' }, teacher.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 404)
    })

    it('returns error for unauthorized teacher', async () => {
      const teacher1 = await factories.createTeacher()
      const teacher2 = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher1.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await updateStudent(student.id, { name: '李四' }, teacher2.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 403)
    })

    it('returns error for empty name', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await updateStudent(student.id, { name: '' }, teacher.id)
      assert.equal(result.ok, false)
      assert.equal(result.message, '学生姓名不能为空')
    })

    it('returns error for duplicate name', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls.id })
      const student2 = await factories.createStudent({ name: '李四', classId: cls.id })

      const result = await updateStudent(student2.id, { name: '张三' }, teacher.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 409)
    })

    it('updates student name successfully', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await updateStudent(student.id, { name: '张小三' }, teacher.id)
      assert.equal(result.ok, true)
      assert.equal(result.student.name, '张小三')
    })

    it('updates homeClass and remark', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await updateStudent(student.id, {
        homeClass: '高二3班',
        remark: '美术生',
      }, teacher.id)
      assert.equal(result.ok, true)
      assert.equal(result.student.homeClass, '高二3班')
      assert.equal(result.student.remark, '美术生')
    })
  })

  describe('deleteStudent', async () => {
    const { deleteStudent } = await import('./student.js')

    it('returns error for non-existent student', async () => {
      const teacher = await factories.createTeacher()
      const result = await deleteStudent(9999, teacher.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 404)
    })

    it('returns error for unauthorized teacher', async () => {
      const teacher1 = await factories.createTeacher()
      const teacher2 = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher1.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await deleteStudent(student.id, teacher2.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 403)
    })

    it('deletes student and cascades sign-in records', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })
      await factories.createSignInRecord({
        classId: cls.id,
        studentName: '张三',
        studentId: student.id,
      })

      const result = await deleteStudent(student.id, teacher.id)
      assert.equal(result.ok, true)

      // 验证学生已删除
      const deleted = await prisma.student.findUnique({ where: { id: student.id } })
      assert.equal(deleted, null)

      // 验证签到记录也被删除
      const record = await prisma.signInRecord.findFirst({
        where: { studentId: student.id },
      })
      assert.equal(record, null)
    })

    it('admin can delete any student', async () => {
      const teacher = await factories.createTeacher()
      const admin = await factories.createTeacher({ isAdmin: true })
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await deleteStudent(student.id, admin.id, true)
      assert.equal(result.ok, true)
    })
  })

  describe('transferStudent', async () => {
    const { transferStudent } = await import('./student.js')

    it('returns error for non-existent student', async () => {
      const teacher = await factories.createTeacher()
      const targetCls = await factories.createClass({ teacherId: teacher.id })

      const result = await transferStudent(9999, targetCls.id, teacher.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 404)
    })

    it('returns error if target class has duplicate name', async () => {
      const teacher = await factories.createTeacher()
      const cls1 = await factories.createClass({ teacherId: teacher.id })
      const cls2 = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls2.id })
      const student = await factories.createStudent({ name: '张三', classId: cls1.id })

      try {
        await transferStudent(student.id, cls2.id, teacher.id)
        assert.fail('should have thrown')
      } catch (err) {
        assert.equal(err.code, 'DUPLICATE')
        assert.equal(err.message, '目标班级中已存在同名学生')
      }
    })

    it('transfers student to another class', async () => {
      const teacher = await factories.createTeacher()
      const cls1 = await factories.createClass({ teacherId: teacher.id })
      const cls2 = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls1.id })

      const result = await transferStudent(student.id, cls2.id, teacher.id)
      assert.equal(result.ok, true)

      // 验证学生已转移
      const updated = await prisma.student.findUnique({ where: { id: student.id } })
      assert.equal(updated.classId, cls2.id)
    })

    it('deletes sign-in records and tags on transfer', async () => {
      const teacher = await factories.createTeacher()
      const cls1 = await factories.createClass({ teacherId: teacher.id })
      const cls2 = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls1.id })
      await factories.createSignInRecord({
        classId: cls1.id,
        studentName: '张三',
        studentId: student.id,
      })
      await factories.createStudentTag({
        classId: cls1.id,
        studentId: student.id,
        tag: '标签',
      })

      await transferStudent(student.id, cls2.id, teacher.id)

      // 验证签到记录已删除
      const recordCount = await prisma.signInRecord.count({
        where: { studentId: student.id },
      })
      assert.equal(recordCount, 0)

      // 验证标签已删除
      const tagCount = await prisma.studentTag.count({ where: { studentId: student.id } })
      assert.equal(tagCount, 0)
    })
  })
})
