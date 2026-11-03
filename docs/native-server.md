# macOS / Linux 原生服务

原生服务是在原有 Linux Docker/Compose 之外增加的运行方式。Docker 的安装、镜像更新、持久 HOME、账号维护及备份入口继续使用[部署操作手册](../deploy/README.md)；Linux 原生开发部署也继续可用。本页针对在同一原用户下复用现有 Claude Code 的安装与登录环境，适用于 Mac mini 等常开设备。

| 部署 | Claude Code 与用户环境 | 安装与升级 |
| --- | --- | --- |
| Linux Docker/Compose | 保留镜像运行时与 `/data/home` | 保留 `deploy/manage.sh`、镜像及托管程序升级 |
| Linux 原生 | 使用指定 `CLAUDE_PATH` 与当前用户环境 | 保留原 Linux 安装/开发部署；已有 CLI 也可手动复用 |
| macOS 原生 | 当前已登录用户的现有 CLI、HOME、钥匙串、网络环境 | 安装本项目依赖，手动更新服务源码；不托管 CLI、不注册 launchd |

Windows/macOS/Linux 桌面和 ccdt 客户端继续连接以上服务；Windows 原生服务端不在现有支持范围内。

## 上游现有目录与配置方式

目录依据官方 `v0.3.9` 的实现，不为 macOS 新增固定目录规范：

| 入口 | 官方既有目录或用途 | 源码依据 |
| --- | --- | --- |
| 从源码启动服务 | 未指定 `PROXY_DATA_DIR` 时，数据默认在项目 `.local/sessions/` | [服务入口](../apps/server/src/main.ts) |
| Linux 原生部署脚本 | `$HOME/.local/share/cc-desk-tunnel/` 下的 `service.env`、`state/`、`tls/server.crt`、`tls/server.key` | [原生部署脚本](../scripts/deploy-linux.mjs) |
| Linux 原生运行时 | 同一基础目录下的 `runtime/` 保存脚本安装的 Node.js 与 Claude CLI；应用数据另放 `state/` | [运行时安装脚本](../scripts/install-linux.sh) |
| Docker/Compose | 默认部署配置为项目 `.local/docker.env`；数据目录下包含 `config/service.env`、`tls/`、`state/`、`home/`、`workspace/` | [部署管理脚本](../deploy/manage.sh) |

官方提供 macOS 客户端，但没有 macOS 原生服务端的一键安装器或独立目录规范。本项目的 Mac 支持沿用服务端原有的环境变量和 Node 启动入口；`PROXY_DATA_DIR`、`PROXY_TLS_CERT/KEY` 指定实际数据和证书位置。`--env-file` 指定已有配置文件的位置。此前说明中的 `.local/native.env` 只是自行选取的示例路径，不是官方约定，现已移除；聊天中提出的 `.local/mac-server`、项目根 `config/` 和 `runtime/` 也不是新增的部署标准。

## macOS 从源码运行

以下操作在目标 Mac 上执行。使用目标机器自己安装的 Node.js 24、Git、系统 `ssh`/`scp` 和已安装、已登录的官方 `claude`。不要为此重新登录、导出/复制凭据、改 HOME/CLAUDE_CONFIG_DIR、代理或网络出口，也不用安装 Linux 环境或虚拟机。

在目标机器的项目根目录安装服务端依赖。不启用 Web 时，无须安装或构建桌面应用：

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --omit=dev \
  --workspace=@cc-desk-tunnel/server \
  --workspace=@cc-desk-tunnel/protocol
```

沿用目标机器实际使用的配置文件。下面的绝对路径是待替换项，不代表新的默认目录；已有部署应沿用它自己的路径、访问密钥、证书和数据，不重新生成或搬迁：

```dotenv
PROXY_ADAPTER=claude-code
PROXY_HOST=127.0.0.1
PROXY_PORT=8787
PROXY_DATA_DIR=/absolute/path/to/existing/state
CLAUDE_PATH=claude
PROXY_ACCESS_KEYS_FILE=/absolute/path/to/access-keys.json
PROXY_TLS_MODE=direct
PROXY_TLS_CERT=/absolute/path/to/server.crt
PROXY_TLS_KEY=/absolute/path/to/server.key
PROXY_RELEASE_REPO=none
PROXY_WEB_ENABLED=0
```

`CLAUDE_PATH=claude` 沿用官方从 PATH 查找 CLI 的默认行为，也可填写目标机器上 `command -v claude` 得到的路径。密钥文件格式见[访问空间](access-spaces.md)。只使用单一访问密钥时，可沿用官方 `PROXY_TOKEN`，无须配置密钥文件。

路径有空格时 Node 的 dotenv 支持整行值，建议加引号。证书和私钥是本服务的 TLS 身份，位置由现有配置指定；首次部署按[部署安全说明](deployment.md)准备并核对目标机器证书的指纹。先保持回环监听，面向局域网提供服务时再明确指定监听地址。

管理员在目标 Mac 上已经能正常运行 Claude 的同一个登录用户终端中手动启动，将参数换成目标机器实际配置文件的路径：

```sh
node --env-file=/absolute/path/to/service.env apps/server/src/main.ts
```

服务不改 HOME/CLAUDE_CONFIG_DIR，不读取或导出钥匙串凭据，不复用或接管已经打开的 CLI 进程。官方 SDK 用 `pathToClaudeCodeExecutable` 创建独立正常会话；PTY 也使用同一路径。项目的 SQLite、workspace、SSH 和运行数据在 `PROXY_DATA_DIR`，CLI 的原生上下文仍由官方 CLI 放在现有用户环境。

从源码启用 Web 时，安装构建依赖并生成共享页面：

```sh
npm ci
npm run build --workspace @cc-desk-tunnel/desktop -- --outDir ../server/web
```

Web 静态文件默认从 `apps/server/web/` 读取。

macOS 默认不跟踪服务发布、不下载 CLI。没有 `PROXY_PROGRAM_DIR`/`PROXY_RUNTIME_DIR` 的原生安装不能运行 Docker 的托管升级步骤；手动更新本项目和依赖后再安排维护启动。不要对复用现有 CLI 的 Mac 运行 `install-linux.sh`。正常退出用 Ctrl-C 或向本次服务 PID 发 SIGTERM；PTY 在 macOS/Linux 都回收自身进程组，服务不会重启其他项目。

多密钥空间及旧数据迁移、账号维护权限、Web/手机入口见[访问空间](access-spaces.md)。macOS 共享账号维护留在服务端本机的官方 CLI；服务不会自动补写 `.claude.json`。原 Linux 托管容器的 onboarding 兼容只在明确的托管运行时启用。

## 验证范围

离线验收使用模拟 CLI，经官方 SDK、TLS/WSS 与真实回环 SSH 检查路由、stdin、stderr、退出码、特殊字符路径和断线重连；三平台追加提示词逐字匹配已确认文本。原生 SSH 配置固定路径与恢复/提示缓存策略继续保留。

真实 Mac mini 上仍须由用户在维护窗口验证：当前官方 CLI 版本与 SDK 的初始化、已登录用户的钥匙串访问、现有代理/网络下的正常模型会话、PTY 的交互引导、休眠唤醒和长期后台任务。离线 fixture 不证明实际登录或模型连接可用。Linux/Docker 的打包和脚本可离线检查，真实容器启动、镜像升级及不同架构仍应在既有部署 CI/测试机验证。
