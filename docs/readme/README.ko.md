<h1 align="center">
  <a href="https://github.com/nplez1/orca"><img src="../../resources/build/icon.png" alt="Orca NP" width="64" valign="middle" /></a> Orca NP
</h1>

<p align="center">
  <a href="https://github.com/nplez1/orca"><img src="https://img.shields.io/github/stars/nplez1/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub 스타" /></a>
  <a href="https://github.com/nplez1/orca/releases"><img src="https://img.shields.io/github/v/release/nplez1/orca?style=flat&amp;label=release&amp;color=08C" alt="Orca NP 최신 릴리스" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="라이선스: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Orca NP 빌드: macOS 및 Windows" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.ru.md">Русский</a></sub>
</p>

<p align="center">
  <strong>🔱 이것은 <a href="#이-포크의-차이점">Orca NP</a>입니다 — 자체 기능, 수정, 릴리스를 갖춘 <a href="https://github.com/stablyai/orca">stablyai/orca</a>의 포크입니다.</strong><br/>
  <sub>공식 Orca와 나란히 설치됩니다 · <a href="https://github.com/nplez1/orca/releases/latest">최신 Orca NP 빌드 다운로드</a> · <a href="#이-포크의-차이점">달라진 점 보기 ↓</a></sub>
</p>

<p align="center">
  <strong>100x 빌더를 위한 AI 오케스트레이터.</strong><br/>
  Codex, Claude Code, OpenCode, Pi를 나란히 실행하세요. — 각 에이전트는 자체 worktree에서 실행되고 한곳에서 추적됩니다.
</p>

<h3 align="center"><a href="https://github.com/nplez1/orca/releases/latest"><ins>Orca NP 다운로드</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="병렬 worktree에서 에이전트를 실행 중인 Orca 데스크톱 앱과 한쪽 모서리에 보이는 Orca 모바일 companion 앱" width="960" />
</p>

## 이 포크의 차이점

