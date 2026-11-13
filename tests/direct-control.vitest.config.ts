import { existsSync, readFileSync, readdirSync } from 'node:fs';

// The release image omits upstream test config and private workspace links.
const aliases: Array<{ find: string; replacement: string }> = [];
for (const name of readdirSync('/opt/openclaw/packages')) {
  const manifest = `/opt/openclaw/packages/${name}/package.json`;
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === 'string' ? value : (value as { import?: string; default?: string }).import ?? (value as { default?: string }).default;
    if (typeof target !== 'string' || key.includes('*')) continue;
    const source = `/opt/openclaw/packages/${name}/${target.replace('./dist/', 'src/').replace(/\.m?js$/, '.ts')}`;
    const built = `/opt/openclaw/packages/${name}/${target}`;
    aliases.push({ find: pkg.name + (key === '.' ? '' : key.slice(1)), replacement: existsSync(built) ? built : source });
  }
}
for (const name of readdirSync('/opt/openclaw/src/plugin-sdk')) {
  if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
  const key = name.slice(0, -3);
  const built = `/opt/openclaw/dist/plugin-sdk/${key}.js`;
  aliases.push({ find: `openclaw/plugin-sdk/${key}`, replacement: existsSync(built) ? built : `/opt/openclaw/src/plugin-sdk/${name}` });
}

export default {
  resolve: { alias: [
    ...aliases.sort((a, b) => b.find.length - a.find.length),
  ] },
  test: { testTimeout: 30000, hookTimeout: 30000, maxWorkers: 1 },
};
