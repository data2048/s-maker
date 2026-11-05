// Static checks for Strudel code before it is run.
//
// Strudel code is JavaScript. It always runs inside a sandboxed iframe (no cookies, no API access),
// so this validator is a second layer of defense, not the only one:
//  - 'strict' mode (code from the LLM agent): any finding is an error and the code is rejected.
//  - 'lenient' mode (code typed by a user): security findings are warnings; only syntax errors block.
import { parse, type Node } from 'acorn';
import { full } from 'acorn-walk';

export type ValidationMode = 'strict' | 'lenient';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export const MAX_CODE_LENGTH = 200_000;
const MAX_AST_NODES = 100_000;

/** Globals that give access to the page, the network, storage or code evaluation. */
const FORBIDDEN_GLOBALS = new Set([
  'window',
  'self',
  'globalThis',
  'global',
  'document',
  'top',
  'parent',
  'frames',
  'opener',
  'location',
  'history',
  'navigator',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'importScripts',
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'queueMicrotask',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'cookieStore',
  'postMessage',
  'open',
  'alert',
  'prompt',
  'confirm',
  'Reflect',
  'Proxy',
  'require',
  'process',
  'module',
  'exports',
  'Deno',
  'Bun',
]);

/** Property names used to escape to Function / prototypes. */
const FORBIDDEN_PROPERTIES = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'caller',
  'callee',
  'getPrototypeOf',
  'setPrototypeOf',
  'defineProperty',
  'defineProperties',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
]);

const FORBIDDEN_NODES: Record<string, string> = {
  ImportExpression: 'Dynamic import() is not allowed',
  ImportDeclaration: 'import statements are not allowed',
  ExportNamedDeclaration: 'export statements are not allowed',
  ExportDefaultDeclaration: 'export statements are not allowed',
  ExportAllDeclaration: 'export statements are not allowed',
  MetaProperty: 'import.meta / new.target are not allowed',
  WithStatement: 'with statements are not allowed',
  ThisExpression: '"this" is not allowed (it can reach the global object)',
};

type AnyNode = Node & Record<string, unknown>;

function lineCol(code: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

export function validateStrudelCode(code: string, mode: ValidationMode = 'lenient'): ValidationResult {
  const issues: ValidationIssue[] = [];
  const securitySeverity = mode === 'strict' ? 'error' : 'warning';

  if (code.length > MAX_CODE_LENGTH) {
    return {
      ok: false,
      issues: [
        {
          severity: 'error',
          message: `Code is too long (max ${MAX_CODE_LENGTH} characters)`,
          line: 1,
          column: 1,
        },
      ],
    };
  }

  let ast: Node;
  try {
    ast = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: false,
    });
  } catch (err) {
    const e = err as SyntaxError & { pos?: number };
    const pos = lineCol(code, e.pos ?? 0);
    const message = e.message.replace(/\s*\(\d+:\d+\)$/, '');
    return { ok: false, issues: [{ severity: 'error', message: `Syntax error: ${message}`, ...pos }] };
  }

  const add = (node: Node, message: string, severity: ValidationIssue['severity'] = securitySeverity) => {
    if (issues.length >= 50) return;
    issues.push({ severity, message, ...lineCol(code, node.start) });
  };

  let count = 0;
  // Identifiers that are property keys / member names, not variable references.
  const nonReferences = new WeakSet<Node>();

  full(ast, (n) => {
    const node = n as AnyNode;
    if (++count > MAX_AST_NODES) return;

    const forbiddenNode = FORBIDDEN_NODES[node.type];
    if (forbiddenNode) add(node, forbiddenNode);

    if (node.type === 'MemberExpression') {
      const prop = node.property as AnyNode;
      if (!node.computed) {
        nonReferences.add(prop);
        if (FORBIDDEN_PROPERTIES.has(prop.name as string))
          add(prop, `Access to ".${prop.name as string}" is not allowed`);
      } else if (prop.type === 'Literal') {
        if (typeof prop.value === 'string' && FORBIDDEN_PROPERTIES.has(prop.value)) {
          add(prop, `Access to "[${JSON.stringify(prop.value)}]" is not allowed`);
        }
      } else {
        // obj[someExpression] could build a forbidden name at runtime ("con" + "structor").
        add(prop, 'Computed property access with a non-literal key is not allowed');
      }
    }

    if (node.type === 'Property' || node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
      // In shorthand { fetch } the key is also the value (a real reference), so it stays checked.
      if (!node.computed && !node.shorthand) nonReferences.add(node.key as Node);
      else add(node.key as Node, 'Computed property keys are not allowed');
    }
    if (node.type === 'LabeledStatement') nonReferences.add(node.label as Node);
    if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') {
      if (node.label) nonReferences.add(node.label as Node);
    }
  });

  if (count > MAX_AST_NODES) {
    return { ok: false, issues: [{ severity: 'error', message: 'Code is too complex', line: 1, column: 1 }] };
  }

  full(ast, (n) => {
    const node = n as AnyNode;
    if (node.type !== 'Identifier' || nonReferences.has(node)) return;
    const name = node.name as string;
    // Checked even for local declarations: scopes are not tracked, so 'function f(window) {}' must not
    // make a later global 'window' look harmless.
    if (FORBIDDEN_GLOBALS.has(name)) add(node, `"${name}" is not available in songs`);
    else if (FORBIDDEN_PROPERTIES.has(name)) add(node, `"${name}" is not allowed`);
  });

  issues.sort((a, b) => a.line - b.line || a.column - b.column);
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}
