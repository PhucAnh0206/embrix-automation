# Hướng dẫn Kiểm thử Tự động hóa Embrix — EmbrixAuto

Tài liệu này cung cấp các hướng dẫn từng bước để thiết lập, định cấu hình và chạy bộ kiểm thử tự động cho nền tảng Embrix O2X sử dụng Playwright + TypeScript.

---

## 1. Điều kiện tiên quyết

Hãy đảm bảo rằng máy tính của bạn đã được cài đặt các công cụ sau:

*   **Node.js** – phiên bản 18 trở lên (khuyến nghị sử dụng bản LTS). Kiểm tra bằng lệnh `node -v`.
*   **Git** – dùng để sao chép (clone) kho lưu trữ mã nguồn nếu bạn chưa có.

---

## 2. Cài đặt

Mở terminal tại thư mục `EmbrixAuto/` của dự án và chạy lệnh:

```bash
npm install
```

> **Ghi chú**
> Lệnh này sẽ cài đặt tất cả các gói npm cần thiết và tự động tải xuống trình duyệt Chromium được sử dụng bởi Playwright (thông qua mã lệnh tự động `postinstall`).

---

## 3. Cấu hình Môi trường

### 3.1. Tệp `.env`

Tạo một bản sao từ tệp mẫu và điền thông tin đăng nhập của bạn:

```powershell
Copy-Item .env.example .env
```

Chỉnh sửa tệp `.env` và điền các giá trị thích hợp:

```bash
# Môi trường chạy test (hiện tại chỉ cung cấp môi trường sandbox)
TEST_ENV=sandbox

# Thông tin tài khoản đăng nhập giao diện UI
EMBRIX_USER=your.user@domain.com
EMBRIX_PASSWORD=your_password_here

# Mã JWT Bearer token để gọi API CRM Gateway
EMBRIX_API_BEARER_TOKEN=your_jwt_bearer_token_here

# Kết nối cơ sở dữ liệu (PostgreSQL qua AWS RDS)
DB_HOST=your-rds-host.us-east-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=coredb
DB_USER=dbuser
DB_PASSWORD=your_db_password

# Tùy chọn: tự động xóa logs cũ mỗi khi bắt đầu chạy test
CLEAN_LOGS_ON_START=false
```

> ⚠️ **Quan trọng**: Tệp `.env` đã được liệt kê trong `.gitignore` – tuyệt đối không commit tệp này lên kho lưu trữ mã nguồn chung.

### 3.2. Thay đổi URL khi chạy (tùy chọn)

Nếu bạn cần chạy bộ kiểm thử trên một môi trường tùy chỉnh khác, hãy ghi đè URL gốc lúc chạy lệnh:

```powershell
$env:EMBRIX_BASE_URL="https://coreui.custom-env.embrix.org"; npm test
```

### 3.3. Các URL mặc định

| Dịch vụ            | URL mặc định                                        |
| ------------------ | --------------------------------------------------- |
| Giao diện CoreUI   | `https://coreui.coopeg.embrix.org`                |
| GraphQL Server     | `https://transactional.coopeg.embrix.org/graphql` |
| API CRM Gateway    | `https://crm-gateway.coopegsbx.embrix.org`        |

---

## 4. Chạy Kiểm thử

### 4.1. Thiết lập Phiên làm việc (Bắt buộc chạy trước khi chạy Hồi quy)

Đăng nhập một lần và lưu lại phiên làm việc đã được xác thực:

```bash
npx playwright test --project=setup
```

### 4.2. Smoke Tests – Kiểm tra sức khỏe nhanh của ứng dụng

```bash
# Chạy ở chế độ ẩn (không hiển thị trình duyệt - nhanh, dùng cho CI)
npx playwright test --project=smoke

# Chạy ở chế độ hiển thị trình duyệt (hữu ích khi cần quan sát thao tác)
npx playwright test --project=smoke --headed
```

### 4.3. Regression Tests – Kiểm thử hồi quy toàn bộ logic nghiệp vụ

```bash
# Chế độ ẩn (Headless)
npx playwright test --project=regression

# Chế độ hiển thị trình duyệt (Headed)
npx playwright test --project=regression --headed
```

### 4.4. Chạy một tệp kiểm thử riêng lẻ

