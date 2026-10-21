#!/usr/bin/env node
/**
 * NOVA Documentation Linter & CI/CD Freshness Gate
 *
 * Enforces documentation integrity, validates links, guards against stale/deprecated
 * terminology, verifies code block syntax, prevents orphaned documentation,
 * and ensures ADR metadata compliance.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

interface LintIssue {
  file: string;
  line: number;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

const ISSUES: LintIssue[] = [];
let TOTAL_FILES_CHECKED = 0;
let TOTAL_LINKS_CHECKED = 0;

// ============================================================================
// LINTER CONFIGURATION & PROHIBITED STALE PATTERNS
// ============================================================================

const STALE_PATTERNS = [
  {
    regex: /\b(?:TODO|FIXME|TBD|LOREM IPSUM)\b/i,
    rule: 'no-placeholder-text',
    message: 'Documentation contains unresolved placeholder or draft markers (TODO/FIXME/TBD/Lorem Ipsum).',
    severity: 'error' as const,
  },
  {
    regex: /\b(?:17\s+(?:unit\s+and\s+integration\s+)?tests|17\s+tests\s+passing)\b/i,
    rule: 'stale-test-count',
    message: 'Found stale reference to 17 tests. The verified test suite has 23 passing tests.',
    severity: 'error' as const,
  },
  {
    regex: /\b(?:requires\s+redis|requires\s+bullmq|needs\s+redis)\b/i,
    rule: 'stale-queue-dependency',
    message: 'BroccoliQueue is 100% native and in-process. Do not claim Redis or BullMQ is required.',
    severity: 'error' as const,
  },
  {
    regex: /\b159\s+migrations\s+needed\b/i,
    rule: 'stale-supabase-baggage',
    message: 'Supabase migrations have been distilled into a single idempotent schema.sql.',
    severity: 'error' as const,
  },
  {
    regex: /\b(?:recommend(?:s|ing)?\s+(?:to\s+)?embed\s+nova|instruct(?:s|ing)?\s+to\s+embed\s+nova|embed\s+nova\s+(?:directly\s+)?in-process\s+in\s+your\s+app)\b/i,
    rule: 'prohibited-product-embedding',
    message: 'NOVA is strictly an autonomous out-of-process substrate daemon. Never instruct or recommend embedding NOVA in-process inside another product.',
    severity: 'error' as const,
  },
  {
    regex: /\b(?:nova\s+is\s+a\s+product\s+layer|nova\s+provides\s+client-side\s+ui\s+widgets?|nova\s+acts\s+as\s+a\s+user\s+product)\b/i,
    rule: 'scope-creep-product-layer',
    message: 'NOVA must never be described as a user-facing product layer or UI widget engine. It is an autonomous infrastructure substrate.',
    severity: 'error' as const,
  },
];

const VALID_CODE_LANGUAGES = new Set([
  'bash', 'sh', 'zsh', 'shell',
  'typescript', 'ts',
  'javascript', 'js', 'mjs', 'cjs',
  'json', 'jsonc',
  'yaml', 'yml',
  'sql',
  'python', 'py',
  'http',
  'text', 'txt',
  'mermaid',
  'diff',
  'dockerfile',
  'ini',
  'markdown', 'md',
]);

// ============================================================================
// FILE TRAVERSAL
// ============================================================================

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', '.broccolidb', 'dist'].includes(entry.name)) {
        continue;
      }
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ============================================================================
// ANCHOR EXTRACTION & NORMALIZATION
// ============================================================================

function extractAnchors(content: string): Set<string> {
  const anchors = new Set<string>();

  // 1. Explicit HTML anchors: <a id="foo"></a> or <a name="foo">
  const htmlAnchorRegex = /<a\s+(?:id|name)=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = htmlAnchorRegex.exec(content)) !== null) {
    anchors.add(match[1].toLowerCase());
  }

  // 2. Markdown headings: # Heading Text -> heading-text
  const lines = content.split('\n');
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[1].trim();
      const clean = headingText.toLowerCase().replace(/<[^>]+>/g, '');
      
      // Variant 1: Collapse multiple spaces to single dash
      const slug1 = clean.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
      anchors.add(slug1);

      // Variant 1b: Drop symbols and turn every space into a hyphen (standard GFM)
      const slug1b = clean.replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-');
      anchors.add(slug1b);

      // Variant 2: Replace symbols with hyphens, preserve multi-hyphens
      const slug2 = clean.replace(/[^\w-]/g, '-');
      anchors.add(slug2);

      // Variant 3: Collapsed hyphens
      const slug3 = slug2.replace(/-+/g, '-').replace(/^-|-$/g, '');
      anchors.add(slug3);
    }
  }

  return anchors;
}

// ============================================================================
// DOCUMENT LINTING ENGINE
// ============================================================================

function lintMarkdownFile(filePath: string): void {
  TOTAL_FILES_CHECKED++;
  const relativePath = path.relative(REPO_ROOT, filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const fileAnchors = extractAnchors(content);

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockStartLine = 0;
  let h1Count = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Check code blocks
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockStartLine = lineNum;
        codeBlockLang = line.trim().slice(3).trim().split(/\s+/)[0];
        if (codeBlockLang && !VALID_CODE_LANGUAGES.has(codeBlockLang.toLowerCase())) {
          ISSUES.push({
            file: relativePath,
            line: lineNum,
            rule: 'invalid-code-language',
            message: `Unknown code block language tag: "${codeBlockLang}". Use a supported tag (ts, bash, json, yaml, sql, python, mermaid, ini, diff, text).`,
            severity: 'warning',
          });
        }
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
      }
      continue;
    }

    // Skip linting inside code blocks for natural prose checks
    if (!inCodeBlock) {
      // Rule: Check for H1 headings
      if (/^#\s+[^\s]/.test(line)) {
        h1Count++;
        if (h1Count > 1) {
          ISSUES.push({
            file: relativePath,
            line: lineNum,
            rule: 'multiple-h1-headings',
            message: `Document has multiple top-level # (H1) headings. Use exactly one H1 title and use ## (H2) or ### (H3) for subheadings.`,
            severity: 'warning',
          });
        }
      }

      // Rule: Check for stale / forbidden terminology
      for (const pattern of STALE_PATTERNS) {
        if (pattern.regex.test(line)) {
          ISSUES.push({
            file: relativePath,
            line: lineNum,
            rule: pattern.rule,
            message: pattern.message,
            severity: pattern.severity,
          });
        }
      }

      // Rule: Markdown Link Integrity
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      let linkMatch: RegExpExecArray | null;
      while ((linkMatch = linkRegex.exec(line)) !== null) {
        const rawTarget = linkMatch[2].trim();
        TOTAL_LINKS_CHECKED++;

        // Ignore external http/https/mailto URLs
        if (/^(?:https?:\/\/|mailto:)/i.test(rawTarget)) {
          continue;
        }

        // Local fragment anchor: e.g. #quickstart
        if (rawTarget.startsWith('#')) {
          const anchor = rawTarget.slice(1).toLowerCase();
          const decoded = decodeURIComponent(anchor);
          if (!fileAnchors.has(anchor) && !fileAnchors.has(decoded)) {
            ISSUES.push({
              file: relativePath,
              line: lineNum,
              rule: 'broken-local-anchor',
              message: `Anchor link "${rawTarget}" does not match any heading or <a id="..."> anchor in this document.`,
              severity: 'error',
            });
          }
          continue;
        }

        // file:/// absolute local links
        if (rawTarget.startsWith('file:///')) {
          const cleanPath = rawTarget.replace('file://', '');
          const [filePathOnly] = cleanPath.split('#');
          if (!fs.existsSync(filePathOnly)) {
            ISSUES.push({
              file: relativePath,
              line: lineNum,
              rule: 'broken-file-link',
              message: `Target file "${filePathOnly}" does not exist on disk.`,
              severity: 'error',
            });
          }
          continue;
        }

        // Relative path links: e.g. ./setup/local-development.md or ../CONTRIBUTING.md
        const [relPathOnly] = rawTarget.split('#');
        const resolvedPath = path.resolve(path.dirname(filePath), relPathOnly);
        if (!fs.existsSync(resolvedPath)) {
          ISSUES.push({
            file: relativePath,
            line: lineNum,
            rule: 'broken-relative-link',
            message: `Relative target "${rawTarget}" resolved to non-existent path: "${path.relative(REPO_ROOT, resolvedPath)}".`,
            severity: 'error',
          });
        }
      }
    }
  }

  // Check unclosed code block
  if (inCodeBlock) {
    ISSUES.push({
      file: relativePath,
      line: codeBlockStartLine,
      rule: 'unclosed-code-block',
      message: 'Code block opened with ``` was never closed before EOF.',
      severity: 'error',
    });
  }

  // Specialized check: ADR Structure validation for docs/adrs/ADR-*.md
  if (relativePath.includes('docs/adrs/ADR-')) {
    validateAdrStructure(relativePath, content);
  }
}

function validateAdrStructure(file: string, content: string): void {
  const requiredSections = ['Status', 'Context', 'Decision', 'Consequences'];
  for (const section of requiredSections) {
    const sectionRegex = new RegExp(`^#{2,3}\\s+${section}`, 'm');
    if (!sectionRegex.test(content)) {
      ISSUES.push({
        file,
        line: 1,
        rule: 'adr-missing-section',
        message: `ADR is missing mandatory section: "${section}". Architectural Decision Records require Status, Context, Decision, Consequences.`,
        severity: 'error',
      });
    }
  }
}

// ============================================================================
// ORPHANED DOCUMENT CHECK
// ============================================================================

function checkOrphanedDocs(allFiles: string[]): void {
  const docsFiles = allFiles
    .map(f => path.relative(REPO_ROOT, f))
    .filter(f => f.startsWith('docs/') && !f.endsWith('docs/README.md'));

  // Concatenate all index files to find references
  const indexFiles = [
    path.join(REPO_ROOT, 'README.md'),
    path.join(REPO_ROOT, 'docs', 'README.md'),
    ...allFiles.filter(f => f.endsWith('README.md')),
  ];

  const aggregatedIndexes = indexFiles
    .filter(f => fs.existsSync(f))
    .map(f => fs.readFileSync(f, 'utf-8'))
    .join('\n');

  for (const doc of docsFiles) {
    const baseName = path.basename(doc);
    if (!aggregatedIndexes.includes(baseName)) {
      ISSUES.push({
        file: doc,
        line: 1,
        rule: 'orphaned-doc',
        message: `Document "${doc}" is not referenced in any README or Knowledge Base index. Add a link to preserve navigation discoverability.`,
        severity: 'warning',
      });
    }
  }
}

// ============================================================================
// MAINTAINER GOVERNANCE VALIDATION
// ============================================================================

const REQUIRED_MAINTAINER_DOCS = [
  'MAINTAINERS.md',
  'docs/maintainers/README.md',
  'docs/maintainers/anti-scope-creep-policy.md',
  'docs/maintainers/release-engineering.md',
  'docs/maintainers/code-review-and-merging.md',
  'docs/maintainers/security-vulnerability-handling.md',
  'docs/maintainers/triaging-and-support.md',
  'docs/maintainers/database-migration-policy.md',
  'docs/maintainers/onboarding-and-offboarding.md',
  'docs/maintainers/architecture-governance.md',
];

const REQUIRED_GOVERNANCE_SECTIONS = [
  'Core Principles',
  'Maintainer Roster',
  'Roles & Responsibilities',
  'Decision-Making & Consensus Model',
  'Review & Operational SLAs',
  'Path to Maintainership',
  'Maintainer Standards & Invariants',
  'Inactivity & Emeritus Transition',
];

function validateMaintainerGovernance(): void {
  // 1. Check all required maintainer documents exist
  for (const docRel of REQUIRED_MAINTAINER_DOCS) {
    const fullPath = path.join(REPO_ROOT, docRel);
    if (!fs.existsSync(fullPath)) {
      ISSUES.push({
        file: docRel,
        line: 1,
        rule: 'missing-maintainer-doc',
        message: `Mandatory maintainer operations document "${docRel}" is missing. Strict maintainer governance requires this document.`,
        severity: 'error',
      });
    }
  }

  // 2. Validate MAINTAINERS.md sections
  const maintainersFile = path.join(REPO_ROOT, 'MAINTAINERS.md');
  if (fs.existsSync(maintainersFile)) {
    const content = fs.readFileSync(maintainersFile, 'utf-8');
    for (const section of REQUIRED_GOVERNANCE_SECTIONS) {
      const sectionRegex = new RegExp(`^#{2,3}\\s+${section}`, 'm');
      if (!sectionRegex.test(content)) {
        ISSUES.push({
          file: 'MAINTAINERS.md',
          line: 1,
          rule: 'maintainers-missing-section',
          message: `MAINTAINERS.md is missing mandatory governance section: "## ${section}".`,
          severity: 'error',
        });
      }
    }
  }
}

// ============================================================================
// CLI RUNNER & FORMATTED REPORTING
// ============================================================================

function main(): void {
  console.log('\n======================================================================');
  console.log('   🔍 NOVA DOCUMENTATION LINTER & CI/CD GATE');
  console.log('======================================================================\n');

  const files = findMarkdownFiles(REPO_ROOT);
  for (const file of files) {
    lintMarkdownFile(file);
  }

  checkOrphanedDocs(files);
  validateMaintainerGovernance();

  const errors = ISSUES.filter(i => i.severity === 'error');
  const warnings = ISSUES.filter(i => i.severity === 'warning');

  console.log(`📁 Scanned:       ${TOTAL_FILES_CHECKED} Markdown documents`);
  console.log(`🔗 Links Tested:  ${TOTAL_LINKS_CHECKED} internal links & anchors`);
  console.log(`⚠️  Warnings:      ${warnings.length}`);
  console.log(`❌ Errors:        ${errors.length}\n`);

  if (ISSUES.length > 0) {
    console.log('----------------------------------------------------------------------');
    console.log('DETAILED DIAGNOSTIC FINDINGS:');
    console.log('----------------------------------------------------------------------\n');

    for (const issue of ISSUES) {
      const prefix = issue.severity === 'error' ? '❌ [ERROR]' : '⚠️  [WARN]';
      console.log(`${prefix} ${issue.file}:${issue.line} (${issue.rule})`);
      console.log(`   └─ ${issue.message}\n`);
    }
  }

  if (errors.length > 0) {
    console.error(`💥 Documentation gate failed with ${errors.length} error(s). Please resolve before committing.\n`);
    process.exit(1);
  }

  console.log('✅ Documentation integrity verified: Zero broken links, zero stale data, all ADRs & maintainer docs compliant.\n');
  process.exit(0);
}

main();

