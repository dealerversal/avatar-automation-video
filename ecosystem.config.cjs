module.exports = {
    apps: [
        {
            name: 'video-gen.dealerversal.com',
            script: 'src/server.js',
            cwd: '/root/projects/avatar-automation-video',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};

