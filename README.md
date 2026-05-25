# Lab Attendance

> 面向机房 / 实验室场景的本地签到系统 — 学生扫码签到、教师实时看板、历史批次归档与数据分析。

[![Release](https://img.shields.io/github/v/release/JehuYu/crCheckIn?label=release&color=cc785c)](https://github.com/JehuYu/crCheckIn/releases)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)

## 预览

| 学生签到 | 教师看板 | 座位表 |
|---------|---------|--------|
| 学生端搜索签到 | 实时签到名单 | 可拖拽座位 |
| 拼音首字母搜索 | 一键撤销 | 历史对比 |

## 功能特性

### 签到核心
- **智能搜索** — 支持中文姓名、拼音首字母、全拼搜索（输入 `csy` 匹配 "陈思源"）
- **签到倒计时** — 30 分钟倒计时模式，到点自动归档
- **IP 限制** — 同一 IP 每节课程只能签到一次，归档后自动释放
- **自动去重** — 学生签到后本地去重，防止重复签到
- **回车快捷操作** — 匹配单条自动签到，已选学生回车直接签到

### 班级管理
- **教学班 / 行政班** — 支持多教学班与行政班级映射
- **Excel 批量导入** — 一键导入学生名单，自动创建不存在的班级
- **班级归档** — 按日期 + 上下午自动打标签归档
- **历史批次** — 分页浏览历史签到批次，支持查看、导出、删除

### 座位表
- **实时座位可视化** — 教师视角拖拽排座，学生视角查看自己的座位
- **历史对比** — 上节课座位对比，黄色标记变动、蓝色标记新增
- **签到高亮** — 新签到实时高亮显示

### 标签系统
- **预设标签** — 管理员统一管理预设标签（如 "缺勤"、"迟到"），级联更新学生标签
- **自定义标签** — 教师可自定义标签颜色，支持 SSE 实时推送
- **签到自动清除** — 签到成功后自动清除自定义标签，保留预设标签

### 数据分析
- **出勤统计** — 跨批次出勤率排名，支持 Excel 导出
- **数据看板** — 可视化出勤率图表，识别高频缺勤学生
- **跨班级分析** — 管理员可查看全局出勤数据

### 信息收集
- **自定义字段** — 支持文本和附件类型字段
- **学生提交** — 学生端在线填写，教师端查看提交记录
- **数据导出** — 一键导出收集到的信息

### 安全与管理
- **双角色体系** — 管理员（全局管理）+ 教师（班级管理）
- **数据备份 / 恢复** — SQLite 数据库导出与恢复
- **审计日志** — 管理员操作全程记录
- **多端防护** — CSRF、XSS、Excel 注入防护，时序攻击防护，速率限制

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Node.js 18+ / ES Modules |
| Web 框架 | [Fastify](https://fastify.dev/) v4 |
| 数据库 | [Prisma](https://www.prisma.io/) v5 + SQLite |
| 模板引擎 | [Nunjucks](https://mozilla.github.io/nunjucks/) |
| 样式 | [Tailwind CSS](https://tailwindcss.com/) v3 |
| 进程管理 | [PM2](https://pm2.keymetrics.io/) |
| Excel 处理 | [ExcelJS](https://github.com/exceljs/exceljs) |
| 拼音支持 | [pinyin-pro](https://github.com/niuhuan/pinyin-pro) |

## 快速开始

### 前置要求

- Node.js >= 18
- npm >= 9

### 安装

```bash
git clone https://github.com/JehuYu/crCheckIn.git
cd crCheckIn
npm install
```

### 配置

```bash
# 创建 .env 文件
cat > .env << 'EOF'
DATABASE_URL="file:./attendance.db"
PORT=8080
HOST=0.0.0.0
SECRET_KEY="please-change-this-secret-key"
AUTO_DB_DEPLOY=true
EOF
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | `file:./attendance.db` | SQLite 数据库路径 |
| `PORT` | `8080` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `SECRET_KEY` | 内置默认 | Session 密钥，生产环境务必修改 |
| `AUTO_DB_DEPLOY` | `true` | 启动时自动初始化数据库 |

### 运行

```bash
# 开发模式（文件热重载）
npm run dev

# 直接启动
npm run start:direct

# PM2 后台运行（推荐生产环境）
npm start
```

首次启动会自动初始化数据库并创建默认管理员账号。

### 默认账号

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | `admin` | `abc123` |

> **重要：** 部署后请立即修改默认密码。

## 路由一览

| 路径 | 角色 | 说明 |
|------|------|------|
| `/student` | 学生 | 签到入口（支持教师口令登录） |
| `/teacher/classes` | 教师 | 班级列表 |
| `/teacher/classes/:id` | 教师 | 班级签到看板 |
| `/teacher/classes/:id/seats` | 教师 | 座位表管理 |
| `/teacher/classes/:id/students` | 教师 | 学生名单管理 |
| `/teacher/classes/:id/info` | 教师 | 信息收集 |
| `/teacher/classes/:id/analytics` | 教师 | 出勤统计 |
| `/teacher/sessions/:id/seats` | 教师 | 历史批次座位表 |
| `/admin` | 管理员 | 教师账号管理 |
| `/admin/dashboard` | 管理员 | 全局数据看板 |
| `/admin/analytics` | 管理员 | 跨班级分析 |
| `/admin/audit` | 管理员 | 审计日志 |

## 项目结构

```
crCheckIn/
├── prisma/
│   ├── schema.prisma          # 数据库模型定义
│   ├── deploy.js              # 数据库部署脚本
│   └── seed.js                # 初始数据填充
├── public/
│   ├── tailwind.min.css       # 编译后的样式
│   ├── admin.css              # 管理端公共样式
│   └── design-system.css      # 设计系统样式
├── src/
│   ├── app.js                 # Fastify 应用构建
│   ├── config.js              # 环境变量加载
│   ├── routes/                # 路由层
│   │   ├── index.js           # 路由注册入口
│   │   ├── api.js             # API 接口
│   │   ├── admin.js           # 管理员页面
│   │   ├── teacher.js         # 教师页面
│   │   └── student.js         # 学生页面
│   ├── services/              # 业务逻辑层
│   │   ├── auth.js            # 认证逻辑
│   │   ├── class.js           # 班级管理
│   │   ├── student.js         # 学生管理
│   │   ├── attendance.js      # 签到逻辑
│   │   ├── roster.js          # 名单管理
│   │   ├── seat.js            # 座位表
│   │   ├── sse.js             # 实时推送
│   │   ├── tag.js             # 标签管理
│   │   ├── infoCollection.js  # 信息收集
│   │   └── admin.js           # 管理员操作
│   ├── plugins/               # Fastify 插件
│   │   ├── db.js              # Prisma 数据库连接
│   │   ├── session.js         # Session 管理
│   │   └── view.js            # Nunjucks 模板引擎
│   └── utils/                 # 工具函数
│       ├── auth.js            # 认证中间件
│       ├── time.js            # 时间格式化
│       ├── pinyin.js          # 拼音工具
│       └── ip.js              # IP 处理
├── views/                     # Nunjucks 页面模板
│   ├── student/               # 学生端
│   ├── teacher/               # 教师端
│   └── admin/                 # 管理端
├── uploads/                   # 文件上传目录
├── ecosystem.config.cjs       # PM2 配置
├── server.js                  # 入口文件
└── tailwind.input.css         # Tailwind 源码
```

## 数据库模型

```
Teacher ──┬── Class ──┬── Student ── StudentTag
          │           ├── SignInConfig
          │           ├── SignInRecord
          │           ├── SignInSession ── ArchivedRecord
          │           └── InfoCollection ── InfoField ── InfoResponse
          └── AuditLog

PresetTag (全局预设标签)
```

## Excel 导入格式

导入学生名单时，Excel 文件需包含以下列：

| 列 | 内容 | 示例 |
|----|------|------|
| A | 教学班名 | 计算机科学1班 |
| B | 行政班级 | 计算机学院2024级1班 |
| C | 学生姓名 | 张三 |

系统会自动创建不存在的教学班。

## PM2 管理

```bash
npm run pm2:status    # 查看进程状态
npm run pm2:logs      # 查看实时日志
npm run pm2:restart   # 重启服务
npm run pm2:stop      # 停止服务
```

## 生产部署

### 推荐配置

```bash
# 1. 设置生产密钥
export SECRET_KEY=$(openssl rand -hex 32)

# 2. 设置生产端口
export PORT=3000

# 3. 后台启动
npm start

# 4. 使用 nginx 反向代理（可选）
# server {
#   listen 80;
#   server_name your-domain.com;
#   location / {
#     proxy_pass http://127.0.0.1:3000;
#     proxy_set_header Host $host;
#     proxy_set_header X-Real-IP $remote_addr;
#   }
# }
```

### 数据库备份

在管理端使用"数据备份"功能导出 SQLite 数据库，或直接复制 `attendance.db` 文件。

## 更新日志

详见 [CHANGELOG.zh.md](CHANGELOG.zh.md)（中文）或 [CHANGELOG.md](CHANGELOG.md)（English）。

## License

MIT
