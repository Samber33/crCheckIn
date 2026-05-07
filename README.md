# crCheckIn

一个面向机房场景的本地签到系统，支持学生签到、教师班级管理、历史批次归档、座位表查看与 Excel 导入导出。


## 项目导览

如果你是第一次接触此项目，建议先阅读：[`docs/PROJECT_OVERVIEW.zh-CN.md`](./docs/PROJECT_OVERVIEW.zh-CN.md)。

## 功能特性

- 学生端姓名搜索签到
- 教师口令登录教师端
- 管理员从教师端进入管理员面板
- 教学班管理与学生管理
- Excel 导入学生名单
- 当前签到名单查看与撤销
- 历史批次归档、查看、导出、删除
- 教师视角 / 学生视角座位表
- PM2 托管启动
- 启动时自动部署数据库

## 技术栈

- Node.js
- Fastify
- Prisma
- SQLite
- Nunjucks
- Tailwind CSS
- PM2

## 目录结构

```text
crCheckIn/
├── prisma/                 # Prisma schema、seed、部署脚本
├── public/                 # 静态资源
├── src/
│   ├── routes/             # 路由
│   ├── services/           # 业务逻辑
│   ├── plugins/            # Fastify / Prisma 插件
│   ├── utils/              # 工具函数
│   └── config.js           # 配置读取
├── views/                  # Nunjucks 页面模板
├── ecosystem.config.cjs    # PM2 配置
├── server.js               # 启动入口
└── package.json
```

## 环境要求

- Node.js 20+
- npm 10+

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 新建 `.env`

项目支持自动读取根目录 `.env`。

```env
DATABASE_URL="file:./attendance.db"
PORT=15123
HOST=0.0.0.0
SECRET_KEY="please-change-this-secret-key"
AUTO_DB_DEPLOY=true
```

### 3. 启动项目

直接启动：

```bash
npm run start:direct
```

使用 PM2 启动：

```bash
npm start
```

开发模式：

```bash
npm run dev
```

## 数据库说明

项目默认使用 SQLite，数据库地址由 `DATABASE_URL` 控制。

启动时会自动执行数据库部署，无需手动运行 Prisma 迁移命令。也可以单独执行：

```bash
npm run db:deploy
```

## 默认管理员账号

首次启动会自动创建默认管理员账号：

- 用户名：`admin`
- 密码：`abc123`

首次部署后请尽快修改密码。

## 常用命令

```bash
npm start
npm run start:direct
npm run dev
npm run db:deploy
npm run pm2:status
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```

## 使用说明

### 学生端

- 访问 `/student`
- 输入姓名片段搜索学生
- 选择对应学生后提交签到
- 也可以在学生端输入教师口令进入教师后台

### 教师端

- 输入教师口令后进入 `/teacher/classes`
- 可以创建班级、导入 Excel 名单、进入班级管理
- 在班级页可以查看当前签到、设置签到时间段、查看座位表、管理学生、归档历史批次

### 管理员端

- 管理员输入口令后同样进入教师端
- 如果账号具有管理员权限，可在教师端进入管理员面板
- 可创建教师账号、删除教师账号

## Excel 导入格式

导入名单时使用以下列格式：

- A 列：教学班名
- B 列：行政班级
- C 列：学生姓名

系统会自动创建不存在的教学班。

## PM2 部署

项目已内置 PM2 配置文件 [`ecosystem.config.cjs`](./ecosystem.config.cjs)。

启动：

```bash
npm start
```

查看状态：

```bash
npm run pm2:status
```

查看日志：

```bash
npm run pm2:logs
```

重启：

```bash
npm run pm2:restart
```

停止：

```bash
npm run pm2:stop
```

## 配置项

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | `file:./attendance.db` | SQLite 数据库地址 |
| `PORT` | `5000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `SECRET_KEY` | 内置默认值 | Session 密钥，生产环境请修改 |
| `AUTO_DB_DEPLOY` | `true` | 是否在启动时自动部署数据库 |

## 安全建议

- 生产环境务必修改 `SECRET_KEY`
- 首次部署后立即修改默认管理员密码
- 不建议把数据库文件直接暴露到公网可访问目录

## License

仅供学习与内部使用，若需公开发布建议补充正式许可证。
