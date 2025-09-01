# 家庭门户（带用户管理）
一个可自部署的小网站：支持注册/登录、角色（管理员/成员）、聊天记录、每日配额、OpenAI 代理调用。

## 快速开始
1. 安装依赖
   ```bash
   npm install
   cp .env.example .env
   ```
2. 编辑 `.env`：填入 `OPENAI_API_KEY`，可调整 `ALLOW_REGISTRATION`、配额等。
3. 启动
   ```bash
   npm run dev
   # 打开 http://localhost:3000
   ```

### 首个用户自动成为管理员
## 邀请制（推荐）
- 将 `.env` 中 `INVITE_REQUIRED=true`（默认已开启），并建议把 `ALLOW_REGISTRATION=false`。
- 管理员在「管理员面板」生成**邀请码**（可设置有效期与可用次数）。
- 家庭成员注册时必须填写邀请码；用尽或过期的码无法注册。
- 管理员可随时**吊销**邀请码。


- 当数据库为空时，注册的第一个用户会被设为 `admin`。之后的用户为 `member`。

### 主要功能
- 账号体系：注册/登录/退出，HTTP-only Cookie（JWT）
- 角色管理：管理员可查看/修改成员角色、重置密码、禁用账号
- 聊天：代理调用 OpenAI（默认 gpt-4o-mini），保存聊天记录
- 配额：按用户统计每日请求数和大致 tokens（基于 OpenAI usage 返回）
- 管理后台：`/admin.html`
- 前端：无框架版（纯 HTML + fetch）

### 部署到 Vercel（示例）
- 新建项目 -> 关联仓库
- 在 Vercel 的「环境变量」里设置：
  - `OPENAI_API_KEY`
  - `JWT_SECRET`
  - `SECURE_COOKIES`（生产建议 `true`）
  - `ALLOW_REGISTRATION`
  - `OPENAI_MODEL`（可选）
  - `SYSTEM_PROMPT`（可选）
- 构建命令：无（Node 项目）
- 输出目录：`public` 会作为静态文件，后端由 `server.js` 提供 API

### 数据库存储
- 使用 `SQLite`（文件：`data.db`）。
- 若要切换到 Postgres，可修改 `db.js` 与查询语句。

### 安全提示
- 密钥仅放在服务器环境变量，不要放前端。
- `SECURE_COOKIES=true` 时，Cookie 仅在 HTTPS 下发送。

----
生成时间：2025-08-30 08:01:13.371422
