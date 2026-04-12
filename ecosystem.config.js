module.exports = {
  apps: [
    {
      name: 'hrlife-sdr',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/hrlife-sdr/error.log',
      out_file: '/var/log/hrlife-sdr/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