```bash
# Chạy bộ kịch bản TS-01 (regression suite với DB provisioning bypass)
npx playwright test tests/regression/coopeguanacaste/ts-01.spec.ts --project=regression

# Chạy bộ kịch bản legacy (regression suite với normal UI provisioning process)
npx playwright test tests/regression/coopeguanacaste/leagcy.spec.ts --project=regression

# Chạy có hiển thị trình duyệt
npx playwright test tests/regression/coopeguanacaste/ts-01.spec.ts --project=regression --headed
```

> **Quan trọng**
> Khi chạy một tệp cụ thể thuộc bộ regression suite, hãy luôn đi kèm tham số `--project=regression` để Playwright tải đúng cấu hình và tái sử dụng session đăng nhập đã lưu.

### 4.5. Lọc và chạy kiểm thử bằng Tags

Playwright hỗ trợ lọc và chạy các bài kiểm thử thông qua các nhãn gắn sẵn (tags). Bạn có thể định nghĩa tag trong mã nguồn và gọi chúng từ dòng lệnh.

#### Gắn nhãn (Tags) trong mã nguồn

1.  **Gắn trực tiếp vào tiêu đề** (phổ biến nhất): Thêm `@tagname` trực tiếp vào tiêu đề của `test` hoặc `test.describe`.
    ```typescript
    test.describe('REGRESSION: Test Suite - 01 @regression @coopeguanacaste', () => {
      test('TC-01: Residential Account Creation @smoke', async ({ page }) => {
        // ...
      });
    });
    ```

2.  **Sử dụng đối tượng cấu hình** (Playwright 1.42+):
    ```typescript
    test('TC-01: Residential Account Creation', { tag: ['@regression', '@coopeguanacaste'] }, async ({ page }) => {
      // ...
    });
    ```

#### Chạy lọc từ dòng lệnh

Sử dụng tham số `--grep` (hoặc `-g`) và `--grep-invert` để lọc:

*   **Chạy các bài test khớp với tag cụ thể**:
    ```bash
    npx playwright test --grep "@regression"
    ```

*   **Chạy khớp với một trong hai tag (Logic OR)**:
    ```bash
    npx playwright test --grep "@regression|@coopeguanacaste"
    ```

*   **Chạy khớp với cả hai tag bắt buộc (Logic AND)**:
    ```bash
    npx playwright test --grep "(?=.*@regression)(?=.*@coopeguanacaste)"
    ```

*   **Bỏ qua không chạy các bài test có tag cụ thể**:
    ```bash
    npx playwright test --grep-invert "@smoke"
    ```

### 4.6. Gỡ lỗi bằng giao diện tương tác (UI Mode)

Chế độ UI mode cung cấp một màn hình điều khiển tương tác trực quan để bạn có thể đi qua từng bước thao tác:

```bash
npx playwright test --ui
```

### 4.7. Các câu lệnh phím tắt qua npm

| Lệnh npm                    | Mô tả                                                             |
| --------------------------- | ----------------------------------------------------------------- |
| `npm test`                  | Chạy **tất cả** các bài kiểm thử ở chế độ ẩn                      |
| `npm run test:headed`       | Chạy **tất cả** các bài kiểm thử ở chế độ hiển thị trình duyệt    |
| `npm run test:ui`           | Mở bảng điều khiển giao diện UI Mode của Playwright               |
| `npm run test:setup`        | Chỉ thực hiện chạy bước đăng nhập và lưu session                  |
| `npm run test:smoke`        | Chỉ chạy bộ kiểm thử khói (smoke suite)                           |
| `npm run test:regression`   | Chỉ chạy bộ kiểm thử hồi quy (regression suite)                   |
| `npm run report`            | Mở báo cáo kết quả dạng HTML đã được tạo ra                       |

---

## 5. Xem Báo cáo kết quả (HTML Report)

Sau mỗi lượt chạy kiểm thử, Playwright sẽ tự động tạo ra một báo cáo HTML. Nếu báo cáo không tự động hiển thị, bạn có thể mở nó bằng lệnh:

```bash
npx playwright show-report
```

Tệp báo cáo này bao gồm:
*   ✅ Trạng thái Pass/Fail của từng ca kiểm thử.
*   ⏱️ Thời gian thực thi của từng bước kiểm thử.
*   📎 Tệp ghi log chi tiết đi kèm (được tạo bởi `TestLogger`).
*   📸 Hình ảnh chụp màn hình tại các điểm xảy ra lỗi (nếu có).
*   🎥 Video ghi lại quá trình thao tác bị lỗi (nếu có).
*   🔍 Trình xem vết (Trace viewer) để phân tích chi tiết các ca chạy thử lại.

