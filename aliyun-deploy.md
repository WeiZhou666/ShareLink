# 部署到阿里云 ECS 全流程

> 基于 2026-10 的生产 Docker 体系：`backend-nest/Dockerfile`（NestJS 多阶段）+ `frontend-vue/Dockerfile`（Vite 产物 + Nginx）+ 根 [docker-compose.yml](../docker-compose.yml)。
> 跟着本文从一台裸 ECS 走到 HTTPS 上线，约 30-60 分钟。

## 一、前置知识：部署会用到的一切概念

### 1.1 最终拓扑（先看图再动手）

```
用户浏览器
   │ https://your-domain.com
   ▼
DNS A 记录（域名 → ECS 公网 IP）
   ▼
阿里云安全组（云防火墙，只放行 22/80/443）
   ▼
ECS 宿主机
 └─ Caddy 容器 :80/:443（TLS 终结，自动签证书）
     └─ 反代 → frontend 容器 :80（Nginx：静态资源 + SPA 回落）
                └─ /api 反代 → backend 容器 :3000（NestJS）
                               ├─ mysql :3306      （仅 compose 内网）
                               ├─ redis :6379      （仅 compose 内网）
                               ├─ minio :9000      （仅 compose 内网）
                               └─ clamav :3310     （仅 compose 内网）
```

### 1.2 关键概念对齐

| 概念 | 一句话解释 | 在本项目的落点 |
|---|---|---|
| 安全组 | 阿里云层面的包过滤防火墙，与系统内 firewalld **并存**，两道都要放行 | 只开 22/80/443；数据库四件套不映射宿主机端口（compose 已如此设计，天然隔离） |
| TLS 终结 | HTTPS 加解密发生在哪一层 | 宿主机 Caddy 层（方案 A）或 Nginx 容器（方案 B）；终结之后内网全是明文 HTTP，安全靠安全组隔离 |
| 同源反代 | 前端与 API 同一个域名，`/api` 路径转发 | axios `baseURL="/api"` 相对路径 + cookie 同源——**天然无跨域问题**，`CORS_ORIGIN` 填站点自身即可 |
| `COOKIE_SECURE` | cookie 仅经 HTTPS 传输 | env-loader 生产强校验必须为 `true`——**没配 HTTPS 前后端起不来**（fail-fast 设计） |
| named volume | Docker 管理的持久化卷 | mysql_data / backend_data / minio_data 等，容器重建数据不丢，备份就备它们 |

### 1.3 为什么 cookie 认证要求部署时特别注意

JWT 存在 `access_token` cookie（HttpOnly）里，浏览器对 cookie 有两条铁律：

1. `Secure` 标记 → 只随 HTTPS 请求发送。所以 `COOKIE_SECURE=true` 时若用 http:// 访问，**登录后 cookie 根本不会被带上**，表现为"登录成功但刷新就掉线"——不是 bug，是浏览器在保护你。
2. `SameSite`/跨域 → cookie 只能属于发起请求的那个域。同源反代架构下前后端同域，此问题不存在；这也是为什么生产不把 API 单独挂在 api.xxx.com（跨域 cookie 要 SameSite=None + Secure，复杂度高且老旧浏览器有坑）。

## 二、全流程

### 步骤 0：购买与初始化 ECS

- **规格**：2 核 4G 起步（ClamAV 病毒库常驻内存 ~1-1.5GB，4G 是含扫描的底线；不开杀毒 2C2G 也能跑）
- **系统镜像**：Ubuntu 22.04 LTS 或 Alibaba Cloud Linux 3（本文命令以 Ubuntu 为准）
- **磁盘**：系统盘 40G 起 + 按文件量预估（上传文件在 minio_data / backend_data 卷里，走系统盘；量大可挂数据盘）
- **安全组**：入方向放行 22（SSH）、80（HTTP）、443（HTTPS）。**不要**开放 3306/6379/9000/3310

初始化（首次 SSH 登录后）：

```bash
# 创建部署用户并授 sudo（避免长期用 root）
adduser deploy && usermod -aG sudo deploy
# 切换过去
su - deploy
```

### 步骤 1：安装 Docker（用阿里云镜像源加速）

```bash
# apt 源换阿里云
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu jammy stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list

# 安装
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy   # 免 sudo 用 docker，重新登录生效
newgrp docker

# 配置镜像加速（国内拉 Docker Hub 慢/失败的关键一步）
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run"
  ]
}
EOF
sudo systemctl restart docker
docker run --rm hello-world   # 验证
```

> 镜像加速器时效性强，若两个都失效，可换阿里云容器镜像服务的个人加速地址（容器镜像服务控制台免费开通）。

### 步骤 2：代码上服务器（二选一）

**方式 A：Git 拉取（推荐，日常更新最顺）**