Orca NP는 [stablyai/orca](https://github.com/stablyai/orca)에 포크 전용 기능과 수정을 더한 것입니다. 아래 업스트림 기능 목록은 그대로 적용됩니다(여기서 빌드를 배포하지 않는 경우 제외 — [설치](#설치) 참고). 다음은 Orca NP가 그 위에 추가한 내용입니다. 전체 목록은 [병합된 풀 리퀘스트](https://github.com/nplez1/orca/pulls?q=is%3Apr+is%3Amerged)에 있으며, 포크 전용 패치 시리즈는 [`LOCAL-PATCHES.md`](../../LOCAL-PATCHES.md)에 문서화되어 있습니다.

### 작업, 이슈, Jira

- **Jira 보드 뷰** — 기본 보드를 고르면 Jira 탭에 컬럼, 활성 스프린트, 백로그가 표시되며, 컬럼 간 드래그 이동, 필터 입력란, 우선순위 색상을 지원합니다.
- **유지되는 레인 드롭** — 레인에 떨어뜨린 Jira 항목은 트랜지션을 처리하고, 해당 트랜지션 화면이 요구하는 필드를 요청한 뒤 Jira가 확인하기 전에 카드를 옮깁니다. Jira가 거부할 때만 되돌립니다.
- **스프린트, 스토리 포인트, 사용자 지정 필드** — 백로그 항목을 행이나 이슈 드로어에서 스프린트로 옮기고, 상태·우선순위·담당자 옆에서 스토리 포인트를 설정하거나 지우며, 이슈 상세에서 사용자 선택 방식의 사용자 지정 필드(Dev, QE)를 편집할 수 있습니다. 열려 있는 이슈에서 스프린트를 바꾸면 보드가 다시 로드됩니다.
- **"Me"가 모든 역할 필드와 매칭** — 담당자뿐 아니라 Dev 또는 QE가 나인 이슈도 이제 보드의 Me 필터에 표시됩니다.
- **검색 가능한 담당자 선택기** — 나와 팀이 맨 위에 고정됩니다.
- **오른쪽 사이드바의 연결된 이슈** — Jira, Linear, GitHub 이슈에서 만든 워크스페이스에는 상태, 담당자, 우선순위, 라벨, 설명, 열기 버튼이 있는 Issue 탭이 생깁니다. Jira 이슈는 연결 해제/재연결, 실시간 Markdown 댓글 입력란을 제공하며, 자체 호스팅 Jira(Server/Data Center)의 설명도 올바르게 렌더링합니다. GitHub 이슈는 그것이 나온 저장소에서 읽으므로 다른 프로젝트의 워크스페이스에서도 불러옵니다. 그 저장소가 이 머신에 없으면 실패하는 대신 탭이 그 사실을 알립니다.
- **워크스페이스를 Jira 이슈에 연결** — 세부 정보 대화상자에서 키 또는 URL로 연결할 수 있습니다. 작업 페이지에는 연결된 워크스페이스 칩이 표시되며, 중복 생성 대신 기존 워크스페이스를 엽니다.

### 풀 리퀘스트 리뷰와 CI

- **인라인 GitHub PR 댓글** — 댓글이 에디터의 해당 줄 아래에 표시되며 답글, 해결, 접기를 지원합니다(체크아웃이 PR의 head 커밋과 일치할 때만 표시).
- **병합 준비 상태를 한눈에** — PR 아이콘은 CI 색상을 유지하면서, 대기 중인 승인·충돌·차단이 있으면 점이 추가되고 이유는 툴팁에 표시됩니다. GitHub, GitLab, Bitbucket, Azure DevOps, Gitea에서 동작합니다.
- **Checks 패널의 리뷰 판정** — 리뷰어 이름과 함께 Approved / Changes requested를 표시하며, 탭을 전환하지 않아도 CI가 바뀌면 패널이 갱신됩니다.
- **실시간 Checks 패널** — 실행이 진행 중인 동안 열려 있는 패널은 리뷰 주기를 기다리지 않고 10초마다 다시 읽고, 아무것도 변하지 않으면 20초, 이어 30초로 간격을 늘립니다. 판정은 사이드바 카드와 활동 표시줄 아이콘을 갱신합니다(GitHub).
- **Jenkins 빌드 상세** — Jenkins 체크를 펼치면 단계, 실행 중이거나 실패한 단계, 빌드 정보를 볼 수 있습니다.
- **리뷰가 필요한 PR의 관리자 병합** — 계정이 브랜치 보호를 우회할 수 있다면, 건너뛰는 항목을 알려 주는 확인 후에 Merge가 제공됩니다.

### 에이전트

- **세션 요약** — 에이전트 세션을 글로 정리한 브리프(활동, 목표, 계획, 블로커, 타임라인)를 오른쪽 사이드바에 표시하며, 전용 에이전트/모델 설정이 있습니다. Pi, Copilot, OpenCode, Cursor 세션도 지원합니다. 페어링된 호스트의 세션은 그 호스트에서 브리프를 작성하고, SSH 대상의 세션은 스트리밍된 트랜스크립트를 바탕으로 브리프를 작성합니다.
- **더 정확한 에이전트 상태** — 보조 서브 에이전트가 끝나도 Pi 행이 "Working"에 머물거나 "Done"으로 바뀌지 않습니다. Copilot CLI는 자동 승인된 프롬프트에 "needs you"를 띄우지 않습니다. 사용자의 응답을 기다리는 Grok 서브 에이전트는 해당 행을 대기 상태로 유지합니다. 다른 클라이언트에서 복원한 터미널 창은 그 대화상자가 남긴 "입력 필요" 표시를 제거합니다. 그리고 pi 세션이 `claude` CLI로 띄운 Claude 서브 에이전트는 해당 pi 세션의 행에 남습니다(최신 `pi-subagents` 플러그인이 필요합니다).
- **화면에서 읽는 Copilot 프롬프트** — 셸 또는 URL 승인과 "Copilot needs information" 대화상자가 스피너 대신 프롬프트로 표시되는 반면, CLI가 알아서 승인한 권한은 조용하게 유지됩니다.
- **에이전트 탭에 머무는 포커스** — 사이드바 카드, 오른쪽 사이드바의 활동 탭, 패널 배경을 클릭하면 키보드가 에이전트 탭으로 돌아오고, 메뉴나 대화상자를 닫으면 캐럿도 돌아오므로 다음 키 입력이 여전히 의도대로 작동합니다.
- **보는 쪽을 따라오는 클립보드** — 페어링된 클라이언트에서 pi 터미널을 보면서 복사하면 내용이 호스트의 클립보드는 물론 그 클라이언트의 클립보드에도 들어갑니다.
- **한 번에 기본 에이전트 실행** — 탭 바의 `+` 버튼이 기본 에이전트를 실행합니다. 길게 누르거나 셰브론을 사용하면 전체 메뉴가 열립니다.
- **페이지로 열리는 Agent Dashboard** — 메인 창에서 뒤로/앞으로 이동과 함께 열리며, 카드를 클릭하면 해당 에이전트의 워크스페이스가 열립니다.
- **에이전트 세션 기록** — "All"이 모든 세션을 나열하고, 서브 에이전트 세션은 부모 아래에 중첩되며, 트랜스크립트 인덱싱으로 기존 트랜스크립트도 검색할 수 있습니다. 페어링된 호스트의 기록은 페이지 단위로 불러오고 바뀐 부분만 갱신하므로, 방대한 원격 기록도 실패 없이 도착합니다.
- **더 많은 제공자의 사용량 추적** — Copilot Enterprise AI 크레딧 예산, DeepSeek 잔액, Fireworks.ai 지출을 상태 표시줄에 표시하며, 제공자별 끄기 스위치로 폴링과 자격 증명 읽기를 중단할 수 있습니다. 만료된 Claude 로그인은 "Claude 실행 시 업데이트됨"에 머물지 않고 저장된 리프레시 토큰으로 갱신되며, 갱신된 로그인은 Claude가 보관하는 위치에 다시 저장됩니다.

### 워크스페이스와 레이아웃

- **프로젝트당 폴더 하나** — 메인 체크아웃과 모든 worktree가 공유 `AGENTS.md`와 함께 하나의 폴더에 모입니다. `orca repo relocate`가 기존 체크아웃을 그 폴더로 옮깁니다.
- **머신을 넘나드는 워크스페이스 그룹화** — 두 호스트의 같은 브랜치가 호스트 드롭다운이 있는 카드 하나로 합쳐집니다. 페어링된 호스트의 워크스페이스는 그 호스트에서 GitHub 이슈와 PR을 읽고, 그 호스트의 에이전트가 모두 끝나면 상태 점이 도는 것을 멈춥니다.
- **발을 맞추는 페어링된 클라이언트** — 호스트가 추가·제거한 프로젝트와 워크스페이스(그 호스트의 자체 창이나 CLI에서 만든 것 포함)는 수동으로 새로고침하지 않아도 페어링된 클라이언트에 전달됩니다.
- **상태 필터** — 선택한 상태를 사이드바와 Cmd+J에서 숨기며, 보드는 계속 모든 것을 보여 줍니다.
- **"Setting up…" 표시** — 저장소 설정 스크립트가 실행되는 동안 표시되며, 에이전트 없이 시작한 워크스페이스도 포함됩니다.
- **공유 디렉터리 모드** — worktree 간 공유 디렉터리를 심볼릭 링크, APFS 클론, 복사, 건너뛰기 중에서 선택합니다.
- **플로팅 워크스페이스** — 전용 홈 폴더, 제목 표시줄의 드래그 핸들, 메인 탭 바와 동일한 에이전트 실행 컨트롤을 갖습니다.
- **자동으로 가져온 SSH 호스트 숨기기** — 선택기와 상태 표시줄에서 숨길 수 있으며, 숨긴 호스트는 설정에 계속 나열됩니다.
- **더 빠르고 정직한 파일 필터** — Explore의 파일 이름 필터는 미리 만든 인덱스로 워크스페이스 전체를 검색하며, 결과가 일부일 때 "no files match" 대신 그렇게 알려 줍니다.
- **호스트 간 설정 복제** _(기반 작업)_ — 한 머신의 설정과 제공자 자격 증명을 페어링된 호스트로 복제할 수 있습니다.

### 임시 환경

업스트림의 워크스페이스별 환경 레시피(설정 → 실험적 → 클라우드 VM)에 추가:

- **임대 카운트다운과 Extend** — 제공자가 호스트를 회수하는 시점을 공개하는 레시피는 워크스페이스 카드와 설정에 카운트다운이 표시되고, 연장 방법까지 선언한 경우에는 레시피가 나열한 수명 기간만 제공하는 Extend 동작도 받습니다. 기한이 지나면 카드와 설정은 임대를 만료된 것으로 표시합니다. 그로부터 15분이 지나고 Orca와 호스트의 연결이 실패하면 Orca가 목록에서 해당 워크스페이스를 제거하고, 제공자의 머신은 자체 만료나 설정의 정리에 맡겨집니다.
- **레시피가 선언하는 컨텍스트 메뉴 항목** — 레시피가 선언한 최대 20개의 동작은 해당 워크스페이스의 컨텍스트 메뉴에 자체 항목으로 나타나며, 그 워크스페이스의 호스트·이름·경로로 실행됩니다. `orca.yaml`에 선언하는 항목이므로 레시피의 승인 범위에 포함되며, 아무것도 선언하지 않은 레시피는 메뉴 항목을 추가하지 않습니다.

### 안정성

- 패키징된 앱을 Dock에서 실행해도 git이 셸 프로필의 export를 인식하므로 git 훅과 ssh-agent 인증이 동작합니다.
- macOS computer use 권한이 더 이상 두 개의 헬퍼 ID로 나뉘지 않습니다.
- Copilot CLI에서 우클릭 붙여넣기가 두 번이 아니라 한 번만 붙여넣습니다.
- 선택형 "Log UI hangs" 진단은 포커스, 절전, CPU 정보와 함께 멈춤 기록을 남겨 비치볼 원인 추적을 돕습니다.

### 실행 방식

- **고유한 정체성** — Orca NP는 자체 앱 ID(`com.nplez1.orca`), 데이터 디렉터리, 홈 디렉터리(`~/.orca-np`), CLI(`orca-np`)를 사용하므로 공식 Orca와 상태를 공유하지 않고 나란히 설치·실행됩니다.
- **자체 릴리스와 업데이트** — 빌드는 `v<업스트림 버전>-np.<n>` 태그를 달며, 앱 내 업데이터는 업스트림이 아니라 [이 저장소의 릴리스](https://github.com/nplez1/orca/releases)를 따릅니다.
- **서명** — macOS 빌드는 서명 및 공증되어 있습니다. Windows 설치 프로그램은 서명되지 않아 설치 시 SmartScreen이 한 번 경고합니다.
- **텔레메트리 없음** — 릴리스 노트에 따르면 빌드는 진단 정보나 사용 데이터를 전송하지 않습니다.
- **스킬이 이 앱을 가리킴** — 동봉된 스킬과 게시된 스텁은 공식 설치의 `orca`로 넘어가지 않고 `orca-np`(개발 시에는 `orca-np-dev`)를 호출합니다.
- **새 프로필** — Orca NP는 공식 Orca 설치의 저장소, 자격 증명, 페어링된 기기를 읽을 수 없습니다. 이 분리는 의도된 것이므로 휴대폰은 Orca NP와 따로 페어링하세요.
- **업스트림 추적** — 업스트림 `main`을 정기적으로 병합합니다(절차는 [`UPSTREAM-SYNC-RUNBOOK.md`](../../UPSTREAM-SYNC-RUNBOOK.md)에 있음). 그래서 포크도 업스트림의 기능과 수정을 받습니다.

---

## 기능

아래 기능 목록은 업스트림 Orca의 것입니다. "Docs" 링크는 onorca.dev의 업스트림 문서로 이동하며, 위의 포크 전용 기능은 다루지 않습니다.

<table>
<tr>
<td width="50%" valign="middle">

### 모바일 Companion

휴대폰에서 에이전트를 모니터링하고 조종하세요 — 에이전트가 완료되면 알림을 받고 어디서든 후속 지시를 보낼 수 있습니다.

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [Android APK](https://www.onorca.dev/download/android) · [문서 →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca 데스크톱과 모바일 companion 앱" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 병렬 Worktree

하나의 프롬프트를 다섯 에이전트에 동시에 보내세요. 각 에이전트는 격리된 자체 git worktree에서 실행됩니다 — 결과를 비교하고 가장 좋은 것을 머지하세요.

[문서 →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../site/public/docs/tab-split.gif" type="image/gif"><img src="../site/public/docs/posters/tab-split.jpg" alt="병렬 worktree 오케스트레이션" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 터미널 분할

WebGL 렌더링, 무한 분할, 재시작 후에도 유지되는 스크롤백을 갖춘 Ghostty급 터미널.

[문서 →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../resources/onboarding/feature-wall/tile-02.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-02.poster.jpg" alt="터미널 분할" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 디자인 모드

실제 Chromium 창에서 UI 요소를 클릭하면 해당 HTML, CSS, 잘라낸 스크린샷이 에이전트 프롬프트로 바로 전송됩니다.

[문서 →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../site/public/docs/orca-design-mode.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-05.poster.jpg" alt="내장 브라우저와 디자인 모드" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear 네이티브

PR, issue, 프로젝트 보드를 앱 안에서 탐색하세요 — 어떤 작업에서든 worktree를 열고 컨텍스트 전환 없이 리뷰할 수 있습니다.

[문서 →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../resources/onboarding/feature-wall/tile-03.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-03.poster.jpg" alt="Orca의 GitHub 및 Linear 작업 워크플로" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH Worktree

강력한 원격 머신에서 에이전트를 실행하세요. 파일 편집, git, 터미널을 모두 지원하며 자동 재연결과 포트 포워딩도 포함됩니다.

[문서 →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../resources/onboarding/feature-wall/tile-06.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-06.poster.jpg" alt="SSH를 통한 원격 worktree" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### AI Diff 주석

diff의 어느 줄에든 코멘트를 남기고 에이전트에게 바로 보내세요 — Orca를 떠나지 않고 리뷰하고 수정하고 커밋할 수 있습니다.

[문서 →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-08.poster.jpg" alt="AI가 생성한 diff에 주석 달기" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 에이전트로 파일 드래그

어디서나 자동 저장되는 VS Code 에디터 — 파일이나 이미지를 에이전트 프롬프트로 바로 드래그하세요.

[문서 →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-07.poster.jpg" alt="파일과 이미지를 에이전트 프롬프트로 드래그" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

에이전트도 Orca를 조작할 수 있습니다 — `orca worktree create`, `snapshot`, `click`, `fill`로 모든 워크플로를 스크립팅하세요.

[문서 →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../resources/onboarding/feature-wall/tile-09.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-09.poster.jpg" alt="CLI에서 Orca 스크립팅" width="100%" /></picture></a>
</td>
</tr>
</table>

**그 밖에 기본으로 제공되는 기능:**

- **[빠른 열기](https://www.onorca.dev/docs/model/quick-open)** — 작업 흐름을 벗어나지 않고 worktree, 파일, 에이전트, 커맨드, 리포지토리 컨텍스트를 검색하세요.
- **[계정 전환 및 사용량 추적](https://www.onorca.dev/docs/agents/usage-tracking)** — Claude와 Codex의 사용량과 rate limit 초기화 시점을 확인하고, 다시 로그인하지 않고 계정을 바로 전환하세요.
- **[풍부한 리포지토리 미리보기](https://www.onorca.dev/docs/editing/markdown)** — Markdown, 이미지, PDF, 리포지토리 문서를 워크스페이스에서 미리 볼 수 있습니다.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — 워크플로에 실제 상호작용이 필요할 때 에이전트가 데스크톱 앱과 화면에 보이는 UI를 직접 조작하게 하세요.
- **[알림과 읽지 않음 상태](https://www.onorca.dev/docs/notifications)** — 에이전트가 완료되거나 주의가 필요할 때 알림을 받고, 스레드를 읽지 않음으로 표시해 나중에 다시 확인하세요.
- **그 외에도 정말 많습니다** — 매일 릴리스하므로 이 목록은 늘 뒤처져 있습니다. 이 포크의 실제 기능 목록은 [Orca NP 릴리스](https://github.com/nplez1/orca/releases)이고, 물려받은 부분은 [업스트림 릴리스](https://github.com/stablyai/orca/releases)입니다.

---

## 지원 에이전트

**모든 CLI 에이전트**와 함께 작동합니다 — 터미널에서 실행되는 에이전트라면 Orca에서도 실행됩니다.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Muse logo" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="DeepSeek Harness logo" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="ZCode logo" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="MiMo Code logo" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Devin logo" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Auggie logo" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Autohand Code logo" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Charm logo" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=freebuff.com&sz=64" alt="Freebuff logo" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Command Code logo" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logo" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Kiro logo" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Rovo Dev logo" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ any CLI agent</kbd>
</p>

---

## 설치

### 데스크톱 — macOS, Windows

- **[최신 Orca NP 릴리스 다운로드](https://github.com/nplez1/orca/releases/latest)**
- 또는 빌드를 직접 받기: [macOS Apple Silicon](https://github.com/nplez1/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/nplez1/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/nplez1/orca/releases/latest/download/orca-windows-setup.exe) · [모든 빌드](https://github.com/nplez1/orca/releases)

Orca NP는 공식 Orca와 나란히 설치되며 이 저장소의 릴리스로 자동 업데이트됩니다. 이 포크는 Linux 빌드나 Homebrew/AUR 패키지를 배포하지 않습니다. Linux에서는 [소스에서 빌드](../../.github/CONTRIBUTING.md)하거나 [업스트림 Orca](https://github.com/stablyai/orca/releases/latest)를 사용하세요.

### 모바일 Companion — iOS, Android

Orca 모바일 앱을 Orca NP와 페어링해 휴대폰에서 에이전트를 모니터링하고 조종하세요. 앱은 업스트림 Orca가 배포하며 Orca NP와 함께 동작합니다.

- **iOS:** [App Store에서 다운로드](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [APK 다운로드](https://www.onorca.dev/download/android) · [설치 가이드](https://www.onorca.dev/docs/android-apk)

---

## 커뮤니티와 지원

- **Orca NP 이슈 및 아이디어:** 이 포크에만 해당하는 내용은 [이슈를 열어](https://github.com/nplez1/orca/issues) 주세요.
- **업스트림 커뮤니티:** 이 포크가 물려받은 부분은 업스트림 Orca의 채널에서 다룹니다 — [Discord](https://discord.gg/fzjDKHxv8Q), [X의 @orca_build](https://x.com/orca_build), 공식 Orca에서도 재현되는 버그는 [업스트림 이슈](https://github.com/stablyai/orca/issues)로 보내 주세요.
- **문서:** [onorca.dev/docs](https://www.onorca.dev/docs)는 업스트림 Orca의 문서입니다.
- **응원하기:** 이 포크를 따라가려면 이 저장소에 [스타](https://github.com/nplez1/orca)를, 또는 [업스트림](https://github.com/stablyai/orca)에 눌러 주세요.

---

## 개발

기여하거나 로컬에서 실행하고 싶으신가요? [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) 가이드를 확인하세요.

<a href="https://github.com/nplez1/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=nplez1/orca" alt="Orca 기여자" />
</a>

## 서명된 빌드

Orca NP의 Windows 설치 프로그램은 서명되지 않았습니다. 업스트림 Orca의 Windows 빌드는 [SignPath.io](https://signpath.io)가 후원/제공하는 코드 서명으로 서명되며, 인증서는 [SignPath Foundation](https://signpath.org)에서 발급합니다.

## 라이선스

Orca는 [MIT 라이선스](../../LICENSE)에 따라 자유롭게 사용할 수 있는 오픈 소스입니다.
