module.exports = {
    apps: [
        {
            name: 'gen.socialversal.online',
            script: 'src/server.js',
            cwd: '/root/projects/gen-ai-browser',
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

