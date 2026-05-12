import { randomBytes } from 'node:crypto'
import bcrypt from 'bcrypt'

export async function seed(prisma) {
  // Only generate random password on first seed (no admin exists yet)
  const existing = await prisma.teacher.findUnique({ where: { username: 'admin' } })
  if (existing) return // Admin already exists, nothing to do

  const password = randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)
  const passwordHash = await bcrypt.hash(password, 10)
  await prisma.teacher.create({
    data: { username: 'admin', passwordHash, isAdmin: true },
  })
  console.log(`初始管理员已创建，密码: ${password}`)
  console.log('请立即登录并修改密码。')
}
