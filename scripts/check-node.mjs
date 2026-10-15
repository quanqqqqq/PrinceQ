if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error(`PrinceQ requires Node.js 24.x (current: ${process.version}). Install Node 24 and reopen your terminal.`);
  process.exitCode = 1;
}
