# Cloudflare 部署步骤

本包采用 **一个 Worker + 静态资源 + D1**：Vue 页面和 `/api/*` 共用一个域名，不需要另建 Pages 项目，也不需要修改前端 API 地址。

已打包页面、API、定时采集/核对逻辑、自动更新接口及初始训练快照。自动训练使用 GitHub Actions，配置见同目录的 [AUTOMATION.md](AUTOMATION.md)。没有代你发布线上服务、配置远程密钥或启用 GitHub 工作流。

## 1. 解压并安装部署工具

安装 Node.js **22.12+ 或 24 LTS**。在终端进入解压目录——这个目录下应当能看到 `worker.js`、`assets`、`package.json`、`schema.sql` 和 `wrangler.json`。

```sh
node --version
npm ci
npx wrangler login
npx wrangler whoami
```

`login` 会打开浏览器，选择要部署的 Cloudflare 账号。Wrangler 已锁定版本，`npm ci` 安装的就是包中验证过的工具链。

包内文件：

```text
assets/               已构建的Vue页面
worker.js             已打包的Worker代码，包含模型快照
schema.sql            幂等建表SQL，包含旧历史表、研究与自动更新表
wrangler.json         部署配置，已填写本次新建D1数据库ID
package.json          检查、建表、部署等命令
package-lock.json     依赖锁定
model-report.json     本次训练报告，供核对
release-info.json     打包时间、模型ID、各彩种快照截止时间
SHA256SUMS            包内文件校验值
DEPLOY.md             本文（部署步骤）
AUTOMATION.md         GitHub Actions一次性配置步骤
```

模型优先读取D1中已激活的在线快照；首次未激活时使用 `worker.js` 中的初始快照。只改 `model-report.json` 不会更新线上模型。

## 2. 确认本次新建的D1数据库

本次已在当前Cloudflare账号中创建独立新库，部署配置已填写：

| 配置 | 值 |
|---|---|
| 数据库名称 | `lottery-lab-fresh-20261026` |
| 数据库ID | `90e93795-a555-4fdc-80e0-de06d3a230ee` |
| 所属账号ID | `2d3baaa5582d33b88acb090fdf9813cb` |
| 创建区域 | APAC |

该新库已执行本包建表SQL。第4步可重复运行以核对或补建，不会清空记录。

在第1步登录这个账号后，执行以下只读命令，核对名称和ID：

```sh
npx wrangler d1 list
```

使用该账号部署时无需再次创建数据库，确认后继续第3步。如果改用其他账号，需要在那个账号创建一个全新数据库：

```sh
npx wrangler d1 create lottery-lab-fresh-20261026
```

换账号新建时，复制创建输出的 `database_id`，同时修改 `account_id`。若名称已被占用，换一个全新名称后创建，并同步修改 `database_name`，不要选择之前项目使用的数据库。

当前 `wrangler.json` 中的绑定为：

```json
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "lottery-lab-fresh-20261026",
    "database_id": "90e93795-a555-4fdc-80e0-de06d3a230ee"
  }
]
```

`binding` 必须保持 `DB`。若数据库用了其他名字，同时修改 `database_name`。不要把页面上显示的数据库名称填进 `database_id`。

新库从空记录开始，本次不导入旧候选、旧模型发布记录或旧库数据。原数据库保留；后续公开历史训练数据由Actions正常采集。

配置顶部的 `name` 默认是 `lottery-lab`。如果要更新已有 Worker，可改成 Dashboard 中那个 Worker 的准确名称；如果是首次部署，直接用默认名称即可。此项决定部署目标，名称不同会创建另一个 Worker。

配置顶层已设置新库所属的 `account_id`。换账号部署时，与新账号中新建的D1一起更新此值。

## 3. 本地检查

```sh
npm run check
npm run db:local
npm run dev
```

`check` 是 Wrangler 的 `deploy --dry-run`，不会发布。它检查 Worker、静态资源和绑定配置。

