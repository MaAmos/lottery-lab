# 新研究流程部署说明

推荐使用前后端合并的Worker部署包，完整操作见 [Cloudflare部署步骤](../cloudflare/DEPLOY.md)。包由项目根目录进入 `cloudflare` 后执行 `npm ci`、`npm run package` 生成。

现行入口、D1新增表迁移、模型快照更新和本地启动方式以 [lottery_lab/README.md](../lottery_lab/README.md) 为准。新流程需要部署整个Worker目录，不能只将单个旧 `index.js` 粘贴到Dashboard。

# 旧版部署指南 (Deployment Guide)

本项目已从微信小程序迁移为 Vue 3 Web 应用，并使用 Cloudflare Workers + D1 作为后端。

## 目录结构

- `client/`: Vue 3 前端项目
- `worker/`: Cloudflare Worker 后端逻辑 & D1 数据库定义

---

## 准备工作

1. 注册 [Cloudflare](https://dash.cloudflare.com/) 账号。
2. 安装 Node.js (推荐 v18+)。
3. 安装 Cloudflare CLI 工具 Wrangler:
   ```bash
   npm install -g wrangler
   ```
4. 登录 Wrangler:
   ```bash
   wrangler login
   ```

---

## 后端部署 (Worker + D1)

1. **进入 worker 目录**:

   ```bash
   cd worker
   npm install
   ```

2. **创建 D1 数据库**:

   ```bash
   wrangler d1 create lottery-lab-fresh-20261026
   ```

   _注意_: 运行后控制台会输出 `database_id`。

3. **配置 wrangler.toml**:
   打开 `worker/wrangler.toml`，将 `database_id` 替换为上一步生成的 ID。

   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "lottery-lab-fresh-20261026"
   database_id = "你的-uuid-id-在这里"
   ```

4. **初始化数据库表结构**:
   (本地开发)

   ```bash
   wrangler d1 execute DB --local --file=./schema.sql
   ```

   (生产环境)

   ```bash
   wrangler d1 execute DB --remote --file=./schema.sql
   ```

5. **部署 Worker**:

   ```bash
   npm run deploy
   # 或者
   wrangler deploy
   ```

   部署成功后，你会获得一个 URL，例如 `https://lottery-worker.your-name.workers.dev`。

6. **配置定时任务 (Cron)**:
   Worker 中已包含定时抓取开奖结果的逻辑。`wrangler.toml` 默认未开启 Cron，如需开启自动更新，请在 `wrangler.toml` 中添加：
   ```toml
   [triggers]
   crons = ["0 14 * * 2,4,0"] # 示例：每二、四、日 晚上 10 点 (UTC 14:00)
   ```

---

## 前端部署 (Vue Client)

1. **进入 client 目录**:

   ```bash
   cd ../client
   npm install
   ```

2. **配置后端地址**:
   打开 `client/src/api/index.js`，找到 `API_BASE`，修改为你部署好的 Worker 地址：

   ```javascript
   const API_BASE = import.meta.env.PROD
     ? "https://lottery-worker.your-name.workers.dev"
     : "";
   ```

3. **本地预览**:

   ```bash
   npm run dev
   ```

   注意：本地开发时，Vite 会代理 `/api` 到 `http://localhost:8787`。你需要在一个单独终端运行 Worker 的本地模式 (`cd worker && wrangler dev`)。

4. **构建生产版本**:

   ```bash
   npm run build
   ```

   这将在 `client/dist` 目录下生成静态文件。

5. **部署到 Cloudflare Pages**:
   - 登录 Cloudflare Dashboard。
   - 进入 **Pages** -> **Create a project** -> **Upload assets**。
   - 上传 `client/dist` 文件夹中的内容。
   - 部署完成！

---

## 功能说明

1. **AI 预测**:
   - 算法目前是模拟的 (Random + Rules)，位于 `worker/src/index.js` 的 `generatePrediction` 函数。
   - 如需接入真实 DeepSeek API，请在 Worker 中修改 `fetch` 调用并配置 API Key。

2. **数据验证**:
   - 用户点击“保存”后，预测记录存入 D1 数据库。
   - Worker 的 `fetch-results` 接口（或 Cron 定时任务）会从新浪彩票抓取最新开奖。
   - 系统自动比对未开奖的预测记录，计算命中数并更新数据库。
   - 用户刷新首页即可看到验证结果（命中/未命中）。

3. **用户系统**:
   - Web 版没有微信 OpenID，目前使用 Browser LocalStorage 生成随机 User ID 模拟。
   - 清除浏览器缓存会导致历史记录丢失。