---

## 6. Tổng quan cấu trúc thư mục

| Thư mục/Tệp           | Mục đích sử dụng                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `tests/`              | Chứa tất cả các tệp kịch bản kiểm thử (`*.spec.ts`), chia theo thư mục smoke, regression     |
| `pages/`              | Mô hình Page Object Model — mỗi tệp đại diện cho một màn hình hoặc phần giao diện           |
| `pages/components/`   | Các component giao diện tái sử dụng như Toast, ReactSelect, Table, Sidebar                 |
| `helpers/db/`         | Trình tương tác DB nghiệp vụ, thực hiện gọi và dọn dẹp dữ liệu kiểm thử qua SQL             |
| `fixtures/`           | Chứa tệp đăng ký fixtures tập trung `page-factory.ts` giúp tự động tiêm đối tượng vào test   |
| `helpers/`            | Các mô-đun tiện ích: gọi API, ghi log có cấu trúc, quản lý thời gian chờ (timeouts)         |
| `test-data/`          | Chứa dữ liệu đầu vào dạng JSON cung cấp tham số cho các kịch bản kiểm thử                  |
| `playwright/`         | Dữ liệu nội bộ của Playwright: lưu cookie session đăng nhập và tệp test-context chia sẻ     |
| `docs/`               | Tài liệu hướng dẫn dự án (hướng dẫn này, kiến trúc thư mục, quy ước đặt tên, v.v.)          |

> Để tìm hiểu chi tiết về sơ đồ cấu trúc của từng tệp tin, xem thêm **[PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)**.

---

## 7. Các bộ kiểm thử hiện có

### 7.1. Bộ kiểm thử khói (Smoke Tests) (`tests/smoke/`)

| Mã kiểm thử | Mô tả nghiệp vụ kiểm tra                                 |
| ----------- | -------------------------------------------------------- |
| SMOKE‑01    | Xác nhận trang đăng nhập hiển thị đầy đủ các trường nhập |
| SMOKE‑02    | Đăng nhập thành công với thông tin tài khoản hợp lệ      |
| SMOKE‑03    | Hiển thị đúng thông báo lỗi khi tài khoản không hợp lệ  |
| SMOKE‑04    | Tiêu đề trang được tải thông tin (kiểm tra SEO cơ bản)   |

### 7.2. Bộ kiểm thử hồi quy (Regression Tests) (`tests/regression/coopeguanacaste/`)

**TS‑01** – Chuỗi quy trình khép kín Order‑to‑Cash (Từ Đơn hàng đến Thanh toán):

| Mã kiểm thử | Mô tả nghiệp vụ kiểm tra                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TC‑00       | Thiết lập thời gian hệ thống (CCP Time) qua GraphQL API sử dụng một ngày ngẫu nhiên trong tương lai                               |
| TC‑01       | Tạo tài khoản cư dân qua API và xác minh tài khoản hiển thị chính xác trên giao diện UI                                            |
| TC‑02       | Đọc hóa đơn lắp đặt ban đầu, đối soát số tiền, thanh toán qua API và xác nhận trạng thái hóa đơn chuyển thành **CLOSED** trên UI   |
| TC‑03       | Tạo yêu cầu cấp dịch vụ qua wizard UI, đợi hệ thống đồng bộ cấp phép và xác nhận trạng thái dịch vụ đạt **FINALIZADO**             |
| TC‑04       | Chu kỳ cước Grace Period – chạy job schedule nghiệp vụ, xử lý tất cả công việc và đợi cho đến khi hoàn thành                       |
| TC‑05       | Chu kỳ cước định kỳ tháng thứ nhất (Recurring Billing Month 01) – xác minh việc xử lý billing jobs và tạo hóa đơn định kỳ          |
| TC‑06       | Chu kỳ cước định kỳ tháng thứ hai (Recurring Billing Month 02) – xác minh hóa đơn định kỳ cho tháng tiếp theo được tạo lập         |
| TC‑07       | Gửi thông báo nhắc nợ kỳ cước tháng thứ hai (Collection Notification Month 02) – (đang phát triển)                                 |

---

## 8. Quy ước lập trình & Thực hành tốt nhất

