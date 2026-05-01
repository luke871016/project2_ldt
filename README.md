# 台語雙音節 LDT（project2）

本資料夾可**單獨當成一個 Git repository** 根目錄（內含 `data/`、`report/`、`scripts/`）。

## 實驗結果報告網頁（初版）

瀏覽器無法用 `file://` 直接開 `report/index.html` 並讀取 CSV，需透過 HTTP。

### 本機預覽（本 repo 為根目錄時）

在**本儲存庫根目錄**（即含有 `report`、`data` 的那一層）執行：

```bash
cd /path/to/這個-repo   # 例如 clone 下來的資料夾
python3 -m http.server 8000
```

瀏覽器開啟：

`http://localhost:8000/report/index.html`

### 若仍放在「上層 monorepo」裡本機預覽

若靜態伺服器根目錄是**上一層**的 `project`（同時含 `project1`、`project2`），則網址為：

`http://localhost:8000/project2/report/index.html`

---

報告頁對「逾時未按鍵」之試次：視為錯誤，RT 以 5000 ms 計；每位完成者仍固定 80 題納入統計（見 `report/ldt-report.js`）。

### 更新 CSV 清單

每新增一批 `data/*.csv` 後：

```bash
python3 scripts/gen-data-manifest.py
```

會覆寫 `report/data-manifest.json`。

---

## 當成獨立 repo 推到 GitHub

1. 在 GitHub 建立**空**的 new repository（不要勾選自動加 README，以免第一次 push 衝突）。
2. 在本機 `project2` 根目錄：

```bash
git init
git add .
git commit -m "Initial commit: LDT data and report"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<repo名稱>.git
git push -u origin main
```

若這個資料夾本來落在一個**已經有 `.git` 的上層 repo** 裡，請二選一：只在上層管理版本（不要把 `project2` 再 `git init`），或改用 [submodule](https://git-scm.com/book/en/v2/Git-Tools-Submodules)／把 `project2` 搬到沒有 `.git` 的路徑再 `git init`。

---

## GitHub Pages（repo 根 = 本專案根）

1. GitHub 該 repo → **Settings** → **Pages**。  
2. **Source**：Deploy from a branch → **main** → **/ (root)** → Save。  
3. 幾分鐘後網址形如：

`https://<你的帳號>.github.io/<repo名稱>/`

（根目錄 `index.html` 會轉到 `report/index.html`；亦可直接開該路徑。）

`report/data-manifest.json` 內的 `../data/...` 與此網址層級相容，**不必改路徑**。

**提醒**：`data/*.csv` 會隨 repo 一併公開；若含可識別受試者資訊，請評估是否改為 private repo 或不要 commit 原始檔。