打开 [http://localhost:8790](http://localhost:8790)，应看到“彩票数据实验”首页；访问 [http://localhost:8790/api/research](http://localhost:8790/api/research) 应返回 JSON。

页面生成候选后，如本地建表成功，响应应包含 `saved: true`。若模型快照已经过期，生成会被拒绝，这是预期行为，更新方法见第8节。

本地测试结束后，在终端按 `Ctrl+C`。

## 4. 初始化远程数据库

确认配置填写的是第2步刚创建的新库ID后执行：

```sh
npm run db:remote
```

命令等价于：

```sh
npx wrangler d1 execute DB --remote --file=./schema.sql
```

SQL只包含 `CREATE TABLE IF NOT EXISTS` 和 `CREATE INDEX IF NOT EXISTS`，可重复执行。在新库中创建：

- `research_predictions`：保存新候选运行记录；不表示已购票。
- `official_draw_snapshots`：保存定时获取的官方近期原始开奖数据。
- `research_model_versions` / `research_active_model`：不可覆盖的模型快照及当前版本指针。
- `research_automation_runs`：后台任务运行状态。
- `research_draws`：通过检查的官方号码，用于核对。
- `research_forecasts` / `research_forecast_results`：开奖前首次发布的前瞻快照及开奖后的评分。
- `research_pending_candidates` / `research_prediction_results`：新候选的匹配条件及实际命中结果。

新库还会创建旧 `predictions` 历史表，保证兼容历史接口。

可核对实际建表结果：

```sh
npx wrangler d1 execute DB --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

本包没有把本地约6,458期的原始训练库导入D1。网页初始数据和训练报告来自随Worker部署的快照；D1保存后续在线模型、近期官方号码、候选和核对记录。全量原始数据由Python采集，并保存在本地或Actions制品中。

## 5. 发布

```sh
npm run deploy
```

部署结束会输出类似：

```text
https://lottery-lab.<你的workers子域>.workers.dev
```

打开这个网址即可使用，页面和API已经在同一站点。无需再上传到 Pages，也不要把此包当作 Pages 静态站点拖拽上传；那样只能部署页面，API和D1绑定不会随之运行。

首次启用 `workers.dev` 时，如果Cloudflare要求设置账号子域，按提示在 Workers & Pages 中设置。域名以实际部署输出为准。

## 6. 上线后核对

将下方示例地址替换为部署输出的实际地址：

```sh
curl --fail https://lottery-lab.YOUR-SUBDOMAIN.workers.dev/api/research

curl --fail https://lottery-lab.YOUR-SUBDOMAIN.workers.dev/api/predict-bundle \
  -H 'Content-Type: application/json' \
  --data '{"lotteryType":"ssq","count":5,"model":"uniform","seed":20261026}'
```

第二条会生成并写入一次候选记录。应包含 `success: true`、`count: 5`、`cost_yuan: 10`、`saved: true`；`target_issue` 暂为 `null`，期号等待官方确认。若只看到页面HTML，检查请求网址是否正确，以及配置中 `run_worker_first` 是否仍包含 `/api` 和 `/api/*`。

如果返回“快照已过生成截止时间”，先更新训练快照，不要把过期校验删掉绕过。

页面中切换彩种、生成5注并下载记录。首次激活前，截止期号应与 `release-info.json` 一致；之后以网页在线模型的截止期号为准。

查看最近写入记录：

```sh
npx wrangler d1 execute DB --remote --command="SELECT run_id, created_at, model_run_id FROM research_predictions ORDER BY created_at DESC LIMIT 5;"
```

实时查看日志：

```sh
npm run tail
```

## 7. 定时采集和自定义域名

配置里的 `"crons": ["0 14 * * *"]` 表示 **每天北京时间22:00**。在 Cloudflare Dashboard → Workers & Pages → 当前Worker → Settings → Triggers 中确认定时触发器。

定时任务会尝试抓取双色球和大乐透各最近30期，追加到D1并核对已发布记录。训练由GitHub Actions执行，且Actions也上传官方近期号码，作为Cloudflare出口受限时的补充。首次触发器变更可能需要等待传播；部署本身不会立即执行一次采集。源站在Cloudflare/GitHub出口的可用性以上线日志为准。

第一个定时周期后查询：

```sh
npx wrangler d1 execute DB --remote --command="SELECT lottery_type, COUNT(*) AS draws, MAX(issue) AS latest_issue FROM official_draw_snapshots GROUP BY lottery_type;"
```

如果没有记录，查看日志是否有 `Official draw sync failed`；常见原因是未建表、DB绑定错，或官方接口拒绝Cloudflare出口请求。不要通过公开GET `/api/fetch-results` 触发写入，旧接口已停用。

绑定自己的域名时，在当前Worker → Settings → Domains & Routes → Add → Custom Domain 中添加你在Cloudflare托管的域名，例如 `lottery.example.com`。也可在 `wrangler.json` 顶层加入下面配置后再次部署，使后续配置保持一致：

```json
"routes": [
  { "pattern": "lottery.example.com", "custom_domain": true }
]
```

如果域名已绑定到其他 Pages/Worker 或有冲突记录，需要先核对现有用途再调整。域名绑定好后仍使用同源 `/api`，无需重新编译前端。`workers.dev` 能访问不代表自定义域名一定已经生效，应分别核实。

## 8. 每期开奖后如何更新模型

推荐按 [AUTOMATION.md](AUTOMATION.md) 完成 GitHub Actions 的一次性设置。配置两个 Secrets、手动运行一次工作流后，日常无需在本地训练或重新部署。任务每天北京时间22:30、23:30、次日07:30检查新开奖，有新数据才训练并发布到D1；失败保留上一版本，过期暂停生成。

本包初始模型数据截至双色球2026122期、大乐透2026121期。初始快照保守生成截止时间分别为：

- 双色球：2026-10-27 20:00，北京时间。
- 大乐透：2026-10-26 20:00，北京时间。

以包内 `release-info.json` 和页面实际显示为准。过期后仍可看历史报告，但不能继续拿这份快照生成下一期候选。

以下本地命令仅用于人工研究和重新构建。已启用D1在线快照后，本地重新打包**不会覆盖D1活动模型**，普通开奖更新应运行Actions：

```sh
.venv/bin/python lottery_lab/pipeline.py collect --refresh
.venv/bin/python lottery_lab/pipeline.py enrich --limit 20
OPENBLAS_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 .venv/bin/python lottery_lab/pipeline.py train --seed 20261026

cd cloudflare
npm ci
npm run package
```

`npm run package` 会重新构建页面、打包最新Worker快照，并在原项目 `releases/` 生成新的目录、ZIP和校验文件。原项目初次安装前端依赖时，先在 `vue-version/client` 执行 `npm ci`。

以后升级代码时，将本次部署确认的 Worker `name`、`account_id`（如有）、本次新建D1的配置及自定义域名配置填写到新版 `wrangler.json`，再：

```sh
npm ci
npm run check
npm run deploy
```

后续代码升级继续使用本次新库的ID和已部署的Worker名称。代码升级后如有新增表，先应用新版SQL；重复执行不会清空已有记录。活动模型仍由已认证的发布流程切换。

## 9. 常见问题

| 现象 | 检查与处理 |
|---|---|
| `database_id` 无效 | 仍是占位符，或登录账号不对；用 `d1 list` 核对 |
| `no such table` / `saved: false` | 用正确的DB配置执行 `npm run db:remote` |
| 页面可开，API是404或HTML | 不要只上传 `assets` 到Pages；按本包完整部署Worker |
| 生成接口400且提示过期 | 查看GitHub Actions任务和Secrets，成功更新模型后重试 |
| `wrangler`不支持当前Node | 换用Node22.12+或24 LTS后重新 `npm ci` |
| 定时任务没有写入 | 检查Triggers、日志、官方源是否拒绝Cloudflare出口 |
| 自定义域名打不开但workers.dev正常 | 检查域名绑定、DNS和证书状态；二者分别验证 |
| 想恢复上一版 | Worker部署和D1活动模型独立；代码回滚不会回退D1模型，先核对具体故障和日期 |

本地验证只能确认打包、路由、SQL和模拟运行正确，不能代替上线后的远程D1和官方源连通性验证。

参考官方文档：[静态资源配置](https://developers.cloudflare.com/workers/static-assets/binding/)、[SPA路由](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)、[D1命令](https://developers.cloudflare.com/workers/wrangler/commands/#d1)、[定时任务](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
