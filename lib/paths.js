/**
 * Path derivation for the JSONL session-persistence layout, mirrored from
 * `@deepseek-ai/dsh-session-persistence-jsonl` (its concrete helpers are not
 * named exports, so the cleanup engine reproduces the two pure encoding rules
 * it needs and verifies every path it is about to delete).
 *
 * Layout produced by the backend:
 *
 *   <root>/
 *     --<normalized-cwd>--/        readable project directory, or `_no-cwd/`
 *       <encoded-id>/              session-owned directory
 *         session.v4.jsonl.zstd    one file per format generation
 *         session.lock             POSIX advisory-lock file (absent on Windows)
 *
 * @module dsh-session-cleanup/paths
 */

/** Code units that survive encoding literally. */
const SAFE_CODE_UNIT = /^[A-Za-z0-9._-]$/;

/**
 * Encode an arbitrary string as one safe path segment, injectively over all
 * UTF-16 strings. Safe code units stay literal; everything else (including
 * `~`) becomes `~XXXX`, which also neutralizes `../`, separators and NUL.
 * @param raw - string to encode; must be non-empty.
 * @returns the single escaped path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character !== '~' && SAFE_CODE_UNIT.test(character)) out += character;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Decode one segment produced by {@link encodeSegment}. The inverse lets a
 * deletion verify that a directory really belongs to the session id it is
 * about to remove, instead of trusting a computed path.
 * @param encoded - candidate segment.
 * @returns the decoded string, or undefined when the segment is not a valid encoding.
 */
export function decodeSegment(encoded) {
  let out = '';
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character !== '~') {
      out += character;
      continue;
    }
    const hex = encoded.slice(index + 1, index + 5);
    if (!/^[0-9A-F]{4}$/.test(hex)) return undefined;
    out += String.fromCharCode(Number.parseInt(hex, 16));
    index += 4;
  }
  return out;
}

/**
 * Build the readable project-directory key for a session cwd. Separators
 * (`/`, `\`, `:`) collapse to a single `-`, unsafe code units use the same
 * `~XXXX` escape, the key is wrapped in `--…--` and bounded to 251 characters
 * (separator replacement and truncation are intentionally lossy).
 * @param cwd - the session's project directory.
 * @returns the project directory name under the sessions root.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (character !== '~' && SAFE_CODE_UNIT.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** The project directory for a session with no recorded cwd. */
export const NO_CWD_PROJECT = '_no-cwd';

/**
 * Whether a directory name is a plausible project directory under the root.
 * @param name - one directory name directly under the sessions root.
 * @returns true for the wrapper form or the no-cwd bucket.
 */
export function isProjectDirectoryName(name) {
  return name === NO_CWD_PROJECT || (name.startsWith('--') && name.endsWith('--') && name.length > 4);
}

/**
 * Whether a file name is a session log artifact of some format generation.
 * The backend writes `session.jsonl` for the released v0 root and
 * `session.vN.jsonl` for later generations, each with a `.zstd` suffix when the
 * configured compression is `zstd`.
 * @param name - one file name inside a session directory.
 * @returns true for `session.jsonl`, `session.v4.jsonl`, and their `.zstd` forms.
 */
export function isSessionLogName(name) {
  return /^session(\.v[0-9]+)?\.jsonl(\.zstd)?$/.test(name);
}
