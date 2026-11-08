[쉬운 시작 안내로 돌아가기](../README.ko.md)

# N2 Banditbul · 반딧불

[English](reference.md)

로컬 에이전트가 쉬는 동안 자료를 조사하고, 출처가 있는 지식을 Soul/Mimir 공통 DB에 축적하는 모듈입니다. 설정한 교육 과정이나 적게 사용된 기억 범주에서 주제를 고르고, Kraken의 검색·수집·출처 비교·학습 저장을 실행합니다.

학습 결과는 경험, 미검증 통찰, 출처 영수증으로 남습니다. 에이전트는 이후 작업에서 Soul/Mimir 검색을 통해 이 기록을 활용합니다.

## 설치

Node.js 22 이상과 쓰기 가능한 SQLite 파일이 필요합니다.

```sh
npm install https://github.com/choihyunsus/n2-banditbul/releases/download/v1.0.0/n2-banditbul-1.0.0.tgz
```

GitHub의 Kraken 1.0.0과 Mimir 3.0.3 배포 파일을 사용합니다. Kraken은 Windows x64, Linux x64, macOS arm64 워커를 제공합니다. Linux 워커에는 glibc 2.39 이상과 시스템 C++ 런타임이 필요합니다. 다른 환경에서는 포함된 Kraken 네이티브 소스를 빌드할 수 있습니다. 브라우저 렌더링에는 Chrome, 선택적 의미 비교에는 설정한 Ollama 임베딩 모델을 사용합니다.

## 동작 흐름

사용자 활동이 일정 시간 없고 학습 간격이 지났으면 주제를 최대 열 개 골라 순서대로 조사합니다. 각 주제에는 재시작 후에도 사용할 요청 ID가 먼저 저장됩니다. Kraken이 새 통찰을 실제 저장한 경우에만 반딧불 요약을 추가합니다. 빈 결과, 중복 자료, 정책에서 거절한 결과도 처리 기록을 남깁니다.

새 프로젝트·에이전트 범위는 일시정지 상태로 시작합니다.

| 메서드 | 동작 |
| --- | --- |
| `configure(config)` | 교육 과정과 설정 교체, 순환 위치·유휴 타이머 초기화 |
| `resume()` | 학습 활성화와 유휴 타이머 초기화 |
| `start()` | 저장된 일시정지 상태를 따르는 백그라운드 반복 실행 |
| `tick(signal?)` | 실행할 시점인 학습 한 주기 처리 또는 미완료 기록 복구 |
| `touch()` | 사용자 활동 전달, 진행 중 요청 취소 |
| `pause()` | 일시정지 상태 저장, 진행 중 요청 취소 |
| `close()` | 진행 중 요청 정리를 기다린 뒤 DB 연결 종료 |

호스트는 키보드·마우스·대화 등 관련 활동을 전달해야 합니다. 실행 중에는 공유 상태를 초당 한 번 확인하므로, 같은 DB 범위에 연결한 다른 프로세스에서도 활동이나 일시정지를 전달할 수 있습니다. 취소 전에 저장을 마친 지식은 보존합니다.

```js
const { Banditbul } = require('n2-banditbul');

const learner = new Banditbul({
  dbPath: './data/mimir.db',
  project: 'my-project',
  agent: 'researcher',
});

learner.configure({
  study_topics: [{
    category: 'programming',
    queries: ['Rust ownership patterns', 'TypeScript error handling'],
  }],
});
learner.resume();
learner.start();

// Forward activity from the embedding application.
// learner.touch();

// Await cleanup during application shutdown.
// await learner.close();
```

예시의 `configure()`는 최초 설정 또는 의도적으로 교육 과정을 교체할 때 호출합니다. 일반적인 재시작에서는 같은 DB 파일·프로젝트·에이전트로 기존 설정을 불러와 반복 실행을 시작하면 됩니다. 순환 위치, 다음 실행 시점, 일시정지 상태, 이력은 SQLite에 저장됩니다. `configure()`를 다시 호출하면 현재 호스트 정책 ID도 설정에 기록됩니다.

## 설정과 한도

잘못된 값과 알 수 없는 필드는 명시적인 오류로 반환합니다.

