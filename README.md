# 部门公共 Bot

这是部门公共的 GitHub App，负责检视 Issue 和 PR。仓库启用后，新开的 Issue 会收到一次检视评论；PR 在打开、标为可检视（Ready for review）以及 head 更新（推送新提交）时检视，草稿 PR 不检视；管理员可以按仓库关掉其中某种触发。bot 只发评论，不批准、不请求变更，也不合并。管理员为仓库打开开发后，bot 才会按 Issue 改代码并开 PR。许可证为 Apache-2.0。

## 安装到你的仓库

App 已经创建好了，不需要自己再建。安装地址只用这一个：

<https://github.com/apps/agent-ci-infra-bot/installations/select_target>

1. 打开上面的地址，选择仓库所在的组织或个人账号，再选要安装的仓库。
2. 安装之后，找这套 bot 的管理员审核并启用该仓库。
3. 启用后就可以开始使用。启用前收到的 Issue 和 PR 事件不会补跑。

## 自动改代码

自动改代码不是默认行为：只有管理员打开该仓库的开发开关，并且有人（不是 App）给没有指派人的 Issue 加上开发标签（默认 `bot-develop`）时，bot 才会改代码。完整条件见[自动开发什么时候开始](docs/rules.md#自动开发什么时候开始)。

## 用仓库文件调整规则

可以在自己仓库的默认分支放 `.bot/` 下的文件，覆盖 bot 的检视、标签、开发规则和虚拟电脑配置；仓库文件优先于内置默认和管理员在控制台的设置。路径、格式和限制见[用仓库文件调整规则](docs/rules.md)。

## 部署和管理

部署、接入向导、项目管理和升级都在[部署这套 bot 和管理员面板](docs/admin.md)。

## 反馈

用起来有问题或有建议，欢迎到本仓库提 issue：<https://github.com/agent-CI-Infra/bot/issues>
