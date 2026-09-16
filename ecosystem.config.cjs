module.exports = {
    apps: [
        {
            name: process.env.PM2_APP_NAME || 'video-gen.dealerversal.com',
            script: 'src/gateway.js',
            cwd: '/root/projects/avatar-automation-video',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '600M',
            env: {
                NODE_ENV: 'production',
                PORT: 5001,
            },
        },
    ],
};
