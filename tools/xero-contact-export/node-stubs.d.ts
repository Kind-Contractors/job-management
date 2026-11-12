// Minimal type declarations for the Node.js modules this tool and its tests use.
//
// The repository does not depend on @types/node, and installing a dependency needs approval, so the surface the tool
// actually touches is declared here instead. This file is used only by tsconfig.json in this folder (the type-check);
// it is never bundled or run. It is deliberately small: if the tool starts using another Node API, the type-check
// fails until the API is declared, which is the point.

declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): { update(data: string): { digest(encoding: 'hex'): string } };
  export function randomBytes(size: number): { toString(encoding: 'hex'): string };
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean; mode: number };
  export function lstatSync(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  export function realpathSync(path: string): string;
  export function symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void;
  export function openSync(path: string, flags: string, mode?: number): number;
  export function writeSync(fd: number, data: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function renameSync(from: string, to: string): void;
  export function unlinkSync(path: string): void;
  export function chmodSync(path: string, mode: number): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:path' {
  export function isAbsolute(path: string): boolean;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function join(...paths: string[]): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:child_process' {
  export function spawnSync(
    command: string,
    args: string[],
    options?: { encoding?: 'utf8'; env?: Record<string, string | undefined>; cwd?: string },
  ): { status: number | null; stdout: string; stderr: string };
}

declare module 'node:test' {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
  export function test(name: string, options: { skip?: boolean | string }, fn: () => unknown | Promise<unknown>): void;
  export function beforeEach(fn: () => unknown): void;
  export function afterEach(fn: () => unknown): void;
}

declare module 'node:assert/strict' {
  const assert: {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
    throws(fn: () => unknown, check?: RegExp | ((error: any) => boolean), message?: string): void;
    rejects(fn: () => Promise<unknown>, check?: RegExp | ((error: any) => boolean), message?: string): Promise<void>;
  };
  export default assert;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  execPath: string;
  cwd(): string;
  exit(code?: number): never;
  exitCode: number | string | undefined;
  features: { typescript?: boolean | string };
};
