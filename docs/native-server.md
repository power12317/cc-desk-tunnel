# macOS / Linux 原生服务

原生服务是在原有 Linux Docker/Compose 之外增加的运行方式。Docker 的安装、镜像更新、持久 HOME、账号维护及备份入口继续使用[部署操作手册](../deploy/README.md)；Linux 原生开发部署也继续可用。本页针对在同一原用户下复用现有 Claude Code 的安装与登录环境，适用于 Mac mini 等常开设备。

| 部署 | Claude Code 与用户环境 | 安装与升级 |
| --- | --- | --- |
| Linux Docker/Compose | 保留镜像运行时与 `/data/home` | 保留 `deploy/manage.sh`、镜像及托管程序升级 |
| Linux 原生 | 使用指定 `CLAUDE_PATH` 与当前用户环境 | 保留原 Linux 安装/开发部署；已有 CLI 也可手动复用 |
| macOS 原生 | 当前已登录用户的现有 CLI、HOME、钥匙串、网络环境 | 安装本项目依赖，手动更新服务源码；不托管 CLI、不注册 launchd |

Windows/macOS/Linux 桌面和 ccdt 客户端继续连接以上服务；Windows 原生服务端不在现有支持范围内。

## 项目内的部署目录

macOS（Mac mini）和 Linux 原生部署将本服务的配置、访问密钥、证书和应用数据放在目标机器项目内的 `runtime/local/`：

```text
cc-desk-tunnel/
  runtime/local/
    service.env
    access-keys.json
    tls/
      server.crt
      server.key
    state/
```

服务端继续使用上游已有的 `--env-file`、`PROXY_DATA_DIR`、`PROXY_TLS_CERT/KEY` 配置机制。上述位置通过配置指定，不改变上游默认值或 Docker/Compose 部署布局。`.gitignore` 已忽略 `runtime/local/`，配置、密钥、证书和数据不会进入 Git。

以下操作均在**目标 Mac mini 或 Linux 机器的项目根目录**执行，使用目标机器现有的 Node 和 Claude Code。

## 官方配置文件与 Node.js

官方原版已使用 `service.env` 配置文件，服务启动时由 Node 的 `--env-file` 参数读取；Docker 入口和 Linux 原生部署脚本均使用这种方式。无需手动 `export`、`source` 或修改系统/终端的环境设置。文件内容只在启动的服务进程中由 `process.env` 读取；这仍然是环境变量格式的配置文件，不是 JSON。官方没有服务级 JSON/YAML 解析入口，也没有 `--port`、`--token`、`--config` 等应用参数。[配置实现](../apps/server/src/config.ts)与[官方沿用的 Docker 启动方式](../deploy/docker/entrypoint.sh)可供核对。

沿用目标 Mac mini 或 Linux 机器当前安装的 Node.js 和现有 Claude Code，不安装或切换 Node，也不改变 PATH。官方仓库声明的 Node 范围为 `>=24 <25`，这项声明来自上游；本次在 macOS arm64 上用现有代码验证了 Node 26.13.0：服务端依赖安装成功，43 项相关离线测试通过。上游声明可能使 npm 输出 `EBADENGINE` 警告，本次安装实际退出码为 0；不据此要求更换目标机器的 Node，也不改写官方声明或宣称所有历史版本均已验证。

以下操作使用目标机器已经能正常运行 Claude 的同一个用户。不重新登录、导出/复制凭据或改变 HOME/CLAUDE_CONFIG_DIR、代理和网络出口。

只运行服务端、不启用 Web 时，安装服务端依赖即可：

```sh
npm ci --omit=dev \
  --workspace=@cc-desk-tunnel/server \
  --workspace=@cc-desk-tunnel/protocol
```

## 首次配置

以下命令只创建缺失文件，保留已有配置、空间 ID、token、证书及历史数据。

