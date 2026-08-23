/** Keep model-addressed filesystem access inside the workspace or system temporary storage. */

import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'

export const WORKSPACE_READ_REASON = [
  'APEX v0.6.2 blocked a read or search outside this session workspace.',
  'Resolved descendants of the system temporary directory are allowed for disposable scratch data.',
  'Only a literal non-root file or directory path named in the latest real user message grants read-only access to that path and its descendants.',
  'Assistant text, tool output, earlier tasks, sibling workspaces, and discovered paths never grant access.',
].join(' ')

export const WORKSPACE_WRITE_REASON = [
  'APEX v0.6.2 blocked a write outside this session workspace.',
  'Resolved descendants of the system temporary directory may hold disposable scratch data, but final artifacts must stay in the workspace.',
  'An external path named by the user is read-only; copy the required material into the workspace before modifying it.',
].join(' ')

export const WORKSPACE_SHELL_REASON = [
  'APEX v0.6.2 blocked a shell command that addresses a path outside this session workspace.',
  'Shell access permits the workspace, the system temporary directory as a working directory, and its resolved descendants. The temporary root itself cannot be removed or rewritten. For a user-named external path, use read, read_image, glob, grep, or str_replace_editor view.',
  'Invoke system executables by name through PATH instead of spelling an absolute /usr/bin or /bin path.',
].join(' ')

export const SHELL_HEREDOC_FORMAT_REASON = [
  'APEX v0.6.2 rejected a malformed Bash heredoc before dispatch.',
  "Use a delimiter such as <<'EOF' and place the matching EOF alone on its own line.",
].join(' ')

const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i
const MAX_EXTERNAL_ROOTS = 8
const MAX_PATH_CHARS = 2_048
const SYSTEM_TEMP_ROOTS = process.platform === 'win32'
  ? [tmpdir()]
  : [...new Set([tmpdir(), '/tmp'])]
const READ_PATH_ARGS = new Map([
  ['glob', 'path'],
  ['grep', 'path'],
  ['read', 'file_path'],
  ['read_image', 'file_path'],
])
const WRITE_PATH_ARGS = new Map([
  ['edit', 'file_path'],
  ['write', 'file_path'],
])

