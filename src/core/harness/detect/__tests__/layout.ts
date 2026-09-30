/**
 * Fabricate system-install layouts in a temp directory for the detection
 * tests (ADR-082 research §1-2). Nothing written here is ever executed: a
 * "native" file is just the magic bytes, a script is just text.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** A file that starts like a PE executable. */
export function writeNative(file: string, extra = ''): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.from(extra)]))
  return file
}

export function writeText(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

export function writePackage(
  dir: string,
  json: Record<string, unknown>,
  files: Record<string, 'native' | string> = {}
): string {
  writeText(path.join(dir, 'package.json'), JSON.stringify(json))
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'))
    if (content === 'native') writeNative(file)
    else writeText(file, content)
  }
  return dir
}

/** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
export function linkDir(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/** The npm cmd-shim `.cmd` for a target inside `node_modules` (relative, backslashes). */
export function cmdShim(rel: string, viaNode: boolean): string {
  const target = rel.replace(/\//g, '\\')
  if (!viaNode) {
    return `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${target}"   %*\r\n`
  }
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    ''
  ].join('\r\n')
}

/** The npm cmd-shim `sh` shim for a Node target. */
export function shShim(rel: string): string {
  return [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    '',
    'if [ -x "$basedir/node" ]; then',
    `  exec "$basedir/node"  "$basedir/${rel}" "$@"`,
    'else ',
    `  exec node  "$basedir/${rel}" "$@"`,
    'fi',
    ''
  ].join('\n')
}

/** The ~500-byte `sh` placeholder npm leaves at `bin/claude.exe` when postinstall did not run. */
export const PLACEHOLDER_STUB =
  'echo "Error: claude native binary not installed." >&2\necho "Either postinstall did not run" >&2\nexit 1\n'
