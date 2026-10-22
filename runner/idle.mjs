// PID 1 has no credentials or listening sockets. All work enters through the fixed runner executable.
setInterval(() => {}, 3600000);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
