# 部署产物

可直接复制的部署文件。完整说明见 [`../docs/服务端部署与额度.md`](../docs/服务端部署与额度.md)。

| 文件 | 用途 | 装到哪 |
|---|---|---|
| `env.example` | 环境变量模板（含密钥生成说明） | `/etc/metalpricekit-server.env`（`chmod 600`） |
| `metalpricekit-server.service` | systemd unit | `/etc/systemd/system/` |
| `nginx.conf` | Nginx 站点配置（含限流与 TLS） | `/etc/nginx/sites-available/` |
| `backup.sh` | 备份 SQLite 数据 | `/opt/metalpricekit-server/deploy/` |

## 最短路径

```bash
# 1. Node（服务器上）
curl -fsSL https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz \
  | tar -xJ -C /usr/local --strip-components=1

# 2. 代码
sudo mkdir -p /opt/metalpricekit-server && sudo chown $USER /opt/metalpricekit-server
cd /opt/metalpricekit-server
git clone <仓库地址> .
npm install --omit=dev

# 3. 运行用户与目录权限
sudo useradd -r -s /usr/sbin/nologin mpk
sudo mkdir -p /opt/metalpricekit-server/data
sudo chown -R mpk:mpk /opt/metalpricekit-server

# 4. 环境变量（密钥在这里生成）
sudo cp deploy/env.example /etc/metalpricekit-server.env
node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"
#   ↑ 把输出填进 /etc/metalpricekit-server.env 的 MPK_SERVER_KEYS
sudo chmod 600 /etc/metalpricekit-server.env

# 5. systemd
sudo cp deploy/metalpricekit-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now metalpricekit-server
sudo journalctl -u metalpricekit-server -f

# 6. Nginx（先把 server_name 换成真域名）
sudo cp deploy/nginx.conf /etc/nginx/sites-available/metalpricekit-server
sudo ln -s /etc/nginx/sites-available/metalpricekit-server /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 7. 证书
sudo certbot --nginx -d api.example.com

# 8. 自检：整条加解密链路
node scripts/smoke.ts https://api.example.com
```

## 上线顺序建议

先只对外开 `/health`，观察一天日志确认额度刹车生效（采集间隔被拉长是正常的），
再开放业务接口。别一上来就全量上线 —— 额度烧光是要等一个月才恢复的。