| 필드 | 기본값 | 허용 범위 |
| --- | --- | --- |
| `idle_threshold_secs` | 120초 | 1–86,400초 |
| `study_interval_secs` | 1,800초 | 60–604,800초 |
| `max_topics_per_cycle` | 3 | 1–10 |
| `study_topics` | 빈 배열 | 최대 64개 그룹·전체 256개 검색어 |
| `semantic` | `false` | 불리언 |
| `research` | Kraken 기본값 | 검색·수집·시간 제한 설정 |

주제 그룹은 `category`, 선택적 `description`, 1–32개의 `queries`를 받습니다. 범주는 UTF-8 512바이트, 설명은 1,024바이트, 검색어는 4,096바이트까지 허용합니다. 기본값을 적용한 전체 설정은 128 KiB까지입니다. 프로젝트·에이전트 ID는 공백과 제어문자를 제외한 UTF-8 128바이트 이내 문자열입니다.

설정된 검색어는 순환하며, 해당 작업이 실제 시작될 때 순환 위치를 갱신합니다. 중간 취소로 아직 시작하지 않은 주제는 다음 선택 위치에 남습니다. 주제를 설정하지 않으면 같은 프로젝트·에이전트의 최근 경험 2,000개에서 저빈도 범주를 최대 256개 살펴봅니다. 웹 출처와 기존 반딧불 요약을 제외하고, 요약을 만든 범주에는 7일 대기 시간을 적용합니다.

`research`는 `max_results`, `max_crawl_pages`, `min_confidence`, `max_content_length`, `timeout_ms`, `total_timeout_ms`, `time_range`, `engines`를 받습니다. 기본값은 Kraken과 같습니다. 검색 결과는 1–40개, 수집 페이지는 1–20개, 연구 요청 하나는 최대 600초로 제한합니다. 주제 사이에는 5초를 쉽니다. 한 주제가 실패해도 나머지 정해진 주제를 처리하고 부분 실패를 기록합니다. 다음 주기는 설정된 학습 간격을 기다립니다.

서비스 주소와 실행 파일은 호스트 생성자 옵션으로 전달합니다.

```js
const learner = new Banditbul({
  dbPath: './data/mimir.db', project: 'my-project', agent: 'researcher',
  kraken: {
    searxngUrl: 'http://127.0.0.1:8080',
    ollama: { endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' },
  },
});
```

`workerPath`, `chromePath`도 선택적으로 지정할 수 있습니다.

## 호스트 검토 정책

`LearningPolicy`를 생성자에 전달하면 출처 비교를 통과한 후보를 추가로 거를 수 있습니다. 정책을 가진 인스턴스에서 교육 과정을 설정하세요. 검토 동작이 바뀌면 새 정책 ID를 지정하고 설정을 갱신합니다.

```js
const learner = new Banditbul({
  dbPath: './data/mimir.db', project: 'my-project', agent: 'researcher',
  policy: {
    id: 'complete-sources-v1',
    screen({ facts, pages }, signal) {
      signal.throwIfAborted();
      return facts.filter(({ fact }) =>
        fact.sources.every(url => pages.some(page => page.url === url && !page.truncated))
      ).map(({ index }) => index);
    },
  },
});
```

비동기 검토에는 Kraken의 30초 제한을 적용합니다. 동기 콜백은 빠르게 반환해야 합니다. 아직 학습을 마치지 않은 연구를 재개할 때는 저장된 정책의 콜백을 제공해야 합니다. 이미 학습 저장을 마친 영수증은 저장된 정책 ID로 복구하므로 이전 콜백이나 워커를 다시 실행할 필요가 없습니다. 기존 교육 과정 파일의 일정·주제 필드는 위 형식으로 사용할 수 있고, 애플리케이션별 검토 설정은 호스트 정책으로 옮깁니다.

## 저장과 복구

독립 배포판 Soul·Mimir와 같은 SQLite 파일을 지정합니다. 모든 상태는 `project`, `agent`로 구분하고 요약 경험의 `session_id`에는 주기 ID를 넣습니다. 전용 테이블은 `banditbul_state`, `banditbul_cycles`, `banditbul_jobs`, `banditbul_leases`이며, `meta.banditbul_schema_version = 1`로 관리합니다.

