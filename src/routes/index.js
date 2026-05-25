import studentRoutes from './student.js'
import teacherRoutes from './teacher.js'
import apiRoutes from './api.js'
import adminRoutes from './admin.js'
import poolRoutes from './pool.js'

export async function registerRoutes(app) {
  await app.register(studentRoutes)
  await app.register(teacherRoutes)
  await app.register(apiRoutes)
  await app.register(adminRoutes)
  await app.register(poolRoutes)
}