### 8.1. Đặt tên File & Folder
*   **Luôn sử dụng kiểu `kebab-case`** (chữ thường ngăn cách bởi dấu gạch ngang) cho tất cả thư mục và tệp tin.
*   Ví dụ: `customer-management.page.ts`, `account-order-api.helper.ts`.
*   **Lý do**: Tránh các lỗi không khớp đường dẫn do phân biệt chữ hoa/thường khi chuyển đổi mã nguồn từ môi trường Windows (không phân biệt) lên môi trường chạy CI chạy Linux (có phân biệt).

### 8.2. Chạy kiểm thử chuỗi tuần tự (Serial Test Pattern)
Khi các bài kiểm thử phụ thuộc trạng thái vào nhau, sử dụng `test.describe.serial()` và một đối tượng `state` chung ở đầu suite:

```typescript
interface SuiteState {
  accountId: string;
  orderId: string;
}
const state: Partial<SuiteState> = {};

test.describe.serial('Chuỗi nghiệp vụ Order-to-Cash', () => {
  test('TC‑01', async ({ fixture }) => {
    state.accountId = 'AC‑123'; // ghi dữ liệu
  });
  test('TC‑02', async ({ fixture }) => {
    console.log(state.accountId); // đọc dữ liệu
  });
});
```

### 8.3. Thao tác Đọc bảng tốc độ cao (Table Performance)
*   **Không** duyệt qua từng dòng và dùng `await cell.innerText()` – việc này sẽ sinh ra hàng chục kết nối CDP làm chậm quá trình chạy test.
*   **Thay vào đó**, hãy lấy toàn bộ nội dung văn bản của cột cùng lúc bằng `allTextContents()` và thực hiện tìm kiếm trên bộ nhớ cục bộ (in-memory):

```typescript
// Tốc độ cao – chỉ mất 1 kết nối CDP duy nhất
const cellTexts = await rows.locator('td:nth-child(2)').allTextContents();
const rowIndex = cellTexts.findIndex(t => t.trim() === targetValue);
```

### 8.4. Thứ tự ưu tiên của Bộ định vị (Locator Priority)
Hãy ưu tiên sử dụng các bộ định vị theo thứ tự sau để tránh việc kiểm thử bị lỗi khi thay đổi giao diện nhỏ:
1.  Định vị theo vai trò Accessible (`page.getByRole`) đi kèm thuộc tính tên trực quan.
2.  Định vị theo nhãn text (`page.getByLabel`).
3.  Định vị theo mã test (`page.getByTestId`).
4.  Định vị XPath chỉ khi cần thiết cho các cấu trúc phân cấp phức tạp.
5.  Tránh phụ thuộc vào tên class CSS thô – chúng rất dễ bị thay đổi khi nâng cấp UI.

---

## 9. GitLab CI/CD Pipeline

Dự án tích hợp sẵn cấu hình GitLab CI để chạy kiểm thử tự động trên Docker image chính thức của Playwright (`mcr.microsoft.com/playwright:v1.49.0-jammy`).

```text
Quy trình pipeline: setup → smoke → regression → e2e
```

| Giai đoạn CI | Khi nào chạy                             | Mô tả công việc                                  |
| ------------ | ---------------------------------------- | ------------------------------------------------ |
| `setup`      | Luôn luôn chạy                           | Đăng nhập hệ thống và lưu session cookie         |
| `smoke`      | Luôn luôn chạy                           | Kiểm tra sức khỏe nhanh của hệ thống             |
| `regression` | Khi có Merge Request hoặc đẩy lên `develop` | Chạy toàn bộ bộ kiểm thử hồi quy đầy đủ         |
| `e2e`        | Khi đẩy mã nguồn lên `main` hoặc `release` | Thực hiện các kịch bản E2E kiểm duyệt cuối cùng  |

Các biến môi trường cần thiết cấu hình trên GitLab (cài đặt tại mục *Settings → CI/CD → Variables*):
*   `QA_BASE_URL` – URL của môi trường kiểm thử mục tiêu.
*   `QA_EMBRIX_USER` – Tài khoản đăng nhập UI tự động.
*   `QA_EMBRIX_PASSWORD` – Mật khẩu đăng nhập UI tự động.
*   `QA_DB_HOST`, `QA_DB_USER`, `QA_DB_PASSWORD` – Thông tin kết nối CSDL PostgreSQL kiểm thử.

Các biến này sẽ tự động được ghi đè vào tệp `.env` lúc chạy pipeline.

---

*Tài liệu được cập nhật lần cuối: 13-06-2026 | Phiên bản 4.2 | Dự án: EmbrixAuto*