```bash
# 服务器上生成部署密钥
ssh-keygen -t ed25519 -C "deploy" -f ~/.ssh/deploy_key -N ""
cat ~/.ssh/deploy_key.pub   # 粘贴到 GitHub 仓库 → Settings → Deploy keys（只读即可）

sudo tee ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/deploy_key
EOF

git clone git@github.com:<you>/ShareLink.git
cd ShareLink
```

**方式 B：本地构建镜像，save/load 传过去（服务器配置弱、构建慢时用）**

```bash
# 本地
docker build -t sharelink-backend ./backend-nest
docker build -t sharelink-frontend ./frontend-vue
docker save sharelink-backend sharelink-frontend | gzip > images.tar.gz
scp images.tar.gz deploy@<ECS_IP>:~/
# 服务器
docker load < ~/images.tar.gz
# load 进来的镜像名就是 sharelink-backend:latest，compose 里 image: 字段能直接对上，
# up 时加 --no-build 跳过构建
```

### 步骤 3：配置环境变量

```bash
cd ~/ShareLink
cp .env.production.example .env
vim .env
```

逐键填写（**加粗为必须改**）：

| 键 | 填什么 |
|---|---|
| **DB_PASS** | 强密码：`openssl rand -base64 24` |
| **JWT_SECRET** | 强随机：`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`（不足 16 字符或用模板值，启动直接被 zod 拦下） |
| **COOKIE_SECURE** | `true`（HTTPS 上线用；先纯 IP 试跑可用 false，正式域名必须改回） |
| **CORS_ORIGIN** | `https://your-domain.com`（同源反代架构填站点自身） |
| **FRONTEND_URL / APP_URL** | 同上，邮件链接与 OAuth 回调都用它拼装 |
| **WEB_PORT** | 默认 80；走宿主机 Caddy（方案 A）时改 `8080` 让 Nginx 容器退居内网 |
| MAIL_DELIVERY | `smtp` + SMTP 五键（QQ 邮箱 = smtp.qq.com:465 + 授权码，SMTP_FROM 必须与认证账号一致）；不配则 `log` 只打日志 |
| STORAGE_DRIVER | 默认 `local`（backend_data 卷）；要用 MinIO 填 `s3` 并填 S3 凭证 |

### 步骤 4：首次启动

```bash
docker compose up -d --build
docker compose ps    # 等全部 healthy（clamav 首次下载 ~250MB 病毒库要 3-5 分钟）
docker compose logs -f backend   # 关键观察点：
# "环境变量校验失败" → .env 填错，按提示逐键改
# "Application is running on: http://localhost:3000" → 启动成功（db push 已自动执行）
```

此时 `curl http://localhost:8080/api`（WEB_PORT=8080 时）应返回 Hello——后端通了，但还没有 HTTPS。

### 步骤 5：域名解析 + HTTPS（方案 A：宿主机 Caddy 自动证书，推荐）

1. **域名解析**：域名控制台加 A 记录 `@ → <ECS公网IP>`（如用 www 再加一条 CNAME）。国内服务器绑域名需完成 ICP 备案（阿里云控制台有免费流程，约 1-2 周，不备案 80/443 会被拦截）

2. **Caddy 反代容器**（一个纯配置容器，自动申请/续期 Let's Encrypt 证书）：

```bash
mkdir -p ~/caddy && cd ~/caddy
tee Caddyfile <<'EOF'
your-domain.com {
    reverse_proxy sharelink-prod-frontend-1:80
}
EOF
sudo docker run -d --name caddy \
  --restart unless-stopped \
  --network sharelink-prod_default \
  -p 80:80 -p 443:443 \
  -v ~/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy_data:/data \
  -v caddy_config:/config \
  caddy:2-alpine
```

> 要点：`--network sharelink-prod_default` 让 Caddy 加入 compose 网络，才能按容器名直连前端；`caddy_data` 卷存证书，重启不重签。

3. **验证 HTTPS**：浏览器开 `https://your-domain.com` → 应看到首页（logo 纸飞机 + hero 动效）。

### 步骤 5'（方案 B：阿里云免费证书 + Nginx 容器直接 TLS）

不想多一个组件时：阿里云控制台申请免费 SSL 证书（一年期）→ 下载 Nginx 格式（.pem + .key）→ 挂进前端容器并在 `nginx/default.conf.template` 里加 443 server 块 + `ssl_certificate` 指令，compose 映射 443。代价：每年手动换证书。**推荐方案 A**，一次配置永久自动续期。

### 步骤 6：上线验证清单

```bash
# 后端直连探活
docker compose exec backend curl -fs http://localhost:3000/api
# 浏览器走完整链路
```

