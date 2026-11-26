// Child inside ConPTY: emits two OSC 7501 reports and a query, then reports what (if anything) came back on stdin.
process.stdin.setRawMode?.(true);
let got = '';
process.stdin.on('data', (d) => { got += d.toString('latin1'); });
process.stdout.write('before\r\n');
process.stdout.write('\x1b]7501;state=working:app=probe:msg=aGVsbG8\x1b\\');
process.stdout.write('\x1b]7501;state=blocked:kind=question:app=probe\x07');
process.stdout.write('\x1b]7501;?\x1b\\');
setTimeout(() => {
  process.stdout.write(`\r\nCHILD-STDIN=${JSON.stringify(got)}\r\n`);
  process.exit(0);
}, 1500);
