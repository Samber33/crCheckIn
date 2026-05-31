import { adminRequired, teacherRequired } from '../utils/auth.js'
import { prisma } from '../plugins/db.js'
import {
  getPoolClasses,
  getPoolSemesters,
  archivePoolSemester,
  unarchivePoolSemester,
  getRecycleBinClasses,
  softDeletePoolClass,
  restorePoolClass,
  hardDeletePoolClass,
  createPoolClass,
  claimPoolClass,
  importPoolStudentsFromExcel,
  uploadStudentPhoto,
  bulkUploadPhotos,
  deleteStudentPhoto,
  batchImportPoolStudentsFromExcel,
  batchUploadPoolPhotos,
  getStudentsWithoutPhotos,
  resolvePhotoConflict,
  uploadZipForMatching,
  getZipMatchProgress,
  startZipMatching,
  cancelZipMatch,
} from '../services/pool.js'

export default async function poolRoutes(app) {
  // === 页面 ===

  app.get('/admin/pool', { preHandler: adminRequired }, async (request, reply) => {
    const semester = request.query.semester
    const view = request.query.view
    const isRecycleView = view === 'recycle'
    const classes = isRecycleView ? [] : await getPoolClasses(semester !== undefined ? { semester } : {})
    const semesters = await getPoolSemesters()
    const recycleBin = await getRecycleBinClasses()
    return reply.view('admin/pool.html', { classes, semesters, currentSemester: semester || '', recycleBin, isRecycleView })
  })

  // === API: 班级池 ===

  app.post('/admin/api/pool/classes', { preHandler: adminRequired }, async (request, reply) => {
    const { name } = request.body ?? {}
    if (!name || !name.trim()) {
      return reply.code(400).send({ ok: false, message: '班级名不能为空' })
    }
    try {
      const cls = await createPoolClass(name.trim())
      return reply.send({ ok: true, class: { id: cls.id, name: cls.name } })
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '创建失败' })
    }
  })

  // === API: 学期归档 ===

  app.get('/admin/api/pool/semesters', { preHandler: adminRequired }, async (request, reply) => {
    const semesters = await getPoolSemesters()
    return reply.send({ ok: true, semesters })
  })

  app.post('/admin/api/pool/archive-semester', { preHandler: adminRequired }, async (request, reply) => {
    const { semester } = request.body ?? {}
    const result = await archivePoolSemester(semester)
    return reply.send(result)
  })

  app.post('/admin/api/pool/unarchive-semester', { preHandler: adminRequired }, async (request, reply) => {
    const { semester } = request.body ?? {}
    const result = await unarchivePoolSemester(semester)
    return reply.send(result)
  })

  app.delete('/admin/api/pool/classes/:id', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const result = await softDeletePoolClass(classId)
    return reply.send(result)
  })

  app.post('/admin/api/pool/classes/:id/restore', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const result = await restorePoolClass(classId)
    return reply.send(result)
  })

  app.delete('/admin/api/pool/classes/:id/hard-delete', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const result = await hardDeletePoolClass(classId)
    return reply.send(result)
  })

  app.post('/admin/api/pool/classes/:id/claim', { preHandler: adminRequired }, async (request, reply) => {
    const classId = parseInt(request.params.id, 10)
    const { teacherId } = request.body ?? {}
    if (!teacherId) {
      return reply.code(400).send({ ok: false, message: '请选择目标教师' })
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

  app.post('/admin/api/pool/classes/:id/photos/bulk', {
    preHandler: adminRequired,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
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

  app.post('/admin/api/pool/batch-photos', {
    preHandler: adminRequired,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, // 限制批量上传频率
  }, async (request, reply) => {
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

  // === API: 解决照片冲突（同名学生手动匹配）===

  app.post('/admin/api/pool/photos/resolve', {
    preHandler: adminRequired,
  }, async (request, reply) => {
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

      const { studentId, classId } = request.body ?? {}
      if (!studentId || !classId) {
        return reply.code(400).send({ ok: false, message: '请指定学生和班级' })
      }

      const result = await resolvePhotoConflict({
        studentId: parseInt(studentId, 10),
        classId: parseInt(classId, 10),
        buffer: fileBuffer,
        filename,
      })
      return reply.send(result)
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '匹配失败：' + err.message })
    }
  })

  // === API: 获取班级池中没有照片的学生 ===

  app.get('/admin/api/pool/students-without-photos', { preHandler: adminRequired }, async (request, reply) => {
    const students = await getStudentsWithoutPhotos()
    return reply.send({ ok: true, students })
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
      return reply.code(404).send({ ok: false, message: '班级不存在或不属于班级池' })
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
    const classes = await getPoolClasses({ teacherId: request.session.teacherId })
    return reply.send({ ok: true, classes })
  })

  // === API: ZIP 照片匹配 ===

  // 上传 ZIP 并解压
  app.post('/admin/api/pool/zip-upload', {
    preHandler: adminRequired,
  }, async (request, reply) => {
    try {
      let fileBuffer = null
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer()
          fileBuffer = buf
        }
      }
      if (!fileBuffer) return reply.code(400).send({ ok: false, message: '请上传 ZIP 文件' })
      const result = await uploadZipForMatching(fileBuffer)
      return reply.send(result)
    } catch (err) {
      return reply.code(500).send({ ok: false, message: '上传失败：' + err.message })
    }
  })

  // 获取匹配进度
  app.get('/admin/api/pool/zip-progress/:jobId', { preHandler: adminRequired }, async (request, reply) => {
    const jobId = request.params.jobId
    const progress = getZipMatchProgress(jobId)
    if (!progress) return reply.code(404).send({ ok: false, message: '任务不存在' })
    return reply.send(progress)
  })

  // 启动匹配
  app.post('/admin/api/pool/zip-match/:jobId', { preHandler: adminRequired }, async (request, reply) => {
    const jobId = request.params.jobId
    const result = await startZipMatching(jobId)
    return reply.send(result)
  })

  // 取消匹配任务
  app.delete('/admin/api/pool/zip-match/:jobId', { preHandler: adminRequired }, async (request, reply) => {
    const jobId = request.params.jobId
    const result = await cancelZipMatch(jobId)
    return reply.send(result)
  })
}
