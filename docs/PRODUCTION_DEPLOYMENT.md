# Marginalia 家庭访问部署手册

目标地址为 `https://read.zengziyang.com`。公网身份验证完全由
Cloudflare Access 承担；Marginalia 本身仍是家庭共享账户，API 不直接暴露端口。

## 当前本地边界

- 生产入口：`docker-compose.prod.yml`
- 生产密钥：`.env.production`（已被 Git 忽略）
- 持久数据：`backend/data` 绑定到容器 `/app/data`
- 公网链路：Cloudflare Tunnel `read.zengziyang.com` → `http://api:8720`
- EPUB 文件上限：90 MB
- 备份目录：`G:\Backups\Marginalia`，默认保留 14 份

不要把 Tunnel token、Cloudflare API token、家庭邮箱清单或真实生产环境文件提交到
Git。Cloudflare Access 邮箱清单只保存在 Cloudflare 控制台。

## 1. 切换前记录与快照

2026-07-29 本机预检快照：系统 DNS 返回
`dns17.hichina.com` / `dns18.hichina.com`，根域名 A 为 `216.198.79.1`，
`read.zengziyang.com` 尚不存在；`https://zengziyang.com` 的作品集首页可正常访问。
这只是外部查询结果，不能替代阿里云控制台的完整记录导出。

1. 在阿里云 DNS 控制台重新导出 `zengziyang.com` 的完整记录，并截图记录
   当前 NS（回滚值应为 `dns17.hichina.com`、`dns18.hichina.com`）。
2. 逐项记录根域名作品集使用的 A/AAAA/CNAME、MX、TXT、CAA 等全部记录。
   特别确认根域名 A 记录的地址和代理状态。
3. 在 Cloudflare 添加整个 `zengziyang.com` zone，复制/导入全部记录。在更改 NS
   之前，从 Cloudflare DNS 页面逐项与阿里云导出文件比对。
4. 在当前服务停止写入的短维护窗口运行：

   ```powershell
   rtk proxy powershell -NoProfile -File .\scripts\Backup-Marginalia.ps1
   rtk proxy powershell -NoProfile -File .\scripts\Test-MarginaliaRestore.ps1
   ```

   两条命令必须分别显示 `Backup complete`、`Restore drill passed` 和
   `SQLite integrity: ok`。恢复演练使用临时 Docker 卷，默认验证后删除。

当前数据直接位于 `backend/data`，生产 Compose 继续使用该目录，因此不需要把数据
搬入一个新的匿名卷，也不会出现启动后看到空书库的问题。

## 2. Cloudflare Tunnel 与 Access

1. Cloudflare Zero Trust → **Networking > Tunnels**，创建 remotely managed
   Tunnel，命名为 `marginalia-home`。
2. 为 Tunnel 添加 Published application route：
   - Hostname：`read.zengziyang.com`
   - Service：`http://api:8720`
   - Additional application settings → HTTP Host Header：
     `read.zengziyang.com`
3. 复制 Tunnel token 的值（不要复制整条 Docker 命令），写入本机
   `.env.production` 的 `TUNNEL_TOKEN`。
4. Zero Trust → **Access controls > Applications**，新增 Self-hosted application：
   - Domain：`read.zengziyang.com`
   - Session duration：7 days
5. 新建 Allow policy，Include selector 选择 **Emails**，逐个填写允许的家庭邮箱，
   policy session duration 同样设为 7 days。
6. 不要使用 `Include Everyone`，也不要只使用
   `Include Login Methods = One-time PIN`；这两种规则会放行清单外用户。
7. Access 登录方式启用 One-time PIN。用一个白名单邮箱和一个非白名单邮箱分别实测。
8. Cloudflare 管理账号启用 MFA。移除家庭成员时，先从 Allow policy 删除邮箱，再到
   **Team & Resources > Users** 撤销该用户活动会话；必要时对应用执行
   **Revoke existing tokens**。

## 3. DNS 切换

1. 先确认 Cloudflare 中根域名作品集记录与阿里云完全一致。
2. 在阿里云域名控制台仅更换权威 NS 为 Cloudflare zone Overview 显示的两个
   nameserver；注册商仍保留在阿里云，并开启域名自动续费。
3. 等待 Cloudflare zone 变为 Active，然后验证：

   ```powershell
   nslookup -type=ns zengziyang.com 1.1.1.1
   nslookup -type=ns zengziyang.com 8.8.8.8
   ```

