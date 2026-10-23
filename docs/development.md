# 开发与验证

## 代码结构

`src/main.ts` 是控制面入口，`src/server.ts` 分离管理与 Webhook 两个监听。`src/app/` 保存账号、登录、仓库授权、模型和投递归一化逻辑，`src/core/security.ts` 提供验签、慢哈希和凭据加密，`src/storage/database.ts` 管理 SQLite、事务及审计；`static/` 是同一管理入口。`src/agent/` 保存模型循环、任务认领及恢复，`src/review/` 保存触发和位置校验，`src/github/` 保存授权读取及发布 outbox。`src/projects/` 是环境网关，`manager/` 管理受管 Docker 资源，`runner/` 是容器内命令／文件协议，`images/project/` 构建批准镜像。manager／runner 独立实现，保留 Apache-2.0 及 NOTICE 中的上游设计归属，不携带完整员工平台。

## 独立工作区开发

每项开发使用独立分支和 git worktree，避免在共享 main 工作区修改或覆盖别人的未提交内容。依赖、测试数据和端口按工作区隔离；Docker 验证使用独立的 Compose 项目、容器名和端口，不替换正在运行的本机实例；构建出的镜像标签见下文。

```sh
git worktree add -b feature/<topic> .worktrees/<topic> main
cd .worktrees/<topic>
npm ci
npm run check
npm test
```

## 检查与测试

验证需要 Node.js 22.13+ 和 npm；这些是源码检查命令，部署方式见[部署细节](deployment.md)。

```sh
npm ci
npm run check
npm test
docker compose config --quiet
docker compose -f compose.yaml -f compose.build.yaml config --quiet
```

`npm test` 覆盖并发初始化只成功一次、重启、权限收回、跨项目列表／详情／日志／模型隔离、凭据加密及不回显、验签、事务回滚重试、重复投递、先落库再确认和空配置不执行。SQLite 使用 Node 内置 `node:sqlite`，Node 22 会显示实验特性提示。

浏览器验收使用固定在 lockfile 的 Playwright，先运行 `npx playwright install chromium --only-shell`，再执行 `npm run test:e2e`；测试在自己的临时 SQLite 和随机端口上启动服务，覆盖初始化、登录、登记账号、查看签名投递、项目权限以及宽屏／窄屏页面，不占用部署数据或固定试用端口。输出放在忽略提交的 `.tmp/`。

实际 Docker 验收运行 `npm run test:docker`，需要 Docker 和上述 Playwright 浏览器。它用 `compose.yaml` 加 [`compose.build.yaml`](../compose.build.yaml) 从当前源码构建镜像，标签是 `department-bot*:local`，和同一台机器上从源码构建的部署共用：运行中的容器不受影响，但那份部署下次 `up` 会用上测试构建的镜像；按 GHCR 镜像运行的部署不受影响。它使用独立 Compose 项目和 18881／18882／18883 测试端口，18883 仅在测试覆盖文件里映射 manager；生产 Compose 不发布该端口。测试会检查两个真实环境、串行与并行、文件／卷／网络隔离、无凭据、代次重置、重启和角色页面，并按本次部署标签清理容器、网络及卷。输出保存在 `.tmp/project-env/`。

`npm run test:agent` 同样从源码构建，使用假 GitHub、假模型和真实项目容器验收完整旅程，包括 Issue 到 bot PR、草稿忽略、COMMENT 行内评论、别人 PR 不推送、bot PR 跟进、重复投递／未知响应对账、测试失败、tree 不一致、配置故障、manager 中断恢复、凭据隔离及任务页面角色范围。浏览器使用 lockfile 中的 Playwright。测试端口 18891–18894，与部署和人类试用数据隔离，结束后清理测试容器、网络和卷；产物放 `.tmp/review-dev/`。

`npm run test:external:docker` 使用独立临时镜像和无外网容器验证签名转发、兑换临时令牌和 Bot 身份评论；GitHub 为本地测试服务，结束后清理本次镜像及容器，不修改运行实例。
