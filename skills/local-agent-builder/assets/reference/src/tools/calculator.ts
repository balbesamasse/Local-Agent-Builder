/**
 * Évaluateur arithmétique — remplacement de `eval()`.
 *
 * Une calculatrice « pratique » écrite avec `new Function(expr)` est une
 * exécution de code arbitraire : le LLM (ou un texte qu'il lit) déciderait du
 * code exécuté. Ce parseur récursif accepte un sous-langage clos :
 * + - * / % ^ ( ), nombres décimaux, pourcentage, et quelques fonctions.
 * Toute autre chose est une erreur, pas une évaluation.
 */

const FUNCS: Record<string, (n: number) => number> = {
  sqrt: (n) => Math.sqrt(n),
  abs: (n) => Math.abs(n),
  round: (n) => Math.round(n),
  floor: (n) => Math.floor(n),
  ceil: (n) => Math.ceil(n),
  sin: (n) => Math.sin(n),
  cos: (n) => Math.cos(n),
  tan: (n) => Math.tan(n),
  ln: (n) => Math.log(n),
  log: (n) => Math.log10(n),
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const MAX_LENGTH = 200;
const MAX_DEPTH = 24;

export interface EvalResult {
  ok: boolean;
  value?: number;
  error?: string;
}

export function evaluateExpression(input: string): EvalResult {
  const expr = input.replace(/,/g, '.').replace(/\s+/g, ' ').trim();
  if (expr === '') return { ok: false, error: 'expression vide' };
  if (expr.length > MAX_LENGTH) return { ok: false, error: `expression trop longue (max ${MAX_LENGTH})` };
  // Pré-filtre : tout caractère hors alphabet autorisé est refusé sans parser.
  if (!/^[\d\s+\-*/%^(),.a-zA-Z]+$/.test(expr)) {
    return { ok: false, error: "caractères non autorisés (utilisez + - * / % ^ ( ) et des nombres)" };
  }

  const tokens = tokenize(expr);
  if (!tokens) return { ok: false, error: 'expression invalide' };

  const parser = new Parser(tokens);
  try {
    const value = parser.parseExpression(0);
    if (!parser.atEnd()) return { ok: false, error: "symbole inattendu après la fin de l'expression" };
    if (!Number.isFinite(value)) return { ok: false, error: 'résultat non fini (division par zéro ?)' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'erreur de calcul' };
  }
}

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string } | { kind: 'ident'; value: string };

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === ' ') {
      i += 1;
      continue;
    }
    if (/[\d.]/.test(ch)) {
      const match = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(expr.slice(i));
      if (!match) return null;
      const num = Number(match[0]);
      if (!Number.isFinite(num)) return null;
      tokens.push({ kind: 'num', value: num });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const match = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(expr.slice(i))!;
      tokens.push({ kind: 'ident', value: match[0].toLowerCase() });
      i += match[0].length;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  /** expression := term (('+'|'-') term)* — depth borne pour bloquer les abus. */
  parseExpression(depth: number): number {
    if (depth > MAX_DEPTH) throw new Error('imbrication trop profonde');
    let value = this.parseTerm(depth);
    for (;;) {
      const op = this.peekOp();
      if (op === '+' || op === '-') {
        this.pos += 1;
        const rhs = this.parseTerm(depth);
        value = op === '+' ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }

  private parseTerm(depth: number): number {
    let value = this.parseUnary(depth);
    for (;;) {
      const op = this.peekOp();
      if (op === '*' || op === '/' || op === '%') {
        this.pos += 1;
        const rhs = this.parseUnary(depth);
        if ((op === '/' || op === '%') && rhs === 0) throw new Error('division par zéro');
        value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
      } else break;
    }
    return value;
  }

  private parseUnary(depth: number): number {
    const op = this.peekOp();
    if (op === '-') {
      this.pos += 1;
      return -this.parseUnary(depth);
    }
    if (op === '+') {
      this.pos += 1;
      return this.parseUnary(depth);
    }
    return this.parsePower(depth);
  }

  private parsePower(depth: number): number {
    const base = this.parseAtom(depth);
    if (this.peekOp() === '^') {
      this.pos += 1;
      // Droite-associatif, et exposant borné : 9^9^9 ne doit pas geler la machine.
      const exponent = this.parsePower(depth + 1);
      if (Math.abs(exponent) > 1000) throw new Error('exposant trop grand');
      return base ** exponent;
    }
    return base;
  }

  private parseAtom(depth: number): number {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('expression incomplète');

    if (token.kind === 'num') {
      this.pos += 1;
      if (this.peekOp() === '%') {
        this.pos += 1;
        return token.value / 100;
      }
      return token.value;
    }

    if (token.kind === 'ident') {
      this.pos += 1;
      const name = token.value;
      if (name in CONSTS) return CONSTS[name]!;
      if (name in FUNCS) {
        if (this.peekOp() !== '(') throw new Error(`fonction ${name} nécessite des parenthèses`);
        this.pos += 1;
        const arg = this.parseExpression(depth + 1);
        if (this.consumeOp(')') === false) throw new Error('parenthèse fermante manquante');
        return FUNCS[name]!(arg);
      }
      throw new Error(`identifiant inconnu : « ${name} »`);
    }

    if (token.kind === 'op' && token.value === '(') {
      this.pos += 1;
      const value = this.parseExpression(depth + 1);
      if (this.consumeOp(')') === false) throw new Error('parenthèse fermante manquante');
      return value;
    }

    throw new Error(`symbole inattendu : « ${token.value} »`);
  }

  private peekOp(): string | null {
    const token = this.tokens[this.pos];
    return token && token.kind === 'op' ? token.value : null;
  }

  private consumeOp(op: string): boolean {
    if (this.peekOp() === op) {
      this.pos += 1;
      return true;
    }
    return false;
  }
}

/** Formatage lisible, sans scientific notation excessive. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}
