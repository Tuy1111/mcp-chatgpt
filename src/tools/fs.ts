import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceRegistry } from '../registry.js';
import { assertRegularFile, isAllowed, isTraversableDir, resolvePath } from '../sandbox.js';
import { fail, guard, okJson } from '../result.js';

/** Listings are capped so one call on a large tree cannot flood the context. */
const MAX_ENTRIES = 500;

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function exists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Writes through a sibling temp file so a crash mid-write leaves the original
 * intact instead of a half-written file.
 */
async function writeAtomic(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    count += 1;
  }
  return count;
}

interface Listing {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size?: number;
}

export function registerFsTools(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    'directory_list',
    {
      title: 'List directory',
      description:
        'Lists workspace entries up to `depth` levels. Blocked and non-allowlisted paths are omitted; symlinks are reported but never followed.',
      inputSchema: {
        workspace: z.string().optional(),
        path: z.string().default('.'),
        depth: z.number().int().min(1).max(5).default(1),
        includeHidden: z.boolean().default(false)
      },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ workspace, path: rel, depth, includeHidden }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const target = await resolvePath(ws, rel, { directory: true });

      const entries: Listing[] = [];
      let truncated = false;

      const walk = async (dirRel: string, dirAbs: string, remaining: number): Promise<void> => {
        const dirents = await readdir(dirAbs, { withFileTypes: true });
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const dirent of dirents) {
          if (entries.length >= MAX_ENTRIES) {
            truncated = true;
            return;
          }
          if (!includeHidden && dirent.name.startsWith('.')) continue;
          const childRel = dirRel === '' ? dirent.name : `${dirRel}/${dirent.name}`;
          const childAbs = path.join(dirAbs, dirent.name);

          if (dirent.isSymbolicLink()) {
            if (isAllowed(ws, childRel) || isTraversableDir(ws, childRel)) {
              entries.push({ path: childRel, type: 'symlink' });
            }
            continue;
          }
          if (dirent.isDirectory()) {
            if (!isTraversableDir(ws, childRel)) continue;
            entries.push({ path: childRel, type: 'dir' });
            if (remaining > 1) await walk(childRel, childAbs, remaining - 1);
            continue;
          }
          if (!dirent.isFile() || !isAllowed(ws, childRel)) continue;
          const info = await lstat(childAbs);
          entries.push({ path: childRel, type: 'file', size: info.size });
        }
      };

      await walk(target.rel, target.abs, depth);
      return okJson({
        workspace: ws.name,
        path: target.rel === '' ? '.' : target.rel,
        entries,
        truncated
      });
    })
  );

  server.registerTool(
    'file_read',
    {
      title: 'Read file',
      description:
        'Reads a UTF-8 file, optionally a 1-based inclusive line range. The returned sha256 always covers the whole file and is the token required by file_apply_patch.',
      inputSchema: {
        workspace: z.string().optional(),
        path: z.string(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional()
      },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ workspace, path: rel, startLine, endLine }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const target = await resolvePath(ws, rel);
      const bytes = await assertRegularFile(target);

      const buf = await readFile(target.abs);
      const hash = sha256(buf);
      if (buf.includes(0)) {
        return fail(
          `BINARY: ${target.rel} contains NUL bytes (${bytes} bytes, sha256 ${hash}); not returning its contents`
        );
      }

      const lines = buf.toString('utf8').split('\n');
      const totalLines = lines.length;
      const from = Math.min(Math.max(startLine ?? 1, 1), totalLines);
      const to = Math.min(Math.max(endLine ?? totalLines, from), totalLines);

      return okJson({
        workspace: ws.name,
        path: target.rel,
        sha256: hash,
        bytes,
        totalLines,
        startLine: from,
        endLine: to,
        content: lines.slice(from - 1, to).join('\n')
      });
    })
  );

  server.registerTool(
    'file_create',
    {
      title: 'Create file',
      description:
        'Writes a new file, creating parent directories. Refuses to clobber an existing file unless `overwrite` is true.',
      inputSchema: {
        workspace: z.string().optional(),
        path: z.string(),
        content: z.string(),
        overwrite: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false }
    },
    guard(async ({ workspace, path: rel, content, overwrite }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const target = await resolvePath(ws, rel, { write: true });

      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > ws.maxFileBytes) {
        return fail(`TOO_LARGE: content is ${bytes} bytes, over the ${ws.maxFileBytes} byte limit`);
      }

      const existed = await exists(target.abs);
      if (existed && !overwrite) {
        const current = sha256(await readFile(target.abs));
        return fail(
          `EXISTS: ${target.rel} already exists (sha256 ${current}); pass overwrite or use file_apply_patch`
        );
      }

      await mkdir(path.dirname(target.abs), { recursive: true });
      await writeAtomic(target.abs, content);
      return okJson({
        workspace: ws.name,
        path: target.rel,
        bytes,
        sha256: sha256(content),
        created: !existed
      });
    })
  );

  server.registerTool(
    'file_apply_patch',
    {
      title: 'Apply patch',
      description:
        'Applies literal text edits under optimistic locking: `expectedSha256` must match the file on disk, and every edit must apply or nothing is written.',
      inputSchema: {
        workspace: z.string().optional(),
        path: z.string(),
        expectedSha256: z.string().min(1),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1),
              newText: z.string(),
              replaceAll: z.boolean().default(false)
            })
          )
          .min(1)
      },
      annotations: { readOnlyHint: false }
    },
    guard(async ({ workspace, path: rel, expectedSha256, edits }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const target = await resolvePath(ws, rel, { write: true });
      await assertRegularFile(target);

      const buf = await readFile(target.abs);
      const actual = sha256(buf);
      if (actual !== expectedSha256.trim().toLowerCase()) {
        return fail(
          `CONFLICT: file changed on disk, sha256 is ${actual}, re-read before patching`
        );
      }
      if (buf.includes(0)) return fail(`BINARY: ${target.rel} contains NUL bytes; refusing to patch`);

      let text = buf.toString('utf8');
      let replacements = 0;
      for (let i = 0; i < edits.length; i += 1) {
        const edit = edits[i]!;
        const count = countOccurrences(text, edit.oldText);
        if (count === 0) return fail(`NO_MATCH: edit ${i + 1} oldText not found`);
        if (count > 1 && !edit.replaceAll) {
          return fail(
            `AMBIGUOUS: edit ${i + 1} oldText matches ${count} times, pass replaceAll or include more context`
          );
        }
        // split/join, not String.replace: `$&` in newText must stay literal.
        text = edit.replaceAll
          ? text.split(edit.oldText).join(edit.newText)
          : text.replace(edit.oldText, () => edit.newText);
        replacements += edit.replaceAll ? count : 1;
      }

      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > ws.maxFileBytes) {
        return fail(`TOO_LARGE: patched file is ${bytes} bytes, over the ${ws.maxFileBytes} byte limit`);
      }

      await writeAtomic(target.abs, text);
      return okJson({
        workspace: ws.name,
        path: target.rel,
        sha256: sha256(text),
        bytes,
        editsApplied: edits.length,
        replacements
      });
    })
  );

  server.registerTool(
    'file_delete',
    {
      title: 'Delete file',
      description: 'Deletes a single regular file and reports its sha256 as it was before removal.',
      inputSchema: {
        workspace: z.string().optional(),
        path: z.string()
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    guard(async ({ workspace, path: rel }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const target = await resolvePath(ws, rel, { write: true });
      const bytes = await assertRegularFile(target);

      const hash = sha256(await readFile(target.abs));
      await unlink(target.abs);
      return okJson({ workspace: ws.name, path: target.rel, deleted: true, sha256: hash, bytes });
    })
  );

  server.registerTool(
    'file_move',
    {
      title: 'Move file',
      description:
        'Renames or moves a path inside the workspace. Both endpoints are sandbox-checked; the destination is never clobbered unless `overwrite` is true.',
      inputSchema: {
        workspace: z.string().optional(),
        from: z.string(),
        to: z.string(),
        overwrite: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    guard(async ({ workspace, from, to, overwrite }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const src = await resolvePath(ws, from, { write: true });
      const dest = await resolvePath(ws, to, { write: true });

      if (!(await exists(src.abs))) return fail(`NOT_FOUND: ${src.rel} does not exist`);
      if (!overwrite && (await exists(dest.abs))) {
        return fail(`EXISTS: ${dest.rel} already exists; pass overwrite to replace it`);
      }

      await mkdir(path.dirname(dest.abs), { recursive: true });
      try {
        await rename(src.abs, dest.abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await copyFile(src.abs, dest.abs);
        await unlink(src.abs);
      }
      return okJson({ workspace: ws.name, from: src.rel, to: dest.rel, moved: true });
    })
  );
}
