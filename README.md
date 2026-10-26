# 数据采集、训练与候选生成

Cloudflare部署使用前后端合并的Worker + D1，见 [部署步骤](cloudflare/DEPLOY.md)。在 `cloudflare` 目录执行 `npm ci`、`npm run package` 可生成独立部署ZIP。

本次已新建D1库 `lottery-lab-fresh-20261026`，部署配置已绑定新库ID `90e93795-a555-4fdc-80e0-de06d3a230ee`；新库从空记录开始。

已补齐 GitHub Actions 自动采集、开奖核对、训练和在线模型发布，见 [一次性配置步骤](cloudflare/AUTOMATION.md)。完成仓库和两个Secrets设置后，日常只需使用网页；可用 `npm run package:source` 生成包含隐藏工作流目录的GitHub源码包。线上是否启用以实际配置和成功运行记录为准。

现行 Vue 首页已切换为可验证的数据实验流程。运行方式、来源覆盖、具体训练方法和边界见 [lottery_lab/README.md](lottery_lab/README.md)，实际结果见 [训练报告](lottery_lab/data/latest-report.md)。应用已完成本地实现与验证；本次已新建并初始化远程D1，尚未发布Worker或启用GitHub自动任务。

# 旧版云开发 quickstart

这是云开发的快速启动指引，其中演示了如何上手使用云开发的三大基础能力：

- 数据库：一个既可在小程序前端操作，也能在云函数中读写的 JSON 文档型数据库
- 文件存储：在小程序前端直接上传/下载云端文件，在云开发控制台可视化管理
- 云函数：在云端运行的代码，微信私有协议天然鉴权，开发者只需编写业务逻辑代码

## 参考文档

- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)


