// Fork-only validation support, deliberately excluded from the product fix branch.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

assert.equal(process.platform, 'win32', 'Native Windows validation is required');
const root = process.cwd();
const evidence = resolve(root, '.build/claude-proxy-validation');
mkdirSync(evidence, { recursive: true });
const sourcePath = 'src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts';
const testPath = 'src/vs/platform/agentHost/test/node/claudeSdkOptions.test.ts';
const outputPath = resolve(root, 'out/vs/platform/agentHost/node/claude/claudeSdkOptions.js');
const baselineCommit = '86db3b69224f75a786f815684bc96fc0eb5d9300';
const fixedCommit = '99c291bf4ef17e26aae50edbd47888a5ba3baab6';
const sha = file => createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex');
const facts = {
  platform: process.platform, node: process.version, arch: process.arch,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  fixedCommit: execFileSync('git', ['rev-parse', fixedCommit], { encoding: 'utf8' }).trim(),
  baselineCommit, sourceSha256: sha(sourcePath), testSha256: sha(testPath),
};
writeFileSync(resolve(evidence, 'candidate.json'), JSON.stringify(facts, null, 2));

function runTests(name, args) {
  const result = spawnSync(process.execPath, ['test/unit/node/index.js', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(resolve(evidence, `${name}.log`), log);
  console.log(log);
  assert.ok(!result.error, result.error?.message);
  return { status: result.status, text: log.replace(/\x1b\[[0-9;]*m/g, '') };
}

const mode = process.argv[2];
if (mode === 'baseline') {
  const fixedOutput = readFileSync(outputPath);
  const { transpileFile } = await import(pathToFileURL(resolve(root, 'build/next/transpile.ts')));
  const temporarySource = resolve(evidence, 'baseline.ts');
  writeFileSync(temporarySource, execFileSync('git', ['show', `${baselineCommit}:${sourcePath}`]));
  try {
    await transpileFile(temporarySource, outputPath);
    const result = runTests('baseline', ['--run', testPath]);
    assert.notEqual(result.status, 0, 'Unfixed helper must fail the new regressions');
    const failures = result.text.match(/\n\s+[1-9]\d* failing[^\n]*\n([\s\S]*)/);
    assert.ok(failures, 'Expected Mocha failure details');
    assert.match(failures[1], /preserves OS variables and tool preferences in proxy mode/);
    assert.match(failures[1], /OS and tool variables reach a real subprocess/);
    writeFileSync(resolve(evidence, 'baseline-result.json'), JSON.stringify({ expectedFailure: true, exitCode: result.status }));
  } finally {
    writeFileSync(outputPath, fixedOutput);
  }
} else if (mode === 'candidate') {
  const result = runTests('candidate', ['--runGlob', '**/agentHost/test/node/claude{SdkOptions,ModelSelection,ModelId,TransportMode,AgentSdkService}.test.js']);
  assert.equal(result.status, 0, 'Fixed native Windows tests must pass');
  assert.match(result.text, /\b87 passing\b/, 'All five selected test files must execute');
  for (const suite of ['claudeSdkOptions', 'claudeModelSelection', 'parseClaudeModelId', 'claudeTransportMode', 'ClaudeAgentSdkService']) {
    assert.ok(result.text.includes(suite), `Missing suite: ${suite}`);
  }
  writeFileSync(resolve(evidence, 'candidate-result.json'), JSON.stringify({ passed: true, exitCode: result.status }));
} else if (mode === 'smoke') {
  globalThis._VSCODE_PRODUCT_JSON = JSON.parse(readFileSync('product.json', 'utf8'));
  globalThis._VSCODE_PACKAGE_JSON = JSON.parse(readFileSync('package.json', 'utf8'));
  globalThis._VSCODE_FILE_ROOT = pathToFileURL(resolve(root, 'out')).href;
  const { buildSubprocessEnv } = await import(pathToFileURL(outputPath));
  const parent = { ...process.env };
  process.env.AnThRoPiC_ApI_KeY = 'synthetic-validation-key';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1';
  try {
    const proxy = buildSubprocessEnv();
    const native = buildSubprocessEnv(false);
    assert.equal(Object.keys(proxy).some(key => key.toUpperCase() === 'ANTHROPIC_API_KEY'), false);
    assert.equal(proxy.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(proxy.CLAUDE_CODE_USE_POWERSHELL_TOOL, '1');
    assert.ok(Object.keys(native).some(key => key.toUpperCase() === 'ANTHROPIC_API_KEY'));
    const keys = ['PATHEXT', 'ComSpec', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'TEMP'];
    const present = Object.fromEntries(keys.map(key => [key, Object.entries(proxy).some(([name, value]) => name.toUpperCase() === key.toUpperCase() && Boolean(value))]));
    assert.ok(Object.values(present).every(Boolean), 'Windows base variables must survive');
    const command = "$ErrorActionPreference='Stop'; git --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; cmd /d /c echo windows-command-ok; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $env:PATHEXT -or -not $env:APPDATA -or -not $env:ComSpec) { exit 2 }; if ($env:ANTHROPIC_API_KEY -or $env:CLAUDE_CODE_USE_BEDROCK) { exit 3 }; Write-Output 'proxy-tool-environment-ok'";
    const child = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      env: proxy, encoding: 'utf8', timeout: 30000,
    });
    writeFileSync(resolve(evidence, 'powershell-smoke.log'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    console.log(child.stdout);
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    assert.match(child.stdout, /windows-command-ok/);
    assert.match(child.stdout, /proxy-tool-environment-ok/);
    writeFileSync(resolve(evidence, 'smoke-result.json'), JSON.stringify({ passed: true, platform: process.platform, present, personalCredentialsFiltered: true, nativeCredentialsPreserved: true }));
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, parent);
  }
} else {
  throw new Error('Expected baseline, candidate or smoke');
}
