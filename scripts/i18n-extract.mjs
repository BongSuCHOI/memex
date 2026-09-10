#!/usr/bin/env node
/**
 * Web UI i18n 추출기·린트 (#109, 0.7.0 lane-0 · 설계 §8.1 · §8.2).
 *
 * 저장소에 이미 있는 `typescript` devDependency의 파서로 AST를 훑는다. **정규식 스캐너는
 * 쓰지 않는다** — `ui.mjs:2`의 `/[&<>"']/g` 같은 정규식 리터럴이 따옴표 상태를 깨뜨려
 * 같은 파일에서 123개 중 14개만 잡히는 것을 실측했다. 주석은 AST가 자동으로 제외한다.
 *
 * 모드
 *   (기본)            파일:줄  종류  텍스트 — 이관 작업용 인벤토리. 종료 코드 0.
 *   --json            같은 목록을 텍스트별로 묶어 JSON으로. `uses`가 common.* 승격 후보를 드러낸다.
 *   --stub <ns>       대상 파일의 리터럴을 i18n/<ns>/ko.mjs 초안으로 찍는다(키는 TODO.<n>).
 *   --html            index.html의 텍스트 노드·속성을 따로 센다(JS 파서 대상 외).
 *   --lint            ko 사전 밖의 **아직 이관되지 않은 파일 목록을 제외한** 한글 리터럴. 1건이면 exit 1.
 *   --keys            t()/tHtml()/tn() 및 ui/lib의 new HttpError({key}) 키를 수확해 사전과 대조. 불일치면 exit 1.
 *   --file <path>     대상 파일을 하나로 한정(다른 모드와 함께 쓴다).
 *
 * `--lint`와 `--keys`는 ui/test/i18n.test.cjs가 이 모듈을 require해서 같은 함수로 검사한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const CODE_EXT = new Set(['.mjs', '.cjs', '.js']);

export const DEFAULT_ROOTS = ['ui/lib', 'ui/public', 'ui/server.cjs'];

/**
 * 한글이 허용되는 경로. **파일 경로만** 둔다 — "이 문자열 하나만 예외" 항목은 한 번 열면
 * 계속 늘어난다. 예외를 모듈 경계에 가두는 것이 이 설계의 핵심이다.
 */
export const ALLOW = [
  /^ui\/public\/i18n\/[^/]+\/ko\.mjs$/,   // 사전 본체
  /^ui\/public\/i18n\/doc-anchors\.mjs$/, // 한국어 문서 앵커 16개 (§6.4)
  /^ui\/public\/i18n\/endonyms\.mjs$/,    // '한국어' endonym (§7.1)
];

/**
 * **아직 이관되지 않은 파일** (0.7.0 L1~L4가 지워 나간다).
 *
 * lane-0은 토대만 만들고 문자열을 옮기지 않으므로 이 목록 없이는 게이트가 1,600건으로
 * 실패한다. 목록의 의미는 "여기 한글이 남아 있는 것은 **예정된 미이관**"이고, 레인이 파일을
 * 끝내면 그 줄을 지운다. 목록에 있는 파일에 한글이 **하나도 없으면** 검사가 실패해
 * (`stale`) 줄을 지우도록 강제한다 — 목록이 조용히 남아 가림막이 되는 것을 막는다.
 */
export const PENDING_MIGRATION = [
  // **비었다.** 네 레인이 모두 자기 파일을 비웠다: L1(ui/lib · 셸 · 포맷터 · 배지 · 오류),
  // L2(상세 · 관리), L3(페이지 · 활동), L4(도움말 · 안내). 이제 `ALLOW`의 경로 3개 밖에서
  // 한글 리터럴이 하나라도 나오면 그것은 **예정된 미이관이 아니라 회귀**다.
];

/**
 * 런타임에 조립되는 키의 접두사. `t('status.'+v)` 꼴은 AST로 수확할 수 없으므로
 * "죽은 번역" 판정에서 제외한다. 사용처가 생기면 이 목록에서 빼는 것이 맞다.
 */
export const DYNAMIC_PREFIXES = [
  'status.',            // ui.mjs name(): 'status.'+value
  'badge.',             // help.mjs badgeHelp(): 'badge.'+value+'.label'
  'help.',              // help.mjs helpFor(): 'help.page.'+id 등
  'guidance.',          // guidance.mjs: 'guidance.'+classId+'.title'
  'unit.',              // tn() 단위
  'op.',                // operations.cjs의 command 키
  'common.job.hold.',   // memory_jobs.hold_reason 값으로 조립 (decisions-v3 H2)
  // HTTP 200 본문의 프로즈. 서버가 `<field>Key`로 키를 싣고 api.mjs의 payloadText()가
  // **런타임에 받은 문자열로** 조회하므로 AST로 수확할 수 없다 — `op.`과 같은 성질이다
  // (설계 §5.3 분류 c · §5.4). 소스에 리터럴 호출이 없는 것이 정상이다.
  'label.',             // label.session.untitled
  'state.',             // state.schema.tableAbsent · state.fact.sourceUnavailable · state.log.selectFileFirst
  'note.',              // note.environment.inherited · note.log.tailOnlyRedaction · note.job.relatedFactsBasis
];