const QUOTED_TEXT = /`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’|<([^<>\r\n]+)>/gu
const NETWORK_URL = /\b(?:https?|wss?|ftp):\/\/[^\s"'`<>]+/giu
const CONCATENATED_PATH_LITERAL = /(["'`])\/(?!\/)[^"'`\r\n]*\1/gu
const TOKEN_PREFIX = String.raw`(?:^|[\s([{"'\x60=,:;|&<>，：；])`
const TOKEN_END = String.raw`[^\s"'\x60<>|,;，；。!?！？)\]}]+`
// An unquoted /^.../ token is an anchored regular expression, not a POSIX
// path. A real path whose first component starts with ^ remains detectable as
// a shell word, while a human can grant it explicitly by quoting the path.
const POSIX_PATH_TOKEN = new RegExp(`${TOKEN_PREFIX}((?:\\/(?![\\/^]))${TOKEN_END})`, 'gmu')
const WINDOWS_PATH_TOKEN = new RegExp(`${TOKEN_PREFIX}((?:[a-z]:[\\\\/]|\\\\\\\\[^\\\\/\s]+[\\\\/])${TOKEN_END})`, 'gimu')

const SHELL_ESCAPE_PATH = /(?:^|[\\/]|[\s([{"'`=,:;|&<>])\.\.(?:[\\/]|(?=$))/m
const SHELL_FILE_URL = /\bfile:\/\//i
const SHELL_EXTERNAL_VARIABLE = /(?:\$(?:\{)?(?:HOME|OLDPWD|USERPROFILE|HOMEDRIVE|HOMEPATH|TMPDIR|TMP|TEMP)(?:\})?|\$env:(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TMP|TEMP)|%(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TMP|TEMP)%|\[Environment\]::GetFolderPath)/i
const SHELL_UNKNOWN_PATH_VARIABLE = /(?:\$(?!(?:PWD|\{PWD\})(?:[\\/]|\b))(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)|\$env:[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)[\\/]/i
const SHELL_HOME_ALIAS = /(?:^|[\s([{"'`=,:;|&<>])~(?:[A-Za-z0-9._-]+)?(?:[\\/]|(?=$))/m
const SHELL_PREVIOUS_DIRECTORY = /(?:^|[;&|]\s*|\(\s*)cd\s+-\s*(?:$|[;&|)])/im
const SHELL_STREAMS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'])

function isWindowsAbsolute(value) {
  return typeof value === 'string' && WINDOWS_ABSOLUTE.test(value)
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (value.startsWith('/') || isWindowsAbsolute(value))
}

function cleanCandidate(value) {
  return value.trim().replace(/[\s,;，；。!?！？)\]}]+$/u, '')
}

function maskNetworkUrls(text) {
  let masked = text.replace(NETWORK_URL, match => ' '.repeat(match.length))
  CONCATENATED_PATH_LITERAL.lastIndex = 0
  for (const match of text.matchAll(CONCATENATED_PATH_LITERAL)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1
    const prefix = text.slice(lineStart, match.index)
    if (!/\b(?:https?|wss?|ftp):\/\//iu.test(prefix) || !/\+\s*$/u.test(prefix)) continue
    masked = `${masked.slice(0, match.index)}${' '.repeat(match[0].length)}${masked.slice(match.index + match[0].length)}`
  }
  return masked
}

/** Extract literal absolute paths without interpreting URLs or prose as authority. */
export function literalPaths(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const source = maskNetworkUrls(text).replace(
    /<\\?\/[A-Za-z][A-Za-z0-9:-]*\s*>(?:\/[dgimsuvy]*(?![A-Za-z0-9_./\\-]))?/g,
    match => ' '.repeat(match.length),
  )
  const paths = new Set()
  const maskedSpans = []
  QUOTED_TEXT.lastIndex = 0
  for (const match of source.matchAll(QUOTED_TEXT)) {
    const value = cleanCandidate(match.slice(1).find(item => typeof item === 'string') ?? '')
    if (value.length <= MAX_PATH_CHARS && isAbsolutePath(value)) {
      paths.add(value)
      maskedSpans.push([match.index, match.index + match[0].length])
    }
  }
  let unquoted = source
  for (const [start, end] of maskedSpans.reverse()) {
    unquoted = `${unquoted.slice(0, start)}${' '.repeat(end - start)}${unquoted.slice(end)}`
  }
  for (const pattern of [POSIX_PATH_TOKEN, WINDOWS_PATH_TOKEN]) {
    pattern.lastIndex = 0
    for (const match of unquoted.matchAll(pattern)) {
      const value = cleanCandidate(match[1] ?? '')
      if (value.length <= MAX_PATH_CHARS && isAbsolutePath(value)) paths.add(value)
    }
  }
  return [...paths]
}

function latestHumanText(agent) {
  if ((agent?.session?.header?.delegationDepth ?? 0) > 0) return ''
  const message = agent?.session?.events?.findLast(event => (
    event.type === 'user/message' && event.data?.source?.kind === 'user'
  ))
  return Array.isArray(message?.data?.content)
    ? message.data.content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
    : ''
}

function identity(cwd, value) {
  if (typeof cwd !== 'string' || cwd.length === 0 || typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const windows = isWindowsAbsolute(cwd) || isWindowsAbsolute(value)
  const path = windows ? win32 : posix
  const absolute = path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value))
  return { absolute, path, windows }
}

function canonicalExistingAncestor(value) {
  const nativeWindows = process.platform === 'win32'
  if (value.windows !== nativeWindows) return value.absolute
  let cursor = value.absolute
  const suffix = []
  while (true) {
    try {
      const real = realpathSync.native(cursor)
      return value.path.resolve(real, ...suffix)
    } catch {
      const parent = value.path.dirname(cursor)
      if (parent === cursor) return value.absolute
      suffix.unshift(value.path.basename(cursor))
      cursor = parent
    }
  }
}

function comparable(value, windows) {
  return windows ? value.toLowerCase() : value
}

function contains(root, target) {
  if (root.windows !== target.windows) return false
  const rootPath = comparable(canonicalExistingAncestor(root), root.windows)
  const targetPath = comparable(canonicalExistingAncestor(target), target.windows)
  const relative = root.path.relative(rootPath, targetPath)
  return relative.length === 0
    || (relative !== '..' && !relative.startsWith(`..${root.path.sep}`) && !root.path.isAbsolute(relative))
}

function workspaceContains(agent, value) {
  const cwd = agent?.session?.header?.cwd
  const root = identity(cwd, cwd)
  const target = identity(cwd, value)
  return root !== undefined && target !== undefined && contains(root, target)
}

function systemTemporaryContains(agent, value) {
  const cwd = agent?.session?.header?.cwd
  const target = identity(cwd, value)
  if (target === undefined) return false
  return SYSTEM_TEMP_ROOTS.some(value => {
    const root = identity(cwd, value)
    return root !== undefined && contains(root, target) && !contains(target, root)
  })
}

function isSystemTemporaryRoot(agent, value) {
  const cwd = agent?.session?.header?.cwd
  const target = identity(cwd, value)
  if (target === undefined) return false
  return SYSTEM_TEMP_ROOTS.some(value => {
    const root = identity(cwd, value)
    return root !== undefined && contains(root, target) && contains(target, root)
  })
}

function systemTemporaryShellContains(agent, value) {
  return systemTemporaryContains(agent, value) || isSystemTemporaryRoot(agent, value)
}

/** Resolve a model-supplied path only when its canonical ancestor stays in the workspace. */
export function workspacePath(agent, value) {
  const cwd = agent?.session?.header?.cwd
  const target = identity(cwd, value)
  return target !== undefined && workspaceContains(agent, value) ? target.absolute : undefined
}

function isFilesystemRoot(value) {
  const normalized = value.path.normalize(value.absolute)
  return normalized === value.path.parse(normalized).root
}

/** Return only roots literally named by the latest top-level human request. */
export function explicitExternalRoots(agent) {
  const cwd = agent?.session?.header?.cwd
  const workspace = identity(cwd, cwd)
  if (workspace === undefined) return []
  const roots = []
  for (const candidate of literalPaths(latestHumanText(agent))) {
    const root = identity(cwd, candidate)
    if (root === undefined || isFilesystemRoot(root) || contains(workspace, root)) continue
    if (!roots.some(existing => contains(existing, root) && contains(root, existing))) roots.push(root)
    if (roots.length >= MAX_EXTERNAL_ROOTS) break
  }
  return roots
}

function externalReadContains(agent, value) {
  const cwd = agent?.session?.header?.cwd
  const target = identity(cwd, value)
  return target !== undefined && explicitExternalRoots(agent).some(root => contains(root, target))
}

function pathAccess(execution) {
  if (execution?.name === 'str_replace_editor') {
    return {
      kind: execution.arguments?.command === 'view' ? 'read' : 'write',
      value: execution.arguments?.path,
    }
  }
  const readArg = READ_PATH_ARGS.get(execution?.name)
  if (readArg !== undefined) return { kind: 'read', value: execution.arguments?.[readArg] }
  const writeArg = WRITE_PATH_ARGS.get(execution?.name)
  return writeArg === undefined ? undefined : { kind: 'write', value: execution.arguments?.[writeArg] }
}

/** Deny path-bearing filesystem calls outside the workspace/user read grant. */
export function workspacePathDenial(execution) {
  if (typeof execution?.agent?.session?.header?.cwd !== 'string') return undefined
  const access = pathAccess(execution)
  if (access === undefined || access.value === undefined) return undefined
  if (typeof access.value !== 'string' || access.value.length === 0) return WORKSPACE_READ_REASON
  if (workspaceContains(execution.agent, access.value)
    || systemTemporaryContains(execution.agent, access.value)) return undefined
  if (access.kind === 'read' && externalReadContains(execution.agent, access.value)) return undefined
  return access.kind === 'read' ? WORKSPACE_READ_REASON : WORKSPACE_WRITE_REASON
}

function heredocOpeners(line) {
  const openers = []
  let quote
  let escaped = false
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /[\s;&|()]/.test(line[index - 1]))) break
    if (char !== '<' || line[index + 1] !== '<') continue
    if (line[index + 2] === '<') {
      index += 2
      continue
    }
    const prefix = line.slice(0, index)
    if (Math.max(prefix.lastIndexOf('$(('), prefix.lastIndexOf('((')) > prefix.lastIndexOf('))')) {
      index += 1
      continue
    }

    const start = index
    index += 2
    let stripTabs = false
    if (line[index] === '-') {
      stripTabs = true
      index += 1
    }
    while (index < line.length && /[ \t]/.test(line[index])) index += 1

    let delimiter = ''
    let quoted = false
    const delimiterQuote = line[index]
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      quoted = true
      index += 1
      while (index < line.length && line[index] !== delimiterQuote) {
        delimiter += line[index]
        index += 1
      }
      if (line[index] !== delimiterQuote) return { ok: false }
      index += 1
    } else {
      while (index < line.length && !/[\s;&|()<>]/.test(line[index])) {
        delimiter += line[index]
        index += 1
      }
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(delimiter)) return { ok: false }
    openers.push({ delimiter, end: index, quoted, start, stripTabs })
    index -= 1
  }
  return { ok: true, openers }
}

function heredocCommandWords(header, opener) {
  const command = `${header.slice(0, opener.start)} ${header.slice(opener.end)}`
  let quote
  let escaped = false
  let segmentStart = 0
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(')) return []
    if (';&|'.includes(char)) segmentStart = index + 1
  }
  return shellWords(command.slice(segmentStart), false)
}

function literalDataHeredoc(header, opener, openerCount) {
  if (!opener.quoted || openerCount !== 1) return false
  const words = heredocCommandWords(header, opener)
  const commandIndex = words[0] === 'command' ? 1 : 0
  return words[commandIndex] === 'cat' || words[commandIndex] === 'tee'
}

function scriptHeredocLanguage(header, opener, openerCount) {
  if (openerCount !== 1) return undefined
  const words = heredocCommandWords(header, opener)
  const commandIndex = words[0] === 'command' ? 1 : 0
  const command = words[commandIndex] ?? ''
  if (/^(?:node|nodejs)$/.test(command)) return 'javascript'
  if (/^python(?:3(?:\.\d+)?)?$/.test(command)) return 'python'
  return undefined
}

function maskedPythonCode(source) {
  const masked = source.split('')
  let quote = ''
  let triple = false
  let escaped = false
  const blank = (index, length = 1) => {
    for (let offset = 0; offset < length; offset += 1) {
      if (masked[index + offset] !== '\n') masked[index + offset] = ' '
    }
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote.length > 0) {
      blank(index)
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (triple && source.startsWith(quote.repeat(3), index)) {
        blank(index, 3)
        index += 2
        quote = ''
        triple = false
      } else if (!triple && char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') {
        blank(index)
        index += 1
      }
      continue
    }
    if (char !== "'" && char !== '"') continue
    quote = char
    triple = source.startsWith(char.repeat(3), index)
    blank(index, triple ? 3 : 1)
    if (triple) index += 2
  }
  return masked.join('')
}

function maskedJavaScriptCode(source) {
  const masked = source.split('')
  let quote = ''
  let blockComment = false
  let escaped = false
  const blank = (index, length = 1) => {
    for (let offset = 0; offset < length; offset += 1) {
      if (masked[index + offset] !== '\n') masked[index + offset] = ' '
    }
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (blockComment) {
      blank(index)
      if (source.startsWith('*/', index)) {
        blank(index, 2)
        index += 1
        blockComment = false
      }
      continue
    }
    if (quote.length > 0) {
      blank(index)
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (source.startsWith('//', index)) {
      while (index < source.length && source[index] !== '\n') {
        blank(index)
        index += 1
      }
      continue
    }
    if (source.startsWith('/*', index)) {
      blank(index, 2)
      index += 1
      blockComment = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      blank(index)
    }
  }
  return masked.join('')
}

const PYTHON_FILE_OPERATION = /(?:\b(?:open|Path|PurePath|ZipFile|TarFile)\s*|\bpathlib\.(?:Path|PurePath)\s*|\b(?:os|shutil)\.(?:access|chdir|chmod|chown|copy|copy2|copyfile|copytree|exists|lexists|link|listdir|lstat|makedirs|mkdir|move|readlink|remove|removedirs|rename|replace|rmdir|rmtree|samefile|scandir|stat|symlink|truncate|unlink|utime|walk)\s*)\(/g
const JAVASCRIPT_FILE_OPERATION = /(?:\b(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|open|openSync|opendir|opendirSync|readdir|readdirSync|readlink|readlinkSync|realpath|realpathSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|stat|statSync|symlink|symlinkSync|truncate|truncateSync|unlink|unlinkSync)\s*|\b(?:fs|fsp)(?:\.promises)?\.(?:access|appendFile|copyFile|mkdir|mkdtemp|open|opendir|readFile|readdir|readlink|realpath|rename|rm|rmdir|stat|symlink|truncate|unlink|writeFile)\s*|\bpath\.(?:join|resolve)\s*|\bprocess\.chdir\s*)\(/g

function closingCallIndex(masked, openingIndex) {
  let depth = 0
  for (let index = openingIndex; index < masked.length; index += 1) {
    if (masked[index] === '(') depth += 1
    else if (masked[index] === ')' && --depth === 0) return index + 1
  }
  return masked.length
}

function scriptFileOperationText(source, language) {
  const masked = language === 'python' ? maskedPythonCode(source) : maskedJavaScriptCode(source)
  const pattern = language === 'python' ? PYTHON_FILE_OPERATION : JAVASCRIPT_FILE_OPERATION
  pattern.lastIndex = 0
  const calls = []
  for (const match of masked.matchAll(pattern)) {
    const openingIndex = masked.indexOf('(', match.index)
    if (openingIndex === -1) continue
    calls.push(source.slice(match.index, closingCallIndex(masked, openingIndex)))
  }
  return calls.join('\n')
}

function stripScriptComment(line, marker) {
  let quote
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || (marker === '//' && char === '`')) {
      quote = char
      continue
    }
    if (marker === '#' ? char === '#' : line.startsWith('//', index)) {
      return line.slice(0, index)
    }
  }
  return line
}

/** Validate Bash heredocs and retain only shell or interpreter filesystem targets for path inspection. */
export function bashCommandForPathScan(command) {
  if (typeof command !== 'string' || !command.includes('<<')) {
    return { ok: true, command }
  }
  const lines = command.split(/\r?\n/)
  const scanned = [...lines]
  let lineIndex = 0
  while (lineIndex < lines.length) {
    const parsed = heredocOpeners(lines[lineIndex])
    if (!parsed.ok) return { ok: false, reason: SHELL_HEREDOC_FORMAT_REASON }
    if (parsed.openers.length === 0) {
      lineIndex += 1
      continue
    }

    let bodyStart = lineIndex + 1
    for (const opener of parsed.openers) {
      let terminator = -1
      for (let candidate = bodyStart; candidate < lines.length; candidate += 1) {
        const value = opener.stripTabs ? lines[candidate].replace(/^\t+/, '') : lines[candidate]
        if (value === opener.delimiter) {
          terminator = candidate
          break
        }
      }
      if (terminator === -1) return { ok: false, reason: SHELL_HEREDOC_FORMAT_REASON }
      if (literalDataHeredoc(lines[lineIndex], opener, parsed.openers.length)) {
        for (let bodyLine = bodyStart; bodyLine < terminator; bodyLine += 1) scanned[bodyLine] = ''
      } else {
        const language = scriptHeredocLanguage(lines[lineIndex], opener, parsed.openers.length)
        if (language === undefined) {
          bodyStart = terminator + 1
          continue
        }
        if (opener.quoted) {
          const filesystemCalls = scriptFileOperationText(lines.slice(bodyStart, terminator).join('\n'), language)
          for (let bodyLine = bodyStart; bodyLine < terminator; bodyLine += 1) scanned[bodyLine] = ''
          scanned[bodyStart] = filesystemCalls
        } else {
          const commentMarker = language === 'python' ? '#' : '//'
          for (let bodyLine = bodyStart; bodyLine < terminator; bodyLine += 1) {
            scanned[bodyLine] = stripScriptComment(scanned[bodyLine], commentMarker)
          }
        }
      }
      bodyStart = terminator + 1
    }
    lineIndex = bodyStart
  }
  return { ok: true, command: scanned.join('\n') }
}

function shellWords(command, powerShell) {
  const words = []
  let current = ''
  let quote
  let escaped = false
  const escape = powerShell ? '`' : '\\'
  const flush = () => {
    if (current.length > 0) words.push(current)
    current = ''
  }
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === escape && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
    } else if (/\s/.test(char) || ';|&()<>'.includes(char)) {
      flush()
    } else {
      current += char
    }
  }
  flush()
  return words
}

const TEMP_ROOT_DESTRUCTIVE_COMMANDS = new Set([
  'chmod',
  'chown',
  'chgrp',
  'clear-content',
  'move-item',
  'mv',
  'remove-item',
  'rename-item',
  'rm',
  'rmdir',
  'set-content',
  'shred',
  'truncate',
  'unlink',
])

function commandSegments(command) {
  return command.split(/[;&|\r\n()]+/u).filter(Boolean)
}

function commandName(words) {
  let index = 0
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[index])) index += 1
  if (words[index]?.toLowerCase() === 'command') index += 1
  if (words[index]?.toLowerCase() === 'sudo') {
    index += 1
    while (words[index]?.startsWith('-')) index += 1
  }
  return (words[index] ?? '').replace(/^.*[\\/]/u, '').toLowerCase()
}

function isNonExecutingSedSubstitution(word) {
  if (typeof word !== 'string' || word.length < 4 || word[0] !== 's') return false
  const delimiter = word[1]
  if (/[A-Za-z0-9\\\s]/u.test(delimiter)) return false
  const separators = []
  let escaped = false
  for (let index = 2; index < word.length; index += 1) {
    const char = word[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === delimiter) separators.push(index)
    if (separators.length === 2) {
      const flags = word.slice(index + 1)
      return !/[ew]/u.test(flags)
    }
  }
  return false
}

function protectedRootTarget(agent, value) {
  const target = cleanCandidate(value).replace(/[\\/]+$/u, '')
  if (['.', './*', '*', '$PWD', '${PWD}'].includes(target)) return true
  if (isSystemTemporaryRoot(agent, target)) return true
  const wildcardParent = target.match(/^(.*)[\\/](?:\*|\.\*)$/u)?.[1]
  return wildcardParent !== undefined && isSystemTemporaryRoot(agent, wildcardParent)
}

function destructiveProtectedRootCommand(agent, command, powerShell) {
  for (const segment of commandSegments(command)) {
    const words = shellWords(segment, powerShell)
    if (!words.some(word => protectedRootTarget(agent, word))) continue
    const name = commandName(words)
    if (TEMP_ROOT_DESTRUCTIVE_COMMANDS.has(name)) return true
    if (name === 'find' && words.includes('-delete')) return true
  }
  return false
}

function shellPathCandidates(command, powerShell, agent) {
  const words = shellWords(command, powerShell)
  const sedSubstitutions = powerShell ? [] : words.filter(isNonExecutingSedSubstitution)
  const candidates = new Set(literalPaths(command).filter(candidate => (
    !sedSubstitutions.some(program => program.includes(candidate))
  )))
  const cwd = agent?.session?.header?.cwd
  for (const raw of words) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue
    if (!powerShell && raw.startsWith('//')) continue
    const values = raw.includes('=') ? [raw, raw.slice(raw.indexOf('=') + 1)] : [raw]
    for (const item of values) {
      const value = cleanCandidate(item.replace(/^[,:]+/u, ''))
      if (value.length === 0 || SHELL_STREAMS.has(value) || /^nul$/i.test(value)) continue
      if (isAbsolutePath(value) || value.startsWith('.') || /[\\/]/.test(value)) {
        candidates.add(value)
        continue
      }
      const target = identity(cwd, value)
      if (target !== undefined
        && target.windows === (process.platform === 'win32')
        && existsSync(target.absolute)) candidates.add(value)
    }
  }
  return [...candidates]
}

/** Keep shell-addressed paths workspace-local; external grants stay read-tool-only. */
export function workspaceShellDenial(execution) {
  if (!['bash', 'pwsh'].includes(execution?.name)
    || typeof execution?.agent?.session?.header?.cwd !== 'string') return undefined
  const command = execution.arguments?.command
  if (typeof command !== 'string') return undefined
  const inspected = execution.name === 'bash'
    ? bashCommandForPathScan(command)
    : { ok: true, command }
  if (!inspected.ok) return inspected.reason
  const syntax = maskNetworkUrls(inspected.command)
  if (SHELL_FILE_URL.test(inspected.command)
    || SHELL_ESCAPE_PATH.test(syntax)
    || SHELL_EXTERNAL_VARIABLE.test(syntax)
    || SHELL_UNKNOWN_PATH_VARIABLE.test(syntax)
    || SHELL_HOME_ALIAS.test(syntax)
    || SHELL_PREVIOUS_DIRECTORY.test(syntax)) return WORKSPACE_SHELL_REASON
  const powerShell = execution.name === 'pwsh'
  if (destructiveProtectedRootCommand(execution.agent, inspected.command, powerShell)) {
    return WORKSPACE_SHELL_REASON
  }
  return shellPathCandidates(inspected.command, powerShell, execution.agent)
    .some(candidate => !SHELL_STREAMS.has(candidate) && !/^nul$/i.test(candidate)
      && !workspaceContains(execution.agent, candidate)
      && !systemTemporaryShellContains(execution.agent, candidate))
    ? WORKSPACE_SHELL_REASON
    : undefined
}
