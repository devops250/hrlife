#!/bin/bash
BACKUP_DIR=/opt/hrlife-sdr/backups
DATE=$(date +%Y-%m-%d)
RETENTION_DAYS=7

pg_dump -U hrlife -h 127.0.0.1 hrlife | gzip > ${BACKUP_DIR}/hrlife_${DATE}.sql.gz

find ${BACKUP_DIR} -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete

echo "Backup concluído: hrlife_${DATE}.sql.gz"
