import { resolveClientName } from '../utils/ip.js'
import { prisma } from '../plugins/db.js'

export default async function studentRoutes(app) {
  app.get('/', async (request, reply) => {
    return reply.redirect('/student')
  })

  app.get('/student', async (request, reply) => {
    const classId = request.query.classId ? parseInt(request.query.classId, 10) : null
    let cls = null
    let studentCount = 0
    if (classId) {
      cls = await prisma.class.findUnique({ where: { id: classId }, select: { id: true, name: true } })
      studentCount = await prisma.student.count({ where: { classId } })
    }
    return reply.view('student/index.html', {
      computer_name: resolveClientName(request),
      cls,
      studentCount,
    })
  })
}
