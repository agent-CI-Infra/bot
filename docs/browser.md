# 电脑预装浏览器与系统桌面环境

项目电脑与助手电脑共用基础容器镜像（`docker/project-computer.Dockerfile`），预装 Chromium 浏览器与 X11 虚拟桌面套件。平台**不再提供受限的内置 `browser` 工具或 `input.browser.origins` 源白名单**（#1214）；Agent 在具备命令执行权限的电脑里可直接通过命令行、CDP（Chrome DevTools Protocol）和系统桌面级工具自由驱动浏览器与图形界面。

## 预装工具

- **Chromium 与中文字体**：`chromium`、`fonts-liberation`、`fonts-noto-cjk`，通过稳定包装脚本 `/usr/local/bin/bot-chromium`（环境变量 `BOT_BROWSER_EXECUTABLE`）启动；默认追加 `--no-sandbox --disable-dev-shm-usage --disable-gpu`，并将 profile/crashpad 目录定向到 `/tmp/bot-chromium-home`（可通过 `BOT_BROWSER_HOME` 覆写），在只读根文件系统及只读 `HOME` 下也能正常运行。
- **X11 虚拟桌面与桌面级操作**：`xvfb`（`Xvfb`、`xvfb-run`）、轻量窗口管理器 `openbox`、`xdotool`、`wmctrl`、`xclip`、`scrot`、`ffmpeg`、`x11-utils`（`xdpyinfo`、`xwininfo`）以及 `imagemagick`、`python3-pil`。
- **便捷桌面包装 `/usr/local/bin/bot-desktop`**：
  - 一次性命令：`bot-desktop run [--size 1440x900x24] [--display :99] -- <command...>`，自动选择空闲 `DISPLAY` 启动 `Xvfb`（`-nolisten tcp`）与 `openbox`，执行命令并在退出时清理桌面进程与临时 XDG 目录。
  - 常驻虚拟桌面：`bot-desktop start [--size 1440x900x24] [--display :99]`（配合 `keep_background: true` 或后台运行），就绪后输出 `DISPLAY=:N`，后续命令可直接配合 `DISPLAY=:N` 使用 `bot-chromium`、`xdotool`、`wmctrl`、`scrot` 或 `ffmpeg -f x11grab`。
- **控制面不安装 Chromium**：Chromium 与桌面工具仅预装在项目电脑/助手电脑镜像中；控制面、manager 与 tunnel 镜像均不安装浏览器。

## 隔离与网络边界

- **容器级隔离保持不变**：项目电脑与助手电脑均以非特权用户（UID 10001）、只读根文件系统、`cap_drop: [ALL]`、`no-new-privileges` 和独立资源上限运行；虚拟桌面仅存在于容器内部，不接触宿主机桌面或宿主机浏览器会话。
- **项目电脑网络**：默认开启外网（`BOT_PROJECT_EGRESS=true`），使用项目独立 bridge 网络（与 `control` 内网隔离），可在项目设置「机器配置」里按仓库开关 `egress`。
- **助手电脑网络**：默认开启外网（`egress: true`），使用独立且关闭容器间通信（`enable_icc=false`）的 bridge 网络，允许访问外网但与 `control` 内网及其他助手容器隔离；超级管理员可在全局设置「助手电脑」关闭 `egress`，关闭后恢复为 `NetworkMode: 'none'`（无外网）。
- **PR 正文媒体**：任务在工作区（如 gitignore 目录）生成的截图（PNG/JPEG/GIF/WebP）与录屏（MP4/WebM）可直接通过 PR 交付工具的 `media` 参数托管并嵌入 PR 正文，详见[统一任务调度与对象 Manager](workflows.md)。

## 历史浏览器证据（只读兼容）

早期版本由旧 `browser` 工具记录在 `bot-data/browser-evidence/` 的历史截图与步骤仍保留只读查看、存储统计与按「轨迹正文」保留天数清理的能力：

- `GET /api/tasks/:id/browser-evidence`：步骤列表（JSON，自动脱敏凭据字段与令牌查询参数）。
- `GET /api/tasks/:id/browser-evidence/step-N.png`：对应 PNG 截图。鉴权与任务详情一致，校验文件名、目录边界与 SHA-256。
- 删除项目并要求删除证据时同步删除对应历史目录。