```sh
mkdir -p runtime/local/tls runtime/local/state
chmod 700 runtime/local runtime/local/tls runtime/local/state

(
  umask 077
  if [ ! -f runtime/local/tls/server.key ]; then
    openssl genrsa -out runtime/local/tls/server.key 3072
  fi
  if [ ! -f runtime/local/tls/server.crt ]; then
    openssl req -new -x509 -sha256 -days 365 \
      -key runtime/local/tls/server.key \
      -out runtime/local/tls/server.crt \
      -subj "/CN=cc-desk-tunnel.local"
  fi
  if [ ! -f runtime/local/access-keys.json ]; then
    cat > runtime/local/access-keys.json <<EOF
[
  {"id":"team-a","token":"$(openssl rand -hex 32)"},
  {"id":"team-b","token":"$(openssl rand -hex 32)"}
]
EOF
  fi
  if [ ! -f runtime/local/service.env ]; then
    cat > runtime/local/service.env <<EOF
PROXY_ADAPTER=claude-code
PROXY_HOST=0.0.0.0
PROXY_PORT=8787
PROXY_DATA_DIR=runtime/local/state
CLAUDE_PATH=/Users/mac/.local/bin/claude
PROXY_ACCESS_KEYS_FILE=runtime/local/access-keys.json
PROXY_TLS_MODE=direct
PROXY_TLS_CERT=runtime/local/tls/server.crt
PROXY_TLS_KEY=runtime/local/tls/server.key
PROXY_RELEASE_REPO=none
PROXY_WEB_ENABLED=0
EOF
  fi
)
```

Mac mini 的示例默认 Claude 路径为 `/Users/mac/.local/bin/claude`。Linux 部署时，用 `command -v claude` 查看目标机器已有的可执行文件路径，并将结果填写到 `runtime/local/service.env` 的 `CLAUDE_PATH`；若实际安装路径不同，Mac 同样修改此配置项。这里只编辑配置文件，不改变 PATH，也不安装或替换现有 Claude Code。

`0.0.0.0` 接受局域网连接；仅供本机使用时填 `127.0.0.1`。相对路径均相对于启动时的项目根目录。两个 token 由目标机器随机生成；同一空间的设备使用同一 token，不同空间的设备使用不同 token。密钥轮换与旧数据归属见[访问空间](access-spaces.md)。

## 启动与连接

在目标 Mac mini 或 Linux 机器的项目根目录，直接使用现有 `node` 读取配置文件启动：

```sh
node --env-file=runtime/local/service.env apps/server/src/main.ts
```

Mac mini 可使用系统自带的 `caffeinate`，在服务运行期间防止空闲休眠：

```sh
caffeinate -i node --env-file=runtime/local/service.env apps/server/src/main.ts
```

保持终端打开，Ctrl-C 停止本次服务。重新启动直接使用对应命令，不重复初始化。

macOS 原生服务启动时会自动检查 `node-pty` 实际加载的 `spawn-helper`，缺少执行权限时仅补当前用户的执行权限。重新安装依赖后也会执行检查，无须手动运行 `chmod`；权限修复失败会在服务启动时报告具体辅助程序路径。Linux 和 Windows 不执行此修复。

客户端使用官方 `0.3.9`，填写 `wss://目标服务器的局域网IP:8787/ws`。在目标服务器上读取实际证书指纹：

```sh
openssl x509 -in runtime/local/tls/server.crt -noout -fingerprint -sha256
```

访问密钥保存在 `runtime/local/access-keys.json`。Mac 可以用 `open -a TextEdit runtime/local/access-keys.json` 打开；Linux 使用目标机器上的文本编辑器查看或修改。

自签证书有效期一年，客户端填写输出中 `=` 后的 SHA256 指纹。证书属于本服务的 TLS 身份，与 Claude 登录和 SSH 临时密钥不同；其他入口方式见[部署说明](deployment.md)。

停服后备份或清理本服务的部署文件时，统一处理 `runtime/local/`，其中包含访问密钥、证书私钥及会话数据。

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