30초 실행 임대를 10초마다 갱신하고 소유 토큰으로 오래된 작업자의 저장을 차단합니다. 종료되거나 임대가 만료된 프로세스의 작업은 다른 인스턴스가 복구할 수 있습니다. Kraken 연구 결과는 요청 ID로 재사용하며, 학습 응답을 받기 전에 끊겼다면 영수증의 `created` 값으로 새 통찰을 구분합니다. 이전 기록에서 생성 여부를 알 수 없는 항목은 그 상태를 보존합니다.

반딧불 요약과 작업 완료 기록은 같은 Mimir 트랜잭션에 저장합니다. 저장 중 실패하면 재시도해도 요약이 중복되지 않습니다. 교육 과정을 변경할 때도 이전에 저장된 학습부터 복구한 뒤 남은 이전 작업을 취소합니다.

요약에는 미검증 표시, 학습 시점, 보고서 해시, 정책 ID, 통찰 참조, 주장·출처 미리보기가 들어갑니다. 생략된 항목 수도 기록합니다. 요약은 당시 학습에 대한 이력이므로 주장을 재사용할 때는 Kraken 원본 보고서와 현재 Mimir 근거 상태를 확인해야 합니다. 출처 간 일치와 점수를 사실 판단에 사용하려면 독립적인 검증이 필요합니다.

`status()`, `history(limit, offset)`, `getCycle(id)`로 일시정지·다음 실행 시점·오류·주제별 결과·요청 ID·요약 ID를 읽습니다. 실패한 주기는 오류 상태로 표시합니다. 저장·복구가 실패하면 미완료 작업과 오류를 남기고 설정된 간격 후 재시도합니다. 이력과 출처는 운영자가 보관·정리할 수 있도록 유지합니다. DB를 열 때 모듈 테이블과 해당 소유 범위를 초기화합니다.

## CLI와 MCP

```sh
n2-banditbul configure --db ./data/mimir.db --project demo --agent researcher < curriculum.json
n2-banditbul run --db ./data/mimir.db --project demo --agent researcher
n2-banditbul touch --db ./data/mimir.db --project demo --agent researcher
n2-banditbul status --db ./data/mimir.db --project demo --agent researcher
n2-banditbul history --db ./data/mimir.db --project demo --agent researcher --limit 20
n2-banditbul get --db ./data/mimir.db --project demo --agent researcher --id <cycle-id>
n2-banditbul mcp --db ./data/mimir.db --project demo --agent researcher
```

`resume`, `pause`, `tick`도 제공합니다. `configure`는 표준 입력 또는 `--input`으로 JSON을 받습니다. `run`은 학습을 활성화하고 종료 신호까지 반복하며, 시작과 종료 때 JSON 상태를 출력합니다. 호스트 설정에는 `--worker`, `--chrome`, `--searxng`, `--ollama-endpoint`, `--ollama-model`을 사용합니다. 사용자 정의 검토 콜백은 라이브러리로 전달합니다. 종료 코드는 정상 명령 0, 입력·실행 오류 1, 오류 상태로 끝난 `tick` 2입니다.

MCP 도구는 `banditbul_status`, `banditbul_configure`, `banditbul_start`, `banditbul_pause`, `banditbul_touch`, `banditbul_tick`, `banditbul_history`, `banditbul_read`, `banditbul_topics`의 아홉 개입니다. 서버 연결은 저장된 상태를 불러오며, `banditbul_start`를 호출하면 학습을 활성화하고 반복 실행합니다. 도구 결과는 60,000바이트까지이고 검색어 미리보기의 잘림 여부를 표시합니다.

## 개발과 이용 조건

```sh
npm ci
npm test
npm run typecheck
npm audit --omit=dev
npm pack --dry-run
```

테스트는 실제 네이티브 SearXNG 전송, 타이머에 의한 시작, 활동·종료 취소, SQLite 롤백, 학습 직후 프로세스 종료와 복구, 정책 변경, 범위 분리, 손상된 저장 데이터, CLI, stdio MCP를 포함합니다. 재현 가능한 긍정 사례는 고정 출처 자료와 실제 Kraken 학습·Mimir 저장 경로를 사용합니다.

반딧불 소스는 MIT입니다. Kraken·Mimir 의존성의 이용 조건도 적용됩니다. Mimir의 비상업·상업 이용 조건은 `LICENSE-N2-MIMIR`, 추가 출처는 `THIRD-PARTY-NOTICES`에 포함되어 있습니다.
