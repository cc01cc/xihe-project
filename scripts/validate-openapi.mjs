import fs from 'node:fs'

const file = new URL('../docs/api/openapi.yaml', import.meta.url)
const text = fs.readFileSync(file, 'utf8')
if (!/^openapi:\s*3\.1\.0\s*$/m.test(text)) throw new Error('OpenAPI 3.1 header missing')
const paths = [...text.matchAll(/^  (\/[^:]+):\s*$/gm)].map((match) => match[1])
const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index)
if (duplicates.length) throw new Error(`Duplicate paths: ${[...new Set(duplicates)].join(', ')}`)
for (const path of paths) {
  if (path.includes('{')) {
    const parameters = text.slice(text.indexOf(`  ${path}:`), text.indexOf('\n  /', text.indexOf(`  ${path}:`) + 4))
    for (const name of path.matchAll(/\{([^}]+)\}/g)) {
      if (!parameters.includes(`name: ${name[1]}`)) throw new Error(`Missing path parameter ${name[1]} for ${path}`)
    }
  }
}
if (!text.includes('application/problem+json') || !text.includes('ProblemDetails')) {
  throw new Error('Problem Details schema is not declared')
}
console.log(`OpenAPI structural validation passed (${paths.length} paths)`)
