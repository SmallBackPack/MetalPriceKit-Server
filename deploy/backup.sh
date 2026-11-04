#!/usr/bin/env bash
#
# backup.sh —— 备份 SQLite 数据
#
# 为什么 market.db 值得备份：
#   它存着「服务端每天观测到的收盘价」，是涨跌额的数据基础。
#   丢了不报错，但涨跌会一路显示 0，直到攒够一个交易日的观测才恢复。
#
# 用法：
#   ./deploy/backup.sh                 备份到 /backup/metalpricekit
#   BACKUP_DIR=/mnt/nas ./deploy/backup.sh
#
# 加到 crontab（每天凌晨 4 点）：
#   0 4 * * * /opt/metalpricekit-server/deploy/backup.sh >> /var/log/metalpricekit-backup.log 2>&1

set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/metalpricekit-server/data}"
BACKUP_DIR="${BACKUP_DIR:-/backup/metalpricekit}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

for db in market.db user.db; do
  src="$DATA_DIR/$db"
  [ -f "$src" ] || { echo "跳过 $db（不存在）"; continue; }

  # 用 sqlite3 的 .backup 命令，不能直接 cp —— WAL 模式下 cp 会拿到不完整的库。
  sqlite3 "$src" ".backup '$BACKUP_DIR/${db%.db}-$STAMP.db'"

  # 保留最近 30 份。
  find "$BACKUP_DIR" -name "${db%.db}-*.db" -type f -mtime +30 -delete
done

echo "备份完成：$BACKUP_DIR/$STAMP"
