module.exports = {
  apps: [
    {
      name: 'hrlife-sdr',
      script: 'scripts/build-and-start.sh',
      interpreter: '/bin/bash',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      min_uptime: '30s',
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/hrlife-sdr/error.log',
      out_file: '/var/log/hrlife-sdr/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
