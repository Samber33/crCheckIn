import { describe, before, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, uid, cleanDatabase, factories } from '../test-helpers.js'

describe('tag service', () => {
  before(async () => {
    await prisma.$connect()
  })

  beforeEach(async () => {
    await cleanDatabase()
    // Reset preset tag cache
    const { invalidatePresetTagCache } = await import('./tag.js')
    invalidatePresetTagCache()
  })

  describe('getNextColor', async () => {
    const { getNextColor } = await import('./tag.js')

    it('returns first color for index 0', () => {
      assert.equal(getNextColor(0), '#cc785c')
    })

    it('cycles through colors', () => {
      assert.equal(getNextColor(6), '#cc785c') // wraps around (6 % 6 = 0)
      assert.equal(getNextColor(1), '#5db872')
    })
  })

  describe('preset tag operations', async () => {
    const { addPresetTag, updatePresetTag, deletePresetTag, getPresetTagNames } = await import('./tag.js')

    it('adds a preset tag', async () => {
      const result = await addPresetTag('优秀', '#5db872')
      assert.equal(result.ok, true)

      const tags = await prisma.presetTag.findMany()
      assert.ok(tags.find(t => t.tag === '优秀'))
    })

    it('rejects duplicate tag name', async () => {
      await addPresetTag('优秀', '#5db872')
      const result = await addPresetTag('优秀', '#4a90d9')
      assert.equal(result.ok, false)
      assert.equal(result.message, '预设标签已存在')
    })

    it('updates a preset tag', async () => {
      await addPresetTag('旧标签', '#cc785c')
      const tag = await prisma.presetTag.findFirst({ where: { tag: '旧标签' } })

      const result = await updatePresetTag(tag.id, { tag: '新标签' })
      assert.equal(result.ok, true)

      const updated = await prisma.presetTag.findFirst({ where: { tag: '新标签' } })
      assert.ok(updated)
    })

    it('deletes a preset tag and removes from all students', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      await addPresetTag('测试标签')
      await prisma.studentTag.create({
        data: { classId: cls.id, studentId: student.id, tag: '测试标签' },
      })

      const tag = await prisma.presetTag.findFirst({ where: { tag: '测试标签' } })
      const result = await deletePresetTag(tag.id)
      assert.equal(result.ok, true)

      // 预设标签已删除
      assert.equal(await prisma.presetTag.count({ where: { tag: '测试标签' } }), 0)
      // 学生标签也已清除
      assert.equal(await prisma.studentTag.count({ where: { tag: '测试标签' } }), 0)
    })
  })

  describe('student tag operations', async () => {
    const { addStudentTag, deleteStudentTag, getClassTags } = await import('./tag.js')

    it('adds a tag to a student', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      const result = await addStudentTag(cls.id, student.id, '标签1', '#5db872')
      assert.equal(result.ok, true)
      assert.equal(result.tag.tag, '标签1')
    })

    it('rejects duplicate tag for same student', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      await addStudentTag(cls.id, student.id, '标签1')
      const result = await addStudentTag(cls.id, student.id, '标签1')
      assert.equal(result.ok, false)
      assert.equal(result.message, '标签已存在。')
    })

    it('getClassTags returns tags grouped by student', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      const student1 = await factories.createStudent({ name: '张三', classId: cls.id })
      const student2 = await factories.createStudent({ name: '李四', classId: cls.id })

      await addStudentTag(cls.id, student1.id, '标签1')
      await addStudentTag(cls.id, student2.id, '标签2')

      const tagMap = await getClassTags(cls.id)
      assert.ok(tagMap.has(student1.id))
      assert.ok(tagMap.has(student2.id))
      assert.equal(tagMap.get(student1.id).length, 1)
      assert.equal(tagMap.get(student1.id)[0].tag, '标签1')
    })

    it('deleteStudentTag returns error for unauthorized teacher', async () => {
      const teacher1 = await factories.createTeacher()
      const teacher2 = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher1.id })
      const student = await factories.createStudent({ name: '张三', classId: cls.id })

      await addStudentTag(cls.id, student.id, '标签1')
      const tag = await prisma.studentTag.findFirst({ where: { studentId: student.id } })

      const result = await deleteStudentTag(cls.id, tag.id, teacher2.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 403)
    })
  })

  describe('getPresetTagNames caching', async () => {
    const { getPresetTagNames, invalidatePresetTagCache, addPresetTag } = await import('./tag.js')

    it('caches preset tag names', async () => {
      await addPresetTag('缓存测试')
      const names1 = await getPresetTagNames()
      assert.ok(names1.includes('缓存测试'))

      // Second call should return cached result
      const names2 = await getPresetTagNames()
      assert.strictEqual(names1, names2) // same array reference
    })

    it('cache is invalidated after add', async () => {
      await addPresetTag('标签A')
      const names1 = await getPresetTagNames()

      await addPresetTag('标签B')
      const names2 = await getPresetTagNames()

      assert.notStrictEqual(names1, names2) // new array after cache invalidation
      assert.ok(names2.includes('标签A'))
      assert.ok(names2.includes('标签B'))
    })
  })
})
