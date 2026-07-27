const minimum = [22, 19, 0] as const;
const actual = process.versions.node.split('.').map(Number);

const supported = minimum.every((part, index) => {
  const current = actual[index] ?? 0;
  const earlierEqual = minimum.slice(0, index).every((value, earlier) => (actual[earlier] ?? 0) === value);
  return !earlierEqual || current >= part;
});

if (!supported) {
  process.stderr.write(`AIOP Agent Platform requires Node.js >=${minimum.join('.')}; current=${process.versions.node}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Node.js ${process.versions.node} satisfies >=${minimum.join('.')}\n`);
}
