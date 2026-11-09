import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sensitivePath(filename) {
  const parts = filename.replaceAll('\\', '/').toLowerCase().split('/');
  const name = parts.at(-1);
  return (name.startsWith('.env') && name !== '.env.example') || name === '.npmrc' || name === 'auth.json'
    || /^(credentials|secrets).*\.json$/.test(name) || /\.(pem|key)$/.test(name) || parts.includes('.codex');
}

export function findSecrets(text, filename) {
  const findings = [];
  const patterns = [
    [/\bsk-[A-Za-z0-9_-]{28,}\b/, '疑似 API Key'],
    [/\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, '疑似 GitHub Token'],
    [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, '私钥内容'],
  ];
  const isEnv = path.basename(filename).startsWith('.env');
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [pattern, reason] of patterns) if (pattern.test(line)) findings.push({ file: filename, line: index + 1, reason });
    if (isEnv && /^\s*(?:OPENAI_API_KEY|DEEPSEEK_API_KEY)\s*=\s*(?!\s*(?:#|$|""\s*$|''\s*$))\S/.test(line)) {
      findings.push({ file: filename, line: index + 1, reason: '环境示例含非空密钥' });
    }
  });
  return findings;
}

function git(args) { return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); }

export function checkProject(staged = false) {
  const probe = git(['rev-parse', '--show-toplevel']);
  const hasGit = probe.status === 0;
  if (staged && !hasGit) throw new Error('当前不是有效 Git 仓库，无法检查暂存区。请先在项目目录建立仓库。');
  let files;
  let top;
  if (hasGit) {
    top = probe.stdout.trim();
    const result = git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--', '.']
      : ['ls-files', '--cached', '--others', '--exclude-standard', '--full-name', '-z', '--', '.']);
    if (result.status !== 0) throw new Error('无法读取 Git 文件清单，检查未完成。');
    files = [...new Set(result.stdout.split('\0').filter(Boolean))].map(repoPath => ({ repoPath, absolute: path.resolve(top, repoPath) }));
  } else {
    files = [];
    function walk(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (['.git', 'node_modules', '.codex', 'logs'].includes(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && !sensitivePath(path.relative(ROOT, absolute))) files.push({ absolute });
      }
    }
    walk(ROOT);
  }
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    const relative = path.relative(ROOT, file.absolute);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    if (sensitivePath(relative)) { findings.push({ file: relative, reason: '敏感文件已被 Git 纳入提交范围' }); continue; }
    if (!/\.(mjs|js|cjs|json|md|html|css|ps1|txt|ya?ml)$/i.test(relative) && path.basename(relative) !== '.env.example') continue;
    let content;
    if (staged) {
      const blob = git(['show', ':' + file.repoPath]);
      if (blob.status !== 0) throw new Error('无法读取暂存文件，检查未完成：' + relative);
      content = blob.stdout;
    } else content = readFileSync(file.absolute, 'utf8');
    scanned += 1;
    findings.push(...findSecrets(content, relative));
  }
  return { scanned, findings, hasGit, staged };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkProject(process.argv.includes('--staged'));
    if (result.findings.length) {
      console.error('检查未通过。以下仅列位置，不显示密钥内容：');
      for (const hit of result.findings) console.error(`${hit.file}${hit.line ? ':' + hit.line : ''} — ${hit.reason}`);
      process.exitCode = 1;
    } else console.log(`检查通过：${result.scanned} 个文本文件中未检出所支持的密钥特征。`);
    if (!result.hasGit) console.log('当前不是有效 Git 仓库：此次只检查工作文件，未检查 Git 暂存区或历史。');
    console.log('此检查不覆盖所有秘密格式、图片/压缩包或提交历史，也不能替代人工复核。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
