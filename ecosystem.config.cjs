// ecosystem.config.cjs
module.exports = {
    apps: [
        {
            name: "bot-ada-usdm",
            script: "dist/index.js",
            node_args: "--enable-source-maps --env-file=.env.ada-usdm",
            cwd: ".",
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            out_file: "logs/ada-usdm.out.log",
            error_file: "logs/ada-usdm.err.log",
            env: { NODE_ENV: "production" },
        },
        {
            name: "bot-ada-strike",
            script: "dist/index.js",
            node_args: "--enable-source-maps --env-file=.env.ada-strike",
            cwd: ".",
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            out_file: "logs/ada-strike.out.log",
            error_file: "logs/ada-strike.err.log",
            env: { NODE_ENV: "production" },
        },
    ],
};
