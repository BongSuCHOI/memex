// errors — 서버 오류 키의 **클라이언트 측** 번역. 소유: i18n L1.
// ui/lib은 이 파일을 require하지 않는다(설계 §16.2 C3.3) — 서버는 key를 검증 없이 통과시키고
// 번역은 전부 클라이언트가 한다. lane-0은 오류 봉투 렌더와 DB 연결 경로(§5.5)에 필요한
// 키만 넣는다. 나머지 error.* 는 L1이 같은 파일에 채운다.
export default {
  'error.client.unknown': 'The request failed.',
  'error.issue.at': 'Row {row} · {field}',
  'error.issue.warning': 'Warning',
  'error.db.connectFailed': 'Cannot connect to the local database.',
  'error.db.indexMissing': 'The index database is missing. Run a conversation sync first.',
  'error.core.openReadDbMissing': 'The installed core has no openReadDb. Build the core and restart the server.',
};
