# macOS / Linux 原生服务

原生服务是在原有 Linux Docker/Compose 之外增加的运行方式。Docker 的安装、镜像更新、持久 HOME、账号维护及备份入口继续使用[部署操作手册](../deploy/README.md)；Linux 原生开发部署也继续可用。本页针对在同一原用户下复用现有 Claude Code 的安装与登录环境，适用于 Mac mini 等常开设备。

| 部署 | Claude Code 与用户环境 | 安装与升级 |
| --- | --- | --- |
| Linux Docker/Compose | 保留镜像运行时与 `/data/home` | 保留 `deploy/manage.sh`、镜像及托管程序升级 |
| Linux 原生 | 使用指定 `CLAUDE_PATH` 与当前用户环境 | 保留原 Linux 安装/开发部署；已有 CLI 也可手动复用 |
| macOS 原生 | 当前已登录用户的现有 CLI、HOME、钥匙串、网络环境 | 安装本项目依赖，手动更新服务源码；不托管 CLI、不注册 launchd |

Windows/macOS/Linux 桌面和 ccdt 客户端继续连接以上服务；Windows 原生服务端不在现有支持范围内。

## macOS 从源码运行

先确保已有 Node.js 24、Git、系统 `ssh`/`scp` 和已安装、已登录的官方 `claude`。不要为此重新登录、导出/复制凭据、改 HOME/CLAUDE_CONFIG_DIR、代理或网络出口，也不用安装 Linux 环境或虚拟机。

在本项目目录执行 `npm ci` 安装项目自己的依赖、`npm run build` 构建桌面/Web 页面。它们不安装或替换全局 Claude Code。Web 静态文件默认从 `apps/server/web/` 读取；从源码启用 Web 前，可运行：

```sh
npm run build --workspace @cc-desk-tunnel/desktop -- --outDir ../server/web
```

在被忽略的 `.local/native.env` 保存服务配置（路径均替换为自己的值，密钥放在私有 JSON 文件内）：

```dotenv
PROXY_ADAPTER=claude-code
PROXY_HOST=127.0.0.1
PROXY_PORT=8787
PROXY_DATA_DIR=/Users/example/Library/Application Support/cc-desk-tunnel/state
CLAUDE_PATH=/Users/example/.local/bin/claude
PROXY_ACCESS_KEYS_FILE=/Users/example/Library/Application Support/cc-desk-tunnel/access-keys.json
PROXY_TLS_MODE=direct
PROXY_TLS_CERT=/Users/example/Library/Application Support/cc-desk-tunnel/service-cert.pem
PROXY_TLS_KEY=/Users/example/Library/Application Support/cc-desk-tunnel/service-key.pem
PROXY_RELEASE_REPO=none
PROXY_WEB_ENABLED=0
```

路径有空格时 Node 的 dotenv 支持整行值，建议加引号。证书和私钥是本服务的 TLS 身份，不是 Claude 或 SSH 凭据。可以沿用已有服务证书；新部署按[部署安全说明](deployment.md)准备并核对证书指纹。先保持回环监听，在用户确认网络与证书后再按原部署能力配置内网地址，禁止把明文开发服务公开。

管理员在已经能正常运行 Claude 的同一个 macOS 登录用户终端中手动启动：

```sh
node --env-file=.local/native.env apps/server/src/main.ts
```

服务不改 HOME/CLAUDE_CONFIG_DIR，不读取或导出钥匙串凭据，不复用或接管已经打开的 CLI 进程。官方 SDK 用 `pathToClaudeCodeExecutable` 创建独立正常会话；PTY 也使用同一路径。项目自己的配置、SQLite、workspace、SSH 和日志在 `PROXY_DATA_DIR`。CLI 的原生上下文仍由官方 CLI 放在现有用户环境；不要把服务状态目录误当作 Claude 登录目录。

macOS 默认不跟踪服务发布、不下载 CLI。没有 `PROXY_PROGRAM_DIR`/`PROXY_RUNTIME_DIR` 的原生安装不能运行 Docker 的托管升级步骤；手动更新本项目和依赖后再安排维护启动。不要对复用现有 CLI 的 Mac 运行 `install-linux.sh`。正常退出用 Ctrl-C 或向本次服务 PID 发 SIGTERM；PTY 在 macOS/Linux 都回收自身进程组，服务不会重启其他项目。

多密钥空间及旧数据迁移、账号维护权限、Web/手机入口见[访问空间](access-spaces.md)。macOS 共享账号维护留在服务端本机的官方 CLI；服务不会自动补写 `.claude.json`。原 Linux 托管容器的 onboarding 兼容只在明确的托管运行时启用。

## 验证范围

离线验收使用模拟 CLI，经官方 SDK、TLS/WSS 与真实回环 SSH 检查路由、stdin、stderr、退出码、特殊字符路径和断线重连；三平台追加提示词逐字匹配已确认文本。原生 SSH 配置固定路径与恢复/提示缓存策略继续保留。

真实 Mac mini 上仍须由用户在维护窗口验证：当前官方 CLI 版本与 SDK 的初始化、已登录用户的钥匙串访问、现有代理/网络下的正常模型会话、PTY 的交互引导、休眠唤醒和长期后台任务。离线 fixture 不证明实际登录或模型连接可用。Linux/Docker 的打包和脚本可离线检查，真实容器启动、镜像升级及不同架构仍应在既有部署 CI/测试机验证。
