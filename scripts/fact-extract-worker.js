#!/usr/bin/env node

/**
 * Detached worker spawned by scripts/session-end-hook.js (foreground).
 *
 * Environment:
 *   SESSION_ID - session to extract facts from (required)
 *   CWD        - project path used for fact scoping (canonical: absolute path)
 *
 * Logs to <index-dir>/fact-extract.log so extraction is observable
 * (the parent hook runs with stdio ignored).
 */

import fs from "node:fs";
import path from "node:path";
import { initDatabase } from "../dist/db.js";
import {
  runFactExtraction,
  classifyExtractionFailure,
  FAILURE_REPORT,
} from "../dist/fact-extractor.js";
import { getIndexDir } from "../dist/paths.js";

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), "fact-extract.log"), msg + "\n");
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

async function main() {
  const sessionId = process.env.SESSION_ID;
  const project = process.env.CWD || process.cwd();
  const transcriptPath = process.env.MB_TRANSCRIPT_PATH || "";

  if (!sessionId) {
    log("worker: SESSION_ID not set, exiting");
    process.exit(0);
  }

  log(`worker: extracting session=${sessionId} project=${project}`);

  // 미인덱싱 세션 보호(2026-08-28 감사 ②): 세션-end 훅은 rollout 을 검증한 뒤
  // 워커를 띄우지만, 워커가 읽는 것은 SQLite 이다. SessionStart 의 백그라운드 sync 가
  // 아직 이 rollout 을 인덱싱하지 못했다면 exchange 가 0 건이고, 여기서 추출을 진행하면
  // "성공 0/0" 마커가 기록된다. 그 마커는 이후 sync 가 세션을 인덱싱해도 settled 로
  // 보이게 만들어(watermark=0 이어도 SEED/PERMANENT 제외 분기에 걸리지 않는 성공 상태)
  // 세션의 fact 를 영구 누락시킨다. transcript 가 실제로 비어있지 않음을 확인하면
  // 마커를 쓰지 않고 이연한다 — sync 가 인덱싱한 뒤 backfill 이 회수한다.
  try {
    db = initDatabase();
    const indexed = db
      .prepare("SELECT COUNT(*) AS c FROM exchanges WHERE session_id = ?")
      .get(sessionId).c;
    if (indexed === 0 && transcriptPath && fs.existsSync(transcriptPath)) {
      let exchanges = 0;
      try {
        const rolloutMod =
          (await import("../dist/codex-rollout.js").catch(() => null)) ??
          (await import("../src/codex-rollout.ts").catch(() => null));
        if (rolloutMod?.parseRolloutStream) {
          const stream = fs.createReadStream(transcriptPath);
          const parsed = await rolloutMod.parseRolloutStream(stream, {
            archivePath: transcriptPath,
          });
          stream.close?.();
          exchanges = parsed.exchanges.length;
        }
      } catch {
        // 파싱 불가 = 인덱싱 여부를 증명할 수 없다. 마커를 쓰지 않고 이연(fail-closed).
      }
      if (exchanges !== 0) {
        log(
          `worker: SKIPPED (not_indexed) session=${sessionId} — sync 미완료(exchanges=${exchanges}), 마커 없이 이연`,
        );
        return; // finally 에서 db.close
      }
    }

    const result = await runFactExtraction(db, sessionId, project);
    // skipped 를 무시하면 claim 미획득·보류가 'extracted=0 saved=0' 정상 처리와
    // 구분되지 않아 DB 장애가 무경보로 남는다(R19 — backfill 에서 닫은 결함이
    // 이쪽에 그대로 있었다).
    if (result.skipped) {
      log(
        `worker: SKIPPED (${result.skipped}) session=${sessionId} — 처리하지 않음`,
      );
    } else {
      log(
        `worker: session=${sessionId} extracted=${result.extracted} saved=${result.saved}`,
      );
    }
  } catch (error) {
    // 이양(handoff)은 실패가 아니다 — 다른 러너가 같은 세션을 인수한 정상 경로다.
    // 🚨 불변식 우선: 어떤 로깅 실패도 훅 실패로 표면화되면 안 된다. 표 역참조보다
    // exitCode 를 먼저 확정하고, dist↔scripts 스큐로 표가 비어도 죽지 않게 방어한다
    // (구 삼항 분기에는 없던 신규 취약면 — Codex R13 LOW).
    process.exitCode = 0; // extraction failure must never surface as hook failure
    try {
      const cls = classifyExtractionFailure(error);
      // 필드 단위 방어 — 구버전 표는 키가 있어도 필드가 빠질 수 있다(R14).
      const raw = FAILURE_REPORT?.[cls];
      const rep = {
        label: raw?.label ?? "ERROR",
        note: raw?.note ?? "분류 표가 불완전합니다(dist 재빌드 필요)",
      };
      log(
        `worker: ${rep.label} (${cls}) session=${sessionId}: ` +
          `${error instanceof Error ? error.message : error} — ${rep.note}`,
      );
    } catch (logErr) {
      log(
        `worker: ERROR session=${sessionId}: ${error instanceof Error ? error.message : error} (분류 실패: ${logErr})`,
      );
    }
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

// 최상위 rejection 도 훅 실패로 새지 않게 한다.
main().catch((e) => {
  try {
    log(`worker: FATAL ${e instanceof Error ? e.message : e}`);
  } catch {
    /* ignore */
  }
  process.exitCode = 0;
});
