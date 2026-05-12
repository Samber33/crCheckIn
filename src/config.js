import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const envFilePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env')

try {
  process.loadEnvFile?.(envFilePath)
} catch {
  // 本地未提供 .env 时回退到下面的默认值。
}

const rawSecret = process.env.SECRET_KEY
if (!rawSecret) {
  throw new Error('环境变量 SECRET_KEY 未设置，请通过 .env 或系统环境配置。')
}
export const SECRET_KEY = rawSecret
export const DATABASE_URL = process.env.DATABASE_URL ?? 'file:./attendance.db'
export const AUTO_DB_DEPLOY = process.env.AUTO_DB_DEPLOY !== 'false'
export const PORT = Number(process.env.PORT ?? 5000)
export const HOST = process.env.HOST ?? '0.0.0.0'
