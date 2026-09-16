# 🌉 Poly Bridge WEB — 커스텀 다리 빌더

브라우저에서 바로 즐기는 **폴리브릿지 스타일 다리 건설 시뮬레이션**입니다.
직접 다리를 설계하고, **강체(Rigid Body) 차량**으로 주행 테스트를 해보세요!

> 물리 기반: [`BaddishCarrot/polybridge4DFRAME20611`](https://github.com/BaddishCarrot/polybridge4DFRAME20611) 의
> 스프링-질점 브릿지 역학을 계승하고, 건설 에디터 + 강체 차량/화물 + 레벨/예산/성공 판정으로 확장했습니다.
> 자재 수치 원리: Poly Bridge 공식 매뉴얼(도로 900·목재 800·철강 2000·케이블 2200) 상대 비율 +
> "차량은 도로하고만 충돌" 원칙을 따릅니다.
> 차량 설계: [Matter.js](https://github.com/liabru/matter-js) 공식 car 예제(MIT License)의
> 검증된 치수(휠베이스·고마찰 바퀴·둥근 섀시)를 서스펜션 방식에 맞게 이식했습니다.

## 🎮 플레이

- **배포 주소**: `https://<유저명>.github.io/<레포명>/` (아래 배포 방법 참고)
- 로컬 실행: 이 폴더에서 `python3 -m http.server 8000` → http://localhost:8000

### 조작법

| 키 | 동작 |
|---|---|
| `1~4` | 자재 선택 (도로·목재·철강·케이블) |
| 드래그 | 다리 놓기 (앵커/노드/격자 스냅) |
| `B` / `M` / `E` (우클릭) | 놓기 / 이동 / 지우기 |
| `Space` | 건설 ⇄ 주행 테스트 |
| `D` | 자동차 출발 (시뮬레이션 중) |
| `Ctrl+Z` / `Ctrl+Y` | 되돌리기 / 다시실행 |
| `G` | 격자 토글 |

### 자재

| 자재 | 특징 |
|---|---|
| 🛣 도로 | 차량이 달리는 필수 주행면. 적당한 강도 |
| 🪵 목재 | 싸고 가벼우나 약함. 삼각 트러스용 |
| 🔩 철강 | 비싸고 무겁지만 매우 강함 |
| 🪢 케이블 | 인장(당김) 전용. 압축엔 힘 zero — 현수/사장교용 |

### 규칙

- 예산을 초과하면 주행 테스트 불가
- 빨강(인장)·파랑(압축) 응력이 한계를 넘으면 부재 파괴
- 강체 차량이 무사히 **GOAL 깃발**에 닿으면 클리어 (⭐ 3개 만점: 무파손·저예산·신속)
- ⚽ 강체 공 / 📦 강체 상자로 하중 테스트 가능
- 설계도는 브라우저 저장 + JSON 내보내기/가져오기 지원

## 🛠 기술 스택

- 의존성 **제로** — 순수 HTML5 Canvas + CSS + JavaScript (ES6)
- Verlet 질점-스프링 다리 + 오일러 강체(섀시·바퀴·서스펜션·화물) 양방향 연성
- 정적 파일 3개 (`index.html`, `style.css`, `app.js`) — GitHub Pages 최적화

## 🚀 GitHub Pages 배포

```bash
# 1. GitHub에서 빈 저장소 생성 (예: polybridge-web)
# 2. 이 폴더에서:
git init
git add .
git commit -m "feat: poly bridge web game"
git branch -M main
git remote add origin https://github.com/<유저명>/<레포명>.git
git push -u origin main
# 3. 저장소 Settings → Pages → Source: "GitHub Actions" 선택
```

`.github/workflows/deploy.yml` 가 포함되어 있어 `main` 푸시마다 자동 배포됩니다.