const rel = file => path.relative(ROOT, file).split(path.sep).join('/');

function walk(target, out = []) {
  const abs = path.isAbsolute(target) ? target : path.join(ROOT, target);
  if (!fs.existsSync(abs)) return out;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (CODE_EXT.has(path.extname(abs))) out.push(abs);
    return out;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    walk(path.join(abs, entry.name), out);
  }
  return out;
}

export function sourceFiles(roots = DEFAULT_ROOTS) {
  const files = [];
  for (const root of roots) for (const file of walk(root)) if (!files.includes(file)) files.push(file);
  return files.sort();
}

function parse(file) {
  const src = fs.readFileSync(file, 'utf8');
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/** 한글을 담은 문자열·템플릿 리터럴. 주석은 리터럴이 아니므로 들어오지 않는다. */
export function literals(file) {
  const sf = parse(file);
  const out = [];
  (function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (HANGUL.test(node.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ file: rel(file), line: line + 1, kind: ts.SyntaxKind[node.kind], text: node.text });
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  return out;
}

export function scanRoots(roots = DEFAULT_ROOTS) {
  const hits = [];
  for (const file of sourceFiles(roots)) hits.push(...literals(file));
  return hits;
}

/** `--lint` 대상: 허용 경로도 아니고 미이관 목록에도 없는 한글. */
export function lint(roots = DEFAULT_ROOTS) {
  const hits = scanRoots(roots);
  const pending = new Set(PENDING_MIGRATION);
  const violations = hits.filter(h => !ALLOW.some(re => re.test(h.file)) && !pending.has(h.file));
  const seen = new Set(hits.map(h => h.file));
  const stale = PENDING_MIGRATION.filter(file => !seen.has(file));
  return { violations, stale, total: hits.length };
}

/** 소스에서 쓰인 i18n 키를 AST로 수확한다. */
export function harvestKeys(roots = DEFAULT_ROOTS) {
  const used = new Map();      // key → [file:line]
  const plurals = new Map();   // tn() base → [file:line]
  const dynamic = [];
  const add = (map, key, where) => { if (!map.has(key)) map.set(key, []); map.get(key).push(where); };
  for (const file of sourceFiles(roots)) {
    const sf = parse(file);
    const where = node => `${rel(file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    (function visit(node) {
      // (1) ui/public: t('…') / tHtml('…') / tn('…', n)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fn = node.expression.text;
        if (fn === 't' || fn === 'tHtml' || fn === 'tn') {
          const first = node.arguments[0];
          if (first && ts.isStringLiteral(first)) add(fn === 'tn' ? plurals : used, first.text, where(node));
          else if (first) dynamic.push(where(node));
        }
      }
      // (2) ui/lib: new HttpError(status, {key:'…'}) — 서버가 key를 검증하지 않는 대가를
      //     빌드 시점 검사로 치른다(설계 §9.1 (7) ②).
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'HttpError') {
        // 두 번째 인자가 `cache ?? {…}` 같은 식일 수 있으므로 인자 안의 객체 리터럴을 모두 본다.
        for (const arg of node.arguments ?? []) {
          (function scan(inner) {
            if (ts.isObjectLiteralExpression(inner)) {
              for (const prop of inner.properties) {
                if (ts.isPropertyAssignment(prop) && prop.name && prop.name.getText(sf) === 'key'
                  && ts.isStringLiteral(prop.initializer)) add(used, prop.initializer.text, where(prop));
              }
            }
            ts.forEachChild(inner, scan);
          })(arg);
        }
      }
      // (3) 레지스트리의 labelKey:'…' — 런타임에 t(labelKey)로 쓰인다.
      if (ts.isPropertyAssignment(node) && node.name && node.name.getText(sf) === 'labelKey'
        && ts.isStringLiteral(node.initializer)) add(used, node.initializer.text, where(node));
      ts.forEachChild(node, visit);
    })(sf);
  }
  for (const [key, where] of harvestHtmlKeys()) add(used, key, where);
  return { used, plurals, dynamic };
}

/**
 * 부팅 셸의 키는 `index.html`의 `data-i18n` / `data-i18n-attr` 속성에 있다 — app.mjs의
 * applyDocumentLanguage()가 DOM에서 읽어 t()에 넘기므로 소스에 리터럴 호출이 없다.
 */
export function harvestHtmlKeys(file = 'ui/public/index.html') {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  const at = index => `${file}:${src.slice(0, index).split('\n').length}`;
  for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) out.push([m[1], at(m.index)]);
  for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) {
      const key = pair.split(':')[1];
      if (key) out.push([key.trim(), at(m.index)]);
    }
  }
  return out;
}

const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** 사전 완전성 양방향 검사. 없는 키 사용 · 죽은 번역 · 복수 base 직접 호출을 모두 본다. */
export function checkKeys(dictionaries, roots = DEFAULT_ROOTS) {
  const { used, plurals } = harvestKeys(roots);
  const problems = [];
  const keysOf = dict => new Set(Object.keys(dict));
  for (const [tag, dict] of Object.entries(dictionaries)) {
    const keys = keysOf(dict);
    for (const [key, where] of used) {
      if (!keys.has(key)) problems.push(`missing ${tag} key "${key}" (${where[0]})`);
      // R4: 복수 키의 base를 t()로 직접 부르면 값이 없어 키가 노출된다.
      if (keys.has(`${key}.other`)) problems.push(`plural base called through t(): "${key}" (${where[0]})`);
    }
    for (const [base, where] of plurals) {
      if (!keys.has(`${base}.other`)) problems.push(`missing ${tag} plural "${base}.other" (${where[0]})`);
    }
  }
  // 죽은 번역: 어느 사전에 있지만 소스에서 쓰이지 않고 동적 접두사에도 속하지 않는 키.
  const usedAll = new Set(used.keys());
  for (const base of plurals.keys()) for (const form of PLURAL_FORMS) usedAll.add(`${base}.${form}`);
  for (const [tag, dict] of Object.entries(dictionaries)) {
    for (const key of Object.keys(dict)) {
      if (usedAll.has(key)) continue;
      if (DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
      const base = key.replace(/\.(zero|one|two|few|many|other)$/, '');
      if (base !== key && usedAll.has(base)) continue;
      problems.push(`dead ${tag} translation "${key}"`);
    }
  }
  return problems;
}

/** index.html은 JS 파서 대상이 아니라 텍스트 노드·속성을 따로 본다(4건). */
export function htmlLiterals(file = 'ui/public/index.html') {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  src.split('\n').forEach((line, i) => {
    if (HANGUL.test(line)) out.push({ file, line: i + 1, kind: 'Html', text: line.trim() });
  });
  return out;
}

function report(hits) {
  for (const h of hits) console.log(`${h.file}:${h.line}  ${h.kind}  ${JSON.stringify(h.text)}`);
  const byFile = new Map();
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) || 0) + 1);
  console.log('');
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(5)}  ${file}`);
  const root = prefix => hits.filter(h => h.file.startsWith(prefix)).length;
  console.log('');
  console.log(`ui/public  ${root('ui/public')}`);
  console.log(`ui/lib     ${root('ui/lib')}`);
  console.log(`total      ${hits.length}`);
}

function stub(hits, ns) {
  console.log(`// ui/public/i18n/${ns}/ko.mjs — 초안. 키 이름을 §2.3 규약대로 다듬고 en을 같이 채운다.`);
  console.log('export default {');
  const seen = new Set();
  let n = 0;
  for (const h of hits) {
    const text = h.text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    console.log(`  '${ns}.TODO.${++n}': ${JSON.stringify(text)},   // ${h.file}:${h.line}`);
  }
  console.log('};');
}

async function main(argv) {
  const flag = name => argv.includes(name);
  const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const file = value('--file');
  const roots = file ? [file] : (argv.filter(a => !a.startsWith('--') && a !== file && a !== value('--stub')).length
    ? argv.filter(a => !a.startsWith('--') && a !== value('--stub'))
    : DEFAULT_ROOTS);

  if (flag('--keys')) {
    const { loadDictionary } = await import('../ui/public/i18n/load.mjs');
    const problems = checkKeys({ en: loadDictionary('en').dict, ko: loadDictionary('ko').dict }, DEFAULT_ROOTS);
    for (const problem of problems) console.error(problem);
    console.log(problems.length ? `${problems.length} key problem(s)` : 'keys ok');
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  if (flag('--lint')) {
    const { violations, stale } = lint(roots);
    for (const h of violations) console.error(`${h.file}:${h.line}  ${h.text.slice(0, 60)}`);
    for (const f of stale) console.error(`${f}  (migrated — remove it from PENDING_MIGRATION)`);
    const bad = violations.length + stale.length;
    console.log(bad ? `${bad} violation(s)` : 'no Korean literals outside the ko dictionaries');
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (flag('--html')) { report(htmlLiterals()); return; }
  const hits = scanRoots(roots);
  if (flag('--json')) {
    const grouped = new Map();
    for (const h of hits) {
      const key = h.text;
      if (!grouped.has(key)) grouped.set(key, { text: key, uses: [] });
      grouped.get(key).uses.push(`${h.file}:${h.line}`);
    }
    console.log(JSON.stringify({ total: hits.length, unique: grouped.size, items: [...grouped.values()] }, null, 2));
    return;
  }
  if (flag('--stub')) { stub(hits, value('--stub') || 'todo'); return; }
  report(hits);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
