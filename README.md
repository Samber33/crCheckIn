# crCheckIn

一个面向机房场景的本地签到系统，支持学生签到、教师班级管理、历史批次归档、座位表查看与 Excel 导入导出。

## 功能特性

- **学生签到** — 姓名搜索 + 自动补全，签到后本地去重
- **教师口令登录** — 学生端输入口令进入教师管理端
- **班级管理** — 创建/删除教学班，Excel 批量导入学生名单
- **实时签到看板** — 已签到/未签到名单，按状态排序，一键撤销
- **历史批次归档** — 按日期 + 上下午自动打标签，支持查看、导出、删除
- **出勤统计** — 跨批次出勤率排名，支持导出
- **座位表** — 教师/学生双视角，实时刷新，支持打印
- **签到时间窗口** — 可设置签到起止时间，到点自动关闭
- **管理员面板** — 创建/删除教师账号，密码唯一性校验

## 技术栈

- Node.js + ES Modules
- Fastify — Web 框架
- Nunjucks — 模板引擎
- Prisma + SQLite — 数据层
- Tailwind CSS — 样式构建

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

复制 `.env.example` 或直接创建 `.env`：

```env
DATABASE_URL="file:./attendance.db"
PORT=8080
HOST=0.0.0.0
SECRET_KEY="please-change-this-secret-key"
AUTO_DB_DEPLOY=true
```

### 启动

```bash
# 开发模式（自动热重载）
npm run dev

# 直接启动
npm run start:direct

# PM2 后台运行
npm start
```

首次启动会自动初始化数据库和默认管理员账号。

## 项目结构

```text
crCheckIn/
├── prisma/                 # Prisma schema、seed、部署脚本
├── public/                 # 静态资源（Tailwind CSS 等）
├── src/
│   ├── routes/             # Fastify 路由定义
│   ├── services/           # 业务逻辑层（签到、归档、统计等）
│   ├── plugins/            # Fastify 插件（DB、Session、View 等）
│   ├── utils/              # 工具函数（时间格式化等）
│   └── config.js           # 环境变量读取
├── views/                  # Nunjucks 页面模板
│   ├── student/            # 学生签到页面
│   ├── teacher/            # 教师管理页面（班级、学生、座位表）
│   └── admin/              # 管理员面板
├── ecosystem.config.cjs    # PM2 配置
├── server.js               # 入口文件
├── tailwind.input.css      # Tailwind 源码
└── package.json
```

## 默认账号

首次启动自动创建：

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | `admin` | `abc123` |

部署后请尽快修改密码。

## 页面路由

| 路径 | 角色 | 说明 |
|------|------|------|
| `/student` | 学生 | 签到入口，支持教师口令登录 |
| `/teacher/classes` | 教师 | 班级列表 |
| `/teacher/classes/:id` | 教师 | 班级管理（签到看板、时间窗口、归档） |
| `/teacher/classes/:id/seats` | 教师 | 教师视角座位表 |
| `/teacher/classes/:id/students` | 教师 | 学生名单管理 |
| `/teacher/sessions/:id/seats` | 教师 | 历史批次座位表 |
| `/teacher/info?classId=:id` | 教师 | 信息收集（开发中） |
| `/admin` | 管理员 | 教师账号管理 |

## Excel 导入格式

导入名单时使用以下列：

| 列 | 内容 |
|----|------|
| A | 教学班名 |
| B | 行政班级 |
| C | 学生姓名 |

系统会自动创建不存在的教学班。

## 数据库

默认使用 SQLite，启动时自动部署。手动执行：

```bash
npm run db:deploy
```

## PM2 管理

```bash
npm run pm2:status    # 查看状态
npm run pm2:logs      # 查看日志
npm run pm2:restart   # 重启
npm run pm2:stop      # 停止
```

## 配置项

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `DATABASE_URL` | `file:./attendance.db` | SQLite 数据库地址 |
| `PORT` | `8080` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `SECRET_KEY` | 内置默认值 | Session 密钥，生产环境请修改 |
| `AUTO_DB_DEPLOY` | `true` | 启动时自动部署数据库 |

## 安全建议

- 生产环境务必修改 `SECRET_KEY`
- 首次部署后立即修改默认管理员密码
- 不建议把数据库文件直接暴露到公网可访问目录

## License

仅供学习与内部使用。
