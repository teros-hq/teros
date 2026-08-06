#!/usr/bin/env npx tsx
/**
 * generate-changelog.ts
 *
 * Generates a CHANGELOG.md entry from git commits using Conventional Commits.
 *
 * Usage:
 *   npx tsx scripts/generate-changelog.ts                    # Preview unreleased changes
 *   npx tsx scripts/generate-changelog.ts --release 1.1.0    # Generate + insert a new release
 *   npx tsx scripts/generate-changelog.ts --from v1.0.0      # From a specific tag
 *   npx tsx scripts/generate-changelog.ts --dry-run          # Print without writing
 */

import { execSync } from "child_process"
import { readFileSync, writeFileSync } from "fs"
import { resolve } from "path"

// ─── Config ──────────────────────────────────────────────────────────────────

const CHANGELOG_PATH = resolve(process.cwd(), "CHANGELOG.md")

const TYPE_MAP: Record<string, string> = {
  feat: "Added",
  fix: "Fixed",
  perf: "Fixed",
  refactor: "Changed",
  breaking: "Breaking Changes",
  remove: "Removed",
  revert: "Removed",
}

// Types that are interesting enough to appear in the changelog
const INCLUDE_TYPES = new Set(["feat", "fix", "perf", "refactor", "breaking", "remove", "revert"])

// Scopes to suppress (too internal / noisy)
const SUPPRESS_SCOPES = new Set(["deps", "ci", "chore"])

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (flag: string) => {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}
const hasFlag = (flag: string) => args.includes(flag)

const releaseVersion = getArg("--release")
const fromRef = getArg("--from")
const dryRun = hasFlag("--dry-run")

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim()
}

function getLatestTag(): string | null {
  try {
    return run("git describe --tags --abbrev=0")
  } catch {
    return null
  }
}

function getTagDate(tag: string): string {
  try {
    return run(`git log -1 --format=%ai "${tag}"`).split(" ")[0]
  } catch {
    return new Date().toISOString().split("T")[0]
  }
}

function today(): string {
  return new Date().toISOString().split("T")[0]
}

// ─── Commit parsing ───────────────────────────────────────────────────────────

interface Commit {
  hash: string
  date: string
  subject: string
  type: string
  scope: string | null
  breaking: boolean
  description: string
}

function parseCommits(from: string | null, to = "HEAD"): Commit[] {
  const range = from ? `${from}..${to}` : to
  const raw = run(`git log --format="%H|||%ai|||%s" ${range}`)

  if (!raw) return []

  return raw
    .split("\n")
    .map((line) => {
      const [hash, date, subject] = line.split("|||")
      if (!hash || !subject) return null

      // Parse conventional commit: type(scope)!: description
      const match = subject.match(/^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/)
      if (!match) return null

      const [, type, , scope, breaking, description] = match

      if (!INCLUDE_TYPES.has(type)) return null
      if (scope && SUPPRESS_SCOPES.has(scope)) return null

      return {
        hash: hash.substring(0, 8),
        date: date.split(" ")[0],
        subject,
        type,
        scope: scope ?? null,
        breaking: !!breaking,
        description,
      } as Commit
    })
    .filter(Boolean) as Commit[]
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

function groupCommits(commits: Commit[]): Record<string, Commit[]> {
  const groups: Record<string, Commit[]> = {}

  for (const commit of commits) {
    const category = commit.breaking
      ? "Breaking Changes"
      : TYPE_MAP[commit.type] ?? "Changed"

    if (!groups[category]) groups[category] = []
    groups[category].push(commit)
  }

  return groups
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatEntry(commit: Commit): string {
  const scope = commit.scope ? `**${commit.scope}:** ` : ""
  // Capitalize first letter
  const desc = commit.description.charAt(0).toUpperCase() + commit.description.slice(1)
  return `- ${scope}${desc}`
}

const SECTION_ORDER = ["Breaking Changes", "Added", "Fixed", "Changed", "Removed"]

function generateSection(version: string, date: string, commits: Commit[]): string {
  const groups = groupCommits(commits)

  if (Object.keys(groups).length === 0) {
    return `## [${version}] - ${date}\n\n_No significant changes._\n`
  }

  let out = `## [${version}] - ${date}\n\n`

  for (const section of SECTION_ORDER) {
    if (!groups[section]?.length) continue
    out += `### ${section}\n\n`
    for (const commit of groups[section]) {
      out += formatEntry(commit) + "\n"
    }
    out += "\n"
  }

  return out
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const latestTag = getLatestTag()
  const from = fromRef ?? latestTag
  const version = releaseVersion ?? "Unreleased"
  const date = releaseVersion
    ? today()
    : latestTag
    ? `${today()} (since ${latestTag})`
    : today()

  console.log(`\n📋 Generating changelog...`)
  console.log(`   From: ${from ?? "(beginning of history)"}`)
  console.log(`   To:   HEAD`)
  console.log(`   Version: ${version}`)
  console.log(`   Date: ${date}\n`)

  const commits = parseCommits(from)

  if (commits.length === 0) {
    console.log("⚠️  No conventional commits found in range. Nothing to generate.")
    return
  }

  console.log(`✅ Found ${commits.length} relevant commits\n`)

  const section = generateSection(version, releaseVersion ? today() : date, commits)

  if (dryRun || !releaseVersion) {
    console.log("─".repeat(60))
    console.log(section)
    console.log("─".repeat(60))

    if (!releaseVersion) {
      console.log("\n💡 To create a release, run:")
      console.log(`   npx tsx scripts/generate-changelog.ts --release <version>\n`)
    }
    return
  }

  // Insert into CHANGELOG.md after the header
  let changelog = readFileSync(CHANGELOG_PATH, "utf-8")

  const insertMarker = "<!-- CHANGELOG_ENTRIES -->"
  if (changelog.includes(insertMarker)) {
    changelog = changelog.replace(insertMarker, `${insertMarker}\n\n${section}`)
  } else {
    // Fallback: insert after the first H1 + blank line
    changelog = changelog.replace(/^(# .+\n\n)/, `$1${section}\n`)
  }

  writeFileSync(CHANGELOG_PATH, changelog, "utf-8")

  // Create git tag
  console.log(`✅ Inserted v${releaseVersion} entry into CHANGELOG.md`)
  console.log(`\n💡 Next steps:`)
  console.log(`   git add CHANGELOG.md`)
  console.log(`   git commit -m "chore: release v${releaseVersion}"`)
  console.log(`   git tag v${releaseVersion}`)
  console.log(`   git push && git push --tags\n`)
}

main()
