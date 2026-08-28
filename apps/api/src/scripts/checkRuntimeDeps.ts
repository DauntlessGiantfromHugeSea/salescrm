/**
 * Prüft, dass der kompilierte Code nur Pakete importiert, die auch im
 * Produktionsabbild installiert sind.
 *
 * Anlass war ein Fehler, der erst im Betrieb auffiel: pino-pretty stand unter
 * devDependencies, wurde aber zur Laufzeit geladen. Das Abbild wird mit
 * --omit=dev gebaut, also brach die API beim Start ab – sichtbar nur als
 * 502 hinter dem Reverse Proxy.
 *
 *   npm run check:deps -w @salescrm/api
 */
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const production = new Set(Object.keys(pkg.dependencies));
const development = new Set(Object.keys(pkg.devDependencies));
const builtins = new Set(builtinModules);

const IMPORT_PATTERN =
  /(?:from|import)\s*\(?\s*['"]([^'".][^'"]*)['"]|require\(\s*['"]([^'".][^'"]*)['"]\s*\)/g;

function collectImports(directory: string, found = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectImports(path, found);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;

    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (!specifier || specifier.startsWith('node:')) continue;
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]!;
      if (!found.has(name)) found.set(name, path);
    }
  }
  return found;
}

const imports = collectImports(new URL('../../dist', import.meta.url).pathname);
const problems: string[] = [];

for (const [name, file] of imports) {
  if (production.has(name) || builtins.has(name)) continue;
  if (development.has(name)) {
    problems.push(
      `${name} ist eine devDependency, wird aber in ${file} zur Laufzeit geladen. ` +
        'Im Produktionsabbild fehlt sie – entweder nach dependencies verschieben ' +
        'oder den Import optional machen.',
    );
  } else {
    problems.push(`${name} wird in ${file} importiert, steht aber in keiner Abhängigkeitsliste.`);
  }
}

if (problems.length > 0) {
  console.error('\nLaufzeitabhängigkeiten fehlerhaft:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`${imports.size} Laufzeit-Importe geprüft, alle in dependencies.`);
