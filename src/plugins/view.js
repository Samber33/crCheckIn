import fp from 'fastify-plugin'
import view from '@fastify/view'
import nunjucks from 'nunjucks'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function viewPlugin(app) {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

  await app.register(view, {
    engine: { nunjucks },
    root: join(__dirname, '../../views'),
    options: {
      noCache: true,
      onConfigure: (env) => {
        env.addFilter('dateCN', (value) => {
          if (!value) return ''
          const date = value instanceof Date ? value : new Date(value)
          if (Number.isNaN(date.getTime())) return String(value)
          const w = weekdays[date.getDay()]
          const m = months[date.getMonth()]
          const d = date.getDate()
          const y = date.getFullYear()
          const hh = String(date.getHours()).padStart(2, '0')
          const mm = String(date.getMinutes()).padStart(2, '0')
          return `${w} ${m}${d}日 ${y}年 ${hh}:${mm}`
        })
      },
    },
  })
}

export default fp(viewPlugin)
