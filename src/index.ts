import { TARSTerminal } from './ui/terminal';

process.on('uncaughtException', (err) => {
  process.stderr.write(`Uncaught: ${err.message}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled rejection: ${String(reason)}\n`);
});

const terminal = new TARSTerminal();
terminal.run();
