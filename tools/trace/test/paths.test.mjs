import test from 'node:test';
import assert from 'node:assert/strict';
import { isInside, normalizePath, ProjectMatcher } from '../lib/paths.mjs';

test('normalizePath: Windows, WSL, macOS and URI forms', () => {
  const cases = [
    ['C:\\Users\\Alice\\proj', 'c:/Users/Alice/proj'],
    ['c:/Users/Alice/proj/', 'c:/Users/Alice/proj'],
    ['C:\\Users\\Alice\\proj\\..\\other\\.\\x', 'c:/Users/Alice/other/x'],
    ['\\\\?\\C:\\Users\\Alice\\proj', 'c:/Users/Alice/proj'],
    ['\\\\?\\UNC\\server\\share\\proj', '//server/share/proj'],
    ['\\\\server\\share\\proj', '//server/share/proj'],
    ['/mnt/c/Users/Alice/proj', 'c:/Users/Alice/proj'],
    ['/mnt/d', 'd:/'],
    ['\\\\wsl$\\Ubuntu\\home\\alice\\proj', '/home/alice/proj'],
    ['\\\\wsl.localhost\\Ubuntu-22.04\\home\\alice\\proj', '/home/alice/proj'],
    ['file:///c%3A/Users/Alice/My%20Proj', 'c:/Users/Alice/My Proj'],
    ['file:///C:/Users/Alice/proj', 'c:/Users/Alice/proj'],
    ['file:///Users/alice/split%20brain/', '/Users/alice/split brain'],
    ['file://server/share/x', '//server/share/x'],
    ['vscode-remote://wsl%2Bubuntu/home/alice/proj', '/home/alice/proj'],
    ['vscode-remote://dev-container%2B7b22/workspaces/proj', '/workspaces/proj'],
    ['/private/var/folders/ab/T/x', '/var/folders/ab/T/x'],
    ['/private/tmp/proj', '/tmp/proj'],
    ['/privateer/x', '/privateer/x'],
    ['/a//b/./c/../d/', '/a/b/d'],
    ['/', '/'],
  ];
  for (const [input, want] of cases) assert.equal(normalizePath(input), want, input);
  assert.equal(normalizePath(''), null);
  assert.equal(normalizePath(null), null);
});

test('isInside respects path segments and case rules', () => {
  assert.ok(isInside('/a/proj', '/a/proj'));
  assert.ok(isInside('/a/proj/src', '/a/proj'));
  assert.ok(!isInside('/a/proj-other', '/a/proj'));
  assert.ok(!isInside('/a/pro', '/a/proj'));
  assert.ok(!isInside('/A/Proj/src', '/a/proj'));
  assert.ok(isInside('/A/Proj/src', '/a/proj', true));
  assert.ok(isInside('c:/USERS/alice/PROJ/x', 'c:/Users/Alice/proj')); // drive paths are always case-insensitive
  assert.ok(isInside('c:/x', 'c:/'));
});

test('ProjectMatcher: host (Windows) root matches WSL, URI and backslash spellings', () => {
  const m = new ProjectMatcher([{ path: 'C:\\Users\\Alice\\Split Brain', kind: 'host', caseInsensitive: true }], { defaultCaseInsensitive: false });
  assert.ok(m.match('C:\\Users\\Alice\\Split Brain'));
  assert.ok(m.match('c:\\users\\alice\\split brain\\apps\\web'));
  assert.ok(m.match('/mnt/c/Users/Alice/Split Brain/src'));
  assert.ok(m.match('file:///c%3A/Users/Alice/Split%20Brain'));
  assert.ok(!m.match('C:\\Users\\Alice\\Split Brain 2'));
  assert.ok(!m.match('/home/alice/Split Brain'));
});

test('ProjectMatcher: macOS /private alias and case-insensitivity', () => {
  const m = new ProjectMatcher([{ path: '/private/var/folders/zz/T/proj', kind: 'main' }], { defaultCaseInsensitive: true });
  assert.ok(m.match('/var/folders/zz/T/proj'));
  assert.ok(m.match('/var/folders/ZZ/t/PROJ/sub'));
  const strict = new ProjectMatcher([{ path: '/home/u/proj', kind: 'main' }], { defaultCaseInsensitive: false });
  assert.ok(!strict.match('/home/u/PROJ'));
  assert.ok(strict.match('/home/u/proj/x'));
});

test('ProjectMatcher: WSL root matches vscode-remote and \\\\wsl$ forms', () => {
  const m = new ProjectMatcher([{ path: '/home/alice/proj', kind: 'host' }], { defaultCaseInsensitive: false });
  assert.ok(m.match('vscode-remote://wsl%2BUbuntu/home/alice/proj'));
  assert.ok(m.match('\\\\wsl.localhost\\Ubuntu\\home\\alice\\proj\\src'));
});

test('ProjectMatcher.isAncestorOfRoot', () => {
  const m = new ProjectMatcher([{ path: '/home/alice/code/proj', kind: 'main' }], { defaultCaseInsensitive: false });
  assert.ok(m.isAncestorOfRoot('/home/alice'));
  assert.ok(m.isAncestorOfRoot('/home/alice/code/'));
  assert.ok(!m.isAncestorOfRoot('/home/alice/code/proj'));
  assert.ok(!m.isAncestorOfRoot('/home/bob'));
  assert.ok(!m.isAncestorOfRoot('/'));
  assert.ok(m.mentionNeedles().includes('/home/alice/code/proj'));
});
