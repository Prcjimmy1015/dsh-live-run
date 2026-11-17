#!/usr/bin/env node
/**
 * Generate the repository's format-1 plugin index (index.json).
 *
 * The index pins one release: `source.commit` is the commit the tag points at,
 * so `dsh plugin add` gets a reproducible git source. When npm publishing lands,
 * add an npm version alongside it (source: { type: 'npm', registry }) and keep
 * the git one as the fallback.
 *
 *   node tools/make-index.mjs [tag]      # default: v0.1.0
 *
 * Validate the result with the real consumer:
 *   @deepseek-ai/dsh-plugin-market-index → parseMarketIndex(json, indexUrl)
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const tag = process.argv[2] ?? 'v0.1.0'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const commit = execSync(`git rev-list -n 1 ${tag}`, { cwd: root }).toString().trim()
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`cannot resolve ${tag} to a commit: ${commit}`)
const publishTimestamp = Number(execSync(`git log -1 --format=%ct ${commit}`, { cwd: root }).toString().trim())

const repository = 'https://github.com/Prcjimmy1015/dsh-live-run'
const description = {
  en: 'Live-run panel for DeepSeek Harness: the file the model is touching, every read/write/edit as it happens, and streaming output of the running command — one better-sidebar tab.',
  zh: 'DeepSeek Harness 的实时运行面板：同一个 better-sidebar 标签里看模型正在读写的文件、每次读/写/改的过程，以及运行中命令的实时输出。',
}

const index = {
  format: 1,
  title: { en: pkg.name, zh: pkg.name },
  description: {
    en: 'Official index for dsh-live-run, a live-run sidebar panel for DeepSeek Harness.',
    zh: 'dsh-live-run 的官方索引：DeepSeek Harness 的实时运行侧栏面板。',
  },
  metadata: {
    categories: { ui: { title: { en: 'UI Enhancements', zh: 'UI 增强' } } },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Live Run', zh: '实时运行' },
      description,
      author: 'Prcjimmy1015',
      homepage: `${repository}#readme`,
      repository: { url: repository },
      metadata: {
        category: 'ui',
        keywords: pkg.keywords ?? [],
        labels: [],
        sortKeys: {},
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source: { type: 'git', url: repository, commit },
          engines: { dsh: '>=0.1.7' },
        },
      ],
    },
  ],
}

writeFileSync(new URL('../index.json', import.meta.url), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`index.json written: ${pkg.name}@${pkg.version} → ${commit.slice(0, 7)} (${tag})`)
