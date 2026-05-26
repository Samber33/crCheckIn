import { adminRequired, teacherRequired } from '../utils/auth.js'
import { prisma } from '../plugins/db.js'
import {
  getPoolClasses,
  createPoolClass,
  claimPoolClass,
  importPoolStudentsFromExcel,
  uploadStudentPhoto,
  bulkUploadPhotos,
  deleteStudentPhoto,
  batchImportPoolStudentsFromExcel,
  batchUploadPoolPhotos,
} from '../services/pool.js'

export default async function poolRoutes(app) {
  // === 页面 ===

  app.get('/admin/pool', { preHandler: adminRequired }, async (request, reply) => {
    const classes = await getPoolClasses()
    return reply.view('admin/pool.html', { classes })
  })

  // === API: 班级池 ===

  app.post('/admin/api/pool/classes', { preHandler: adminRequired }, async (request, reply) => {
    const { name } = request.body ?? {}
    if (!name || !name.trim()) {
      return reply.send({ ok: false, message: '班级名不能为空' })
    }
    try {
      const cls = await createPoolClass(name.trim())
      return reply.send({ ok: true, class: { id: cls.id, name: cls.name } })
    } catch (err) {
      return reply.send({ ok: false, message: '创建失败' })
    }
  })

  app.delete('/admin/api/pool/classes/:id', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const cls = await prisma.class.findUnique({ where: { id: classId } })
    if (!cls || cls.teacherId !== null) {
      return reply.send({ ok: false, message: '班级不存在或不属于班级池' })
    }
    const { deleteClassesCascadeWithTx } = await import('../services/class.js')
    await prisma.$transaction(async (tx) => {
      await deleteClassesCascadeWithTx(tx, [classId])
    })
    return reply.send({ ok: true })
  })

  app.post('/admin/api/pool/classes/:id/claim', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const { teacherId } = request.body ?? {}
    if (!teacherId) {
      return reply.send({ ok: false, message: '请选择目标教师' })
    }
    const result = await claimPoolClass(classId, parseInt(teacherId, 10))
    return reply.send(result)
  })

  // === API: Excel 导入学生到班级池 ===

  app.post('/admin/api/pool/classes/:id/import', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    try {
      let fileBuffer = null
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const chunks = []
          for await (const chunk of part.file) chunks.push(chunk)
          fileBuffer = Buffer.concat(chunks)
        }
      }
      if (!fileBuffer) return reply.code(400).send({ ok: false, message: '请上传 Excel 文件' })
      const result = await importPoolStudentsFromExcel(classId, fileBuffer)
      return reply.send(result)
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '导入失败：' + err.message })
    }
  })

  // === API: 上传学生照片 ===

  app.post('/admin/api/pool/classes/:id/students/:studentId/photo', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const studentId = parseInt(request.params.studentId, 10)
    try {
      let fileBuffer = null
      let filename = 'photo.jpg'
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          fileBuffer = await part.toBuffer()
          filename = part.filename || 'photo.jpg'
        }
      }
      if (!fileBuffer) return reply.code(400).send({ ok: false, message: '请上传图片' })
      const result = await uploadStudentPhoto(classId, studentId, fileBuffer, filename)
      return reply.send(result)
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '上传失败：' + err.message })
    }
  })

  // === API: 批量上传照片 ===

  app.post('/admin/api/pool/classes/:id/photos/bulk', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    try {
      const files = []
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer()
          files.push({ filename: part.filename, buffer: buf })
        }
      }
      if (files.length === 0) return reply.code(400).send({ ok: false, message: '请上传图片' })
      const result = await bulkUploadPhotos(classId, files)
      return reply.send(result)
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '上传失败：' + err.message })
    }
  })

  // === API: 批量导入学生到班级池 ===

  app.post('/admin/api/pool/batch-import', { preHandler: adminRequired }, async (request, reply) => {
    try {
      let fileBuffer = null
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const chunks = []
          for await (const chunk of part.file) chunks.push(chunk)
          fileBuffer = Buffer.concat(chunks)
        }
      }
      if (!fileBuffer) return reply.code(400).send({ ok: false, message: '请上传 Excel 文件' })
      const result = await batchImportPoolStudentsFromExcel(fileBuffer)
      return reply.send(result)
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '导入失败：' + err.message })
    }
  })

  // === API: 批量上传照片到班级池 ===

  app.post('/admin/api/pool/batch-photos', { preHandler: adminRequired }, async (request, reply) => {
    try {
      const files = []
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer()
          files.push({ filename: part.filename, buffer: buf })
        }
      }
      if (files.length === 0) return reply.code(400).send({ ok: false, message: '请上传图片' })
      const result = await batchUploadPoolPhotos(files)
      return reply.send(result)
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '上传失败：' + err.message })
    }
  })

  // === API: 删除学生照片 ===

  app.delete('/admin/api/pool/classes/:classId/students/:studentId/photo', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.classId, 10)
    const studentId = parseInt(request.params.studentId, 10)
    const result = await deleteStudentPhoto(studentId, classId)
    return reply.send(result)
  })

  // === API: 获取班级池班级详情（含学生列表） ===

  app.get('/admin/api/pool/classes/:id', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const cls = await prisma.class.findUnique({ where: { id: classId } })
    if (!cls || cls.teacherId !== null) {
      return reply.send({ ok: false, message: '班级不存在或不属于班级池' })
    }
    const students = await prisma.student.findMany({
      where: { classId },
      orderBy: [{ homeClass: 'asc' }, { name: 'asc' }],
    })
    return reply.send({ ok: true, class: { id: cls.id, name: cls.name }, students })
  })

  // === API: 教师认领班级（教师端调用） ===

  app.post('/api/pool/classes/:id/claim', { preHandler: teacherRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const result = await claimPoolClass(classId, request.session.teacherId)
    return reply.send(result)
  })

  // === API: 获取可认领的班级池列表（教师端调用） ===

  app.get('/api/pool/classes', { preHandler: teacherRequired }, async (request, reply) => {
    const classes = await getPoolClasses()
    return reply.send({ ok: true, classes })
  })
}