- [ ] 注册账号（若配了 smtp，收到验证邮件且链接域名正确）
- [ ] 登录 → 刷新页面不掉线（cookie 生效的标志）
- [ ] 建分享 → 上传一个 >chunkSize 的文件（验证分块）→ 复制链接打开 → 下载
- [ ] 管理员提权后进 /admin → 配置页可改、公告可发
- [ ] 暗色模式切换、移动端窄屏布局正常

### 步骤 7：日常运维

```bash
# 更新发布
cd ~/ShareLink && git pull && docker compose up -d --build
# 旧镜像清理（构建会产生悬空层）
docker image prune -f

# 日志
docker compose logs -f backend          # 应用日志
tail -f /var/lib/docker/volumes/sharelink-prod_backend_logs/_data/combined-*.log   # winston 落盘日志

# 备份（建议 crontab 每日一次）
docker compose exec mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" sharelink' > backup-$(date +%F).sql
docker run --rm -v sharelink-prod_backend_data:/data -v ~/backup:/backup alpine \
  tar czf /backup/backend-data-$(date +%F).tar.gz -C /data .
# 恢复：反向操作（mysql 用 source 导入，backend_data 解压回卷）

# 资源观察
docker stats    # clamav ~1.5G、mysql ~400M、backend ~200M 属正常水位
```

## 三、故障排查速查表

| 症状 | 根因 | 处置 |
|---|---|---|
| backend 起不来，日志"环境变量校验失败" | zod fail-fast：JWT_SECRET 弱 / COOKIE_SECURE≠true / CORS_ORIGIN 缺 / SMTP 五键缺一 | 按日志逐键修 .env，`docker compose up -d` 重启 |
| 登录成功但刷新就掉线 | `COOKIE_SECURE=true` 但走的是 http:// | 上 HTTPS（方案 A），或试跑期临时 false |
| 502 Bad Gateway | backend 未就绪（等 healthcheck）或容器没在同一网络 | `docker compose ps` 看状态；确认 Caddy 用的网络名正确 |
| 上传大文件 413 | Nginx `client_max_body_size` (2G) < 分块大小 | 模板里调大后重建前端容器 |
| mysql 连接超时 pool timeout | backend 在 mysql healthy 前抢跑（不应发生，depends_on 已约束）或密码不一致 | `docker compose logs mysql`；.env 的 DB_PASS 改过需同时重建 mysql 卷（首次） |
| ClamAV 一直 unhealthy | 病毒库还在下载（首次 3-5 分钟）或内存不足被 OOM | `docker compose logs clamav`；小内存机器在 config.yaml 关 antivirus.enabled 并删服务 |
| 邮件收不到 | QQ 邮箱授权码错 / SMTP_FROM 与账号不一致 / 465 端口被安全组…（出站默认放行） | 查 backend 日志 nodemailer 报错；SMTP_FROM 必须 = 认证邮箱 |
| 域名访问被重置 | 未 ICP 备案 | 控制台走备案流程；期间用 IP:8080 临时验证（COOKIE_SECURE=false） |

## 四、面试速答

> **Q: 说一下你的部署架构？**
> 单机 compose 编排六容器：Nginx 托管 Vue 静态产物并反代 /api 到 NestJS，NestJS 依赖 MySQL/Redis/MinIO/ClamAV；宿主机 Caddy 做 TLS 终结自动续期。前后端同源，cookie 认证零跨域成本。内网组件全部不映射宿主机端口，攻击面只有 80/443。

> **Q: HTTPS 证书怎么管理的？**
> Caddy 对 ACME 协议的原生支持：首次请求触发 Let's Encrypt HTTP-01 挑战，证书 60 天自动轮换，存 named volume 持久化。相比 certbot + crontab 续期，零脚本零人工。

> **Q: 配置敏感信息怎么处理？**
> 两层：`.env` 只在服务器存在（.gitignore 排除），backend 容器经 compose env_file 注入；启动期 zod 校验 fail-fast——弱 JWT 密钥、非 HTTPS cookie、缺 CORS 白名单直接拒绝启动，把配置错误拦截在上线前而不是运行时。

> **Q: 数据怎么备份与恢复？**
> 三类持久化：MySQL（mysqldump 定时导出）、文件存储卷（tar 快照）、Redis（appendonly aof 天然持久化，会话黑名单可容忍丢失）。恢复即反向导入，RPO=一天（crontab 粒度），要更细可上 OSS 定时上传备份包。

> **Q: 为什么单机 compose 而不是 K8s？**
> 定位是自托管工具，单机容量（2C4G）远未饱和；compose 已提供 healthcheck 编排、重启策略、数据卷。演进触发点是多实例/高可用需求——那时先拆无状态 backend 多副本 + Redis 共享缓存（代码已为此预留：会话黑名单走 Redis 而非内存），再考虑容器编排升级，避免过度设计。