4. DNS 切换前后都从浏览器打开 `https://zengziyang.com`，记录 HTTP 状态、
   TLS 证书和首页截图，确保作品集没有变化。

Cloudflare Free/Pro 使用 full setup，需要 Cloudflare 接管整个 zone 的权威 DNS；
不能只把免费 Tunnel 所需的单个子域留在原 DNS 托管商。

## 4. 启动生产容器

确认 Docker Desktop 已启动、Windows Ollama 可访问，并已填写真实 Tunnel token：

```powershell
rtk proxy powershell -NoProfile -File .\scripts\Start-MarginaliaProduction.ps1
```

脚本会构建无热重载的 API 镜像、等待健康检查、确认 Compose 没有发布 8720，
并输出 Tunnel 最近日志。`cloudflared` 固定为 `2026.7.2`，升级时应先查看 release
notes，再显式修改版本。

本机目前若仍有旧的局域网 portproxy，必须在 Tunnel 和 Access 验证成功后，以管理员
PowerShell 删除对应的精确规则。例如当前旧规则为：

```powershell
netsh interface portproxy delete v4tov4 listenaddress=10.227.69.215 listenport=8720
```

删除后再次运行生产启动脚本；它会拒绝任何非 loopback 的 8720 监听。不要在 Tunnel
验证成功前删除旧入口，以免提前中断现有访问。

## 5. 开机启动、睡眠与每日备份

先在 Docker Desktop 设置中启用 **Start Docker Desktop when you sign in**，然后运行：

```powershell
rtk proxy powershell -NoProfile -File .\scripts\Install-MarginaliaScheduledTasks.ps1 -BackupAt 03:00 -DisableSleepOnAC
```

该脚本创建登录时启动生产 Compose 的任务、每天 03:00 的备份任务，并在显式传入
`-DisableSleepOnAC` 时关闭交流电待机。若 powercfg 或任务注册被拒绝，请用管理员
PowerShell 重试。备份脚本会在生产服务正在运行时短暂停止 API/Tunnel，复制完整数据，
验证 SQLite，生成 SHA-256 manifest，恢复服务，并只保留最近 14 份。

## 6. 上线验收

- `docker compose -f docker-compose.prod.yml ps`：API 为 healthy，Tunnel 为 running。
- `docker compose -f docker-compose.prod.yml logs --tail 100 cloudflared`：至少一条
  Tunnel connection 已注册，没有持续重连。
- `docker compose -f docker-compose.prod.yml port api 8720`：无输出。
- `Get-NetTCPConnection -State Listen -LocalPort 8720`：不得出现非 loopback 地址。
- 家庭 Wi-Fi 与手机流量各测一次：白名单 OTP 成功，非白名单被拒，不需要 VPN。
- 两台设备分别完成上传、阅读、划线、笔记、书签、进度同步和 AI 问答。
- 上传一个接近但不超过 90 MB 的有效 EPUB，再确认超过 90 MB 返回 HTTP 413。
- 临时停止 `cloudflared`，确认外部呈现不可用而不是绕过 Access 直达源站；恢复后重连。
- 删除一个测试邮箱并撤销会话，确认原会话立即失效。
- 再执行一次备份和临时卷恢复演练。

API 响应带 `Cache-Control: private, no-store`、`CDN-Cache-Control: no-store` 和
`Cloudflare-CDN-Cache-Control: no-store`；PWA 静态资源和 IndexedDB 的设备离线缓存
不受影响。退出 Access 不会自动清除设备上已有离线数据。

## 7. 中国大陆网络不稳定时回滚

1. 保留 `backend/data`、生产容器和所有备份，不删除、不重建卷。
2. 在阿里云把 NS 精确恢复为切换前记录的
   `dns17.hichina.com`、`dns18.hichina.com`。
3. 用 1.1.1.1 与 8.8.8.8 查询确认旧 NS 生效，并复测根域名作品集。
4. Cloudflare Tunnel 可以停止，但不要删除，便于后续复盘。
5. 后续单独评估中国大陆 ECS/轻量服务器方案；不要把 8720 直接暴露到公网。

## 参考

- Cloudflare full DNS setup:
  https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/
- DNS import/export:
  https://developers.cloudflare.com/dns/manage-dns-records/how-to/import-and-export/
- Tunnel token/run parameters:
  https://developers.cloudflare.com/tunnel/advanced/run-parameters/
- Access policies:
  https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- Access session revocation:
  https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
