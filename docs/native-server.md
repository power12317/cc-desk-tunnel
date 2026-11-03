# macOS / Linux 原生服务

原生服务是在原有 Linux Docker/Compose 之外增加的运行方式。Docker 的安装、镜像更新、持久 HOME、账号维护及备份入口继续使用[部署操作手册](../deploy/README.md)；Linux 原生开发部署也继续可用。本页针对在同一原用户下复用现有 Claude Code 的安装与登录环境，适用于 Mac mini 等常开设备。

| 部署 | Claude Code 与用户环境 | 安装与升级 |
| --- | --- | --- |
| Linux Docker/Compose | 保留镜像运行时与 `/data/home` | 保留 `deploy/manage.sh`、镜像及托管程序升级 |
| Linux 原生 | 使用指定 `CLAUDE_PATH` 与当前用户环境 | 保留原 Linux 安装/开发部署；已有 CLI 也可手动复用 |
| macOS 原生 | 当前已登录用户的现有 CLI、HOME、钥匙串、网络环境 | 安装本项目依赖，手动更新服务源码；不托管 CLI、不注册 launchd |

Windows/macOS/Linux 桌面和 ccdt 客户端继续连接以上服务；Windows 原生服务端不在现有支持范围内。

## 项目内的部署目录

macOS 原生部署将本服务的配置、访问密钥、证书和应用数据放在目标机器项目内的 `runtime/.local/`：

```text
cc-desk-tunnel/
  runtime/.local/
    service.env
    access-keys.json
    tls/
      server.crt
      server.key
    state/
```

服务端继续使用上游已有的 `--env-file`、`PROXY_DATA_DIR`、`PROXY_TLS_CERT/KEY` 配置机制。上述位置通过配置指定，不改变上游默认值或 Docker/Compose 部署布局。现有 `.gitignore` 的 `.local/` 规则已覆盖 `runtime/.local/`，配置、密钥、证书和数据不会进入 Git。

以下操作均在**目标 Mac 的项目根目录**执行。不要使用开发机器的绝对路径或 Node 安装路径。

## Node.js 与依赖

当前项目沿用官方 `>=24 <25` 的 Node.js 约束，Node.js 26 不在已验证范围内。目标机器可以保留 Node 26，并通过 Homebrew 并行安装 Node 24，仅在当前服务终端中选择它：

```sh
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version
command -v claude
```

确认 Node 输出 `v24.x.x`，且能够找到目标机器已安装、已登录的 `claude`。继续使用原来的 macOS 登录用户，不重新登录、导出/复制凭据或改变 HOME/CLAUDE_CONFIG_DIR、代理和网络出口。

只运行服务端、不启用 Web 时，安装服务端依赖即可：

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --omit=dev \
  --workspace=@cc-desk-tunnel/server \
  --workspace=@cc-desk-tunnel/protocol
```

## 首次配置

以下命令只创建缺失文件。已有部署先按下文迁移，保留原空间 ID、token、证书及历史数据。

```sh
mkdir -p runtime/.local/tls runtime/.local/state
chmod 700 runtime/.local runtime/.local/tls runtime/.local/state

(
  umask 077
  if [ ! -f runtime/.local/tls/server.key ]; then
    openssl genrsa -out runtime/.local/tls/server.key 3072
  fi
  if [ ! -f runtime/.local/tls/server.crt ]; then
    openssl req -new -x509 -sha256 -days 365 \
      -key runtime/.local/tls/server.key \
      -out runtime/.local/tls/server.crt \
      -subj "/CN=cc-desk-tunnel.local"
  fi
  if [ ! -f runtime/.local/access-keys.json ]; then
    cat > runtime/.local/access-keys.json <<EOF
[
  {"id":"team-a","token":"$(openssl rand -hex 32)"},
  {"id":"team-b","token":"$(openssl rand -hex 32)"}
]
EOF
  fi
  if [ ! -f runtime/.local/service.env ]; then
    cat > runtime/.local/service.env <<EOF
PROXY_ADAPTER=claude-code
PROXY_HOST=0.0.0.0
PROXY_PORT=8787
PROXY_DATA_DIR=runtime/.local/state
CLAUDE_PATH="$(command -v claude)"
PROXY_ACCESS_KEYS_FILE=runtime/.local/access-keys.json
PROXY_TLS_MODE=direct
PROXY_TLS_CERT=runtime/.local/tls/server.crt
PROXY_TLS_KEY=runtime/.local/tls/server.key
PROXY_RELEASE_REPO=none
PROXY_WEB_ENABLED=0
EOF
  fi
)
```

`0.0.0.0` 接受局域网连接；仅供本机使用时填 `127.0.0.1`。相对路径均相对于启动时的项目根目录。两个 token 由目标 Mac 随机生成；同一空间的设备使用同一 token，不同空间的设备使用不同 token。密钥轮换与旧数据归属见[访问空间](access-spaces.md)。

已有部署迁移时先停服并备份，将原配置、密钥文件、完整证书对和整个应用数据目录复制到对应位置，再将配置中的数据、密钥文件、证书路径改成上述 `runtime/.local/...`。保留原 `CLAUDE_PATH`、token、空间 ID 和其他设置。验证数据与连接正常后再清理旧部署文件；不要同时启动两个进程读写同一数据目录。

## 启动与连接

在目标 Mac 的项目根目录，用其自己安装的 Node.js 24 启动：

```sh
export PATH="$(brew --prefix node@24)/bin:$PATH"
caffeinate -i node --env-file=runtime/.local/service.env apps/server/src/main.ts
```

`caffeinate` 仅在服务运行期间防止空闲休眠。保持终端打开，Ctrl-C 停止本次服务。重新启动直接使用上述命令，不重复初始化。

客户端使用官方 `0.3.9`，填写 `wss://目标Mac的局域网IP:8787/ws`。在目标 Mac 上读取实际证书指纹和访问密钥：

```sh
openssl x509 -in runtime/.local/tls/server.crt -noout -fingerprint -sha256
open -a TextEdit runtime/.local/access-keys.json
```

自签证书有效期一年，客户端填写输出中 `=` 后的 SHA256 指纹。证书属于本服务的 TLS 身份，与 Claude 登录和 SSH 临时密钥不同；其他入口方式见[部署说明](deployment.md)。

停服后备份或清理本服务的部署文件时，统一处理 `runtime/.local/`，其中包含访问密钥、证书私钥及会话数据。

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
